//! Settlement instruction processor.

use crate::instruction::SettlementInstruction;
use crate::split::{split_shares, MAX_SHARES};
use crate::state::{
    namespace_authority, namespace_pda, settlement_pda, write_namespace,
    NAMESPACE_AUTHORITY_OFFSET, NAMESPACE_SEED, NAMESPACE_SIZE, SETTLEMENT_RECORD_DISCRIMINATOR,
    SETTLEMENT_RECORD_SIZE, SETTLEMENT_SEED,
};
use solana_program::account_info::AccountInfo;
use solana_program::entrypoint::ProgramResult;
use solana_program::program::{invoke, invoke_signed};
use solana_program::program_error::ProgramError;
use solana_program::program_pack::Pack;
use solana_program::pubkey::Pubkey;
use solana_program::rent::Rent;
use solana_program::system_instruction;
use solana_program::sysvar::Sysvar;
use spl_token::state::{Account as TokenAccount, Mint};

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match SettlementInstruction::unpack(data)? {
        SettlementInstruction::CreateNamespace {
            namespace_id,
            authority,
        } => create_namespace(program_id, accounts, &namespace_id, &authority),
        SettlementInstruction::SetNamespaceAuthority { new_authority } => {
            set_namespace_authority(program_id, accounts, &new_authority)
        }
        SettlementInstruction::SettleN {
            event_id,
            amount,
            bps,
        } => {
            let count = bps.len();
            if count == 0 || count > MAX_SHARES {
                return Err(ProgramError::InvalidInstructionData);
            }
            let mut payouts = [0u64; MAX_SHARES];
            split_shares(amount, &bps, &mut payouts[..count])
                .map_err(|_| ProgramError::InvalidArgument)?;
            settle(program_id, accounts, event_id, amount, &payouts[..count])
        }
        SettlementInstruction::SettleTokenN {
            event_id,
            amount,
            decimals,
            bps,
        } => {
            let count = bps.len();
            if count == 0 || count > MAX_SHARES {
                return Err(ProgramError::InvalidInstructionData);
            }
            let mut payouts = [0u64; MAX_SHARES];
            split_shares(amount, &bps, &mut payouts[..count])
                .map_err(|_| ProgramError::InvalidArgument)?;
            settle_token(
                program_id,
                accounts,
                event_id,
                amount,
                decimals,
                &payouts[..count],
            )
        }
    }
}

/// Open the namespace `creator` controls under `namespace_id`.
///
/// `accounts` must be exactly: payer, creator, namespace PDA, system program.
fn create_namespace(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    namespace_id: &[u8; 32],
    authority: &Pubkey,
) -> ProgramResult {
    let [payer, creator, namespace, system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !creator.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    // The all-zero key is the system program's id; nobody can sign for it, so
    // a namespace with it as authority could never settle or rotate.
    if *authority == Pubkey::default() {
        return Err(ProgramError::InvalidArgument);
    }
    let (pda, bump) = namespace_pda(program_id, creator.key, namespace_id);
    if namespace.key != &pda {
        return Err(ProgramError::InvalidSeeds);
    }
    let seeds: &[&[u8]] = &[NAMESPACE_SEED, creator.key.as_ref(), namespace_id, &[bump]];
    create_program_account(
        program_id,
        payer,
        namespace,
        system_program,
        seeds,
        NAMESPACE_SIZE,
    )?;
    let mut data = namespace.try_borrow_mut_data()?;
    write_namespace(&mut data, bump, creator.key, namespace_id, authority)
}

/// Replace a namespace's authority. The current and the new authority both
/// sign, so a rotation can never hand the namespace to a key nobody can sign
/// for, which would lock it for good.
///
/// `accounts` must be exactly: current authority, namespace, new authority.
fn set_namespace_authority(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_authority: &Pubkey,
) -> ProgramResult {
    let [authority, namespace, new_authority_account] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !namespace.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    authorize(program_id, authority, namespace)?;
    if *new_authority == Pubkey::default() || new_authority_account.key != new_authority {
        return Err(ProgramError::InvalidArgument);
    }
    if !new_authority_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let mut data = namespace.try_borrow_mut_data()?;
    data[NAMESPACE_AUTHORITY_OFFSET..NAMESPACE_SIZE].copy_from_slice(new_authority.as_ref());
    Ok(())
}

/// Check that `namespace` is a namespace of this program and that
/// `authority` is its current authority and signed.
fn authorize(
    program_id: &Pubkey,
    authority: &AccountInfo,
    namespace: &AccountInfo,
) -> ProgramResult {
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if namespace.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let current = namespace_authority(&namespace.try_borrow_data()?)?;
    if current != *authority.key {
        return Err(ProgramError::IncorrectAuthority);
    }
    Ok(())
}

/// Native settlement.
///
/// `accounts` must be exactly: payer, namespace authority, namespace, one
/// recipient per payout (in order), the settlement record PDA, the system
/// program.
fn settle(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    event_id: [u8; 32],
    amount: u64,
    payouts: &[u64],
) -> ProgramResult {
    let count = payouts.len();
    if accounts.len() != count + 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let payer = &accounts[0];
    let authority = &accounts[1];
    let namespace = &accounts[2];
    let recipients = &accounts[3..3 + count];
    let record = &accounts[3 + count];
    let system_program = &accounts[4 + count];

    authorize(program_id, authority, namespace)?;
    if recipients.iter().any(|recipient| !recipient.is_writable) {
        return Err(ProgramError::InvalidAccountData);
    }
    // A payout sent to this event's record, or to any account this program
    // already owns (another record, or a namespace), could never be recovered:
    // nothing can debit a program-owned account here.
    if recipients
        .iter()
        .any(|recipient| recipient.key == record.key || recipient.owner == program_id)
    {
        return Err(ProgramError::InvalidArgument);
    }
    create_record(
        program_id,
        payer,
        namespace.key,
        record,
        system_program,
        &event_id,
        amount,
    )?;

    for (recipient, &lamports) in recipients.iter().zip(payouts) {
        transfer(payer, recipient, lamports, system_program)?;
    }
    Ok(())
}

/// Classic SPL Token settlement via TransferChecked. Token-2022 is rejected
/// explicitly because extensions can change credited amounts and accounts.
///
/// `accounts` must be exactly: payer (source owner), namespace authority,
/// namespace, source, one destination per payout, mint, settlement record
/// PDA, system program, token program.
fn settle_token(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    event_id: [u8; 32],
    amount: u64,
    decimals: u8,
    payouts: &[u64],
) -> ProgramResult {
    let count = payouts.len();
    if accounts.len() != count + 8 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let payer = &accounts[0];
    let authority = &accounts[1];
    let namespace = &accounts[2];
    let source = &accounts[3];
    let recipients = &accounts[4..4 + count];
    let mint = &accounts[4 + count];
    let record = &accounts[5 + count];
    let system_program = &accounts[6 + count];
    let token_program = &accounts[7 + count];

    if *token_program.key != spl_token::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    authorize(program_id, authority, namespace)?;
    if !source.is_writable || recipients.iter().any(|recipient| !recipient.is_writable) {
        return Err(ProgramError::InvalidAccountData);
    }
    if source.owner != token_program.key
        || mint.owner != token_program.key
        || recipients
            .iter()
            .any(|recipient| recipient.owner != token_program.key)
    {
        return Err(ProgramError::IllegalOwner);
    }
    let mint_state = Mint::unpack(&mint.try_borrow_data()?)?;
    if !mint_state.is_initialized || mint_state.decimals != decimals {
        return Err(ProgramError::InvalidAccountData);
    }
    let source_state = TokenAccount::unpack(&source.try_borrow_data()?)?;
    if source_state.mint != *mint.key || source_state.owner != *payer.key {
        return Err(ProgramError::InvalidAccountData);
    }
    for recipient in recipients {
        if recipient.key == source.key || recipient.key == record.key {
            return Err(ProgramError::InvalidArgument);
        }
        let recipient_state = TokenAccount::unpack(&recipient.try_borrow_data()?)?;
        if recipient_state.mint != *mint.key {
            return Err(ProgramError::InvalidAccountData);
        }
    }

    create_record(
        program_id,
        payer,
        namespace.key,
        record,
        system_program,
        &event_id,
        amount,
    )?;
    for (recipient, &tokens) in recipients.iter().zip(payouts) {
        if tokens == 0 {
            continue;
        }
        let instruction = spl_token::instruction::transfer_checked(
            token_program.key,
            source.key,
            mint.key,
            recipient.key,
            payer.key,
            &[],
            tokens,
            decimals,
        )?;
        invoke(
            &instruction,
            &[
                source.clone(),
                mint.clone(),
                recipient.clone(),
                payer.clone(),
                token_program.clone(),
            ],
        )?;
    }
    Ok(())
}

/// Create the record that marks `event_id` as settled in `namespace`.
fn create_record<'a>(
    program_id: &Pubkey,
    payer: &AccountInfo<'a>,
    namespace: &Pubkey,
    record: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    event_id: &[u8; 32],
    amount: u64,
) -> ProgramResult {
    let (pda, bump) = settlement_pda(program_id, namespace, event_id);
    if record.key != &pda {
        return Err(ProgramError::InvalidSeeds);
    }
    let seeds: &[&[u8]] = &[SETTLEMENT_SEED, namespace.as_ref(), event_id, &[bump]];
    create_program_account(
        program_id,
        payer,
        record,
        system_program,
        seeds,
        SETTLEMENT_RECORD_SIZE,
    )?;
    let mut data = record.try_borrow_mut_data()?;
    data[0] = SETTLEMENT_RECORD_DISCRIMINATOR;
    data[1..33].copy_from_slice(event_id);
    data[33..41].copy_from_slice(&amount.to_le_bytes());
    Ok(())
}

/// Turn the PDA `account` (signed for by `seeds`) into a rent-exempt,
/// program-owned account of `size` bytes, funded by `payer`.
fn create_program_account<'a>(
    program_id: &Pubkey,
    payer: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    seeds: &[&[u8]],
    size: usize,
) -> ProgramResult {
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_writable || !account.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    if *system_program.key != solana_program::system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    // Idempotency is keyed on ownership, not lamports: an account this program
    // already owns (or that carries data) means it was created before.
    if account.owner == program_id || !account.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    // Only a system-owned, data-less account can be turned into one of ours.
    // Anything else at this address was not produced by this program.
    if *account.owner != solana_program::system_program::ID {
        return Err(ProgramError::InvalidAccountData);
    }

    // Transfer + allocate + assign rather than create_account: create_account
    // fails if the address already holds lamports, which would let anyone
    // block an address by pre-funding it. This path tolerates pre-funded
    // accounts: the payer only tops up whatever is missing toward rent
    // exemption.
    let required = Rent::get()?.minimum_balance(size);
    let shortfall = required.saturating_sub(account.lamports());
    if shortfall > 0 {
        invoke(
            &system_instruction::transfer(payer.key, account.key, shortfall),
            &[payer.clone(), account.clone(), system_program.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(account.key, size as u64),
        &[account.clone(), system_program.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(account.key, program_id),
        &[account.clone(), system_program.clone()],
        &[seeds],
    )?;
    Ok(())
}

fn transfer<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    lamports: u64,
    system_program: &AccountInfo<'a>,
) -> ProgramResult {
    if lamports == 0 {
        return Ok(());
    }
    invoke(
        &system_instruction::transfer(from.key, to.key, lamports),
        &[from.clone(), to.clone(), system_program.clone()],
    )
}
