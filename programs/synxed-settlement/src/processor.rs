//! Settlement instruction processor.

use crate::instruction::SettlementInstruction;
use crate::split::{split_shares, MAX_SHARES, SHARE_COUNT};
use crate::state::{
    settlement_pda, SETTLEMENT_RECORD_DISCRIMINATOR, SETTLEMENT_RECORD_SIZE, SETTLEMENT_SEED,
};
use solana_program::account_info::AccountInfo;
use solana_program::entrypoint::ProgramResult;
use solana_program::program::{invoke, invoke_signed};
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;
use solana_program::rent::Rent;
use solana_program::system_instruction;
use solana_program::sysvar::Sysvar;

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match SettlementInstruction::unpack(data)? {
        SettlementInstruction::Settle {
            event_id,
            amount,
            artist_bps,
            studio_bps,
            synxed_bps,
        } => {
            let mut payouts = [0u64; SHARE_COUNT];
            split_shares(amount, &[artist_bps, studio_bps, synxed_bps], &mut payouts)
                .map_err(|_| ProgramError::InvalidArgument)?;
            settle(program_id, accounts, event_id, amount, &payouts)
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
    }
}

/// Shared settlement path for both instructions.
///
/// `accounts` must be exactly: payer, one recipient per payout (in order),
/// the settlement record PDA, the system program.
fn settle(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    event_id: [u8; 32],
    amount: u64,
    payouts: &[u64],
) -> ProgramResult {
    let count = payouts.len();
    if accounts.len() != count + 3 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let payer = &accounts[0];
    let recipients = &accounts[1..1 + count];
    let record = &accounts[1 + count];
    let system_program = &accounts[2 + count];

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_writable || !record.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    if recipients.iter().any(|recipient| !recipient.is_writable) {
        return Err(ProgramError::InvalidAccountData);
    }
    // Defense-in-depth: the system_instruction builders hard-code the real
    // system program id, but reject a wrong account explicitly and early.
    if *system_program.key != solana_program::system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let (pda, bump) = settlement_pda(program_id, &event_id);
    if record.key != &pda {
        return Err(ProgramError::InvalidSeeds);
    }
    // A payout sent to a settlement record — this event's or any other
    // event's — could never be recovered: nothing can debit a record once it
    // is program-owned.
    if recipients
        .iter()
        .any(|recipient| recipient.key == record.key || recipient.owner == program_id)
    {
        return Err(ProgramError::InvalidArgument);
    }
    // Idempotency is keyed on ownership, not lamports: a record this program
    // already owns (or that carries data) means the event was settled.
    if record.owner == program_id || !record.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    // Only a system-owned, data-less account can be turned into a record.
    // Anything else at this address was not produced by this program.
    if *record.owner != solana_program::system_program::ID {
        return Err(ProgramError::InvalidAccountData);
    }

    // Create the record as transfer + allocate + assign rather than
    // create_account. create_account fails if the address already holds
    // lamports, which let anyone block an event id by pre-funding its PDA.
    // This path tolerates pre-funded accounts: the payer only tops up
    // whatever is missing toward rent exemption.
    let seeds: &[&[u8]] = &[SETTLEMENT_SEED, &event_id, &[bump]];
    let required = Rent::get()?.minimum_balance(SETTLEMENT_RECORD_SIZE);
    let shortfall = required.saturating_sub(record.lamports());
    if shortfall > 0 {
        invoke(
            &system_instruction::transfer(payer.key, record.key, shortfall),
            &[payer.clone(), record.clone(), system_program.clone()],
        )?;
    }
    invoke_signed(
        &system_instruction::allocate(record.key, SETTLEMENT_RECORD_SIZE as u64),
        &[record.clone(), system_program.clone()],
        &[seeds],
    )?;
    invoke_signed(
        &system_instruction::assign(record.key, program_id),
        &[record.clone(), system_program.clone()],
        &[seeds],
    )?;

    {
        let mut data = record.try_borrow_mut_data()?;
        data[0] = SETTLEMENT_RECORD_DISCRIMINATOR;
        data[1..33].copy_from_slice(&event_id);
        data[33..41].copy_from_slice(&amount.to_le_bytes());
    }

    for (recipient, &lamports) in recipients.iter().zip(payouts) {
        transfer(payer, recipient, lamports, system_program)?;
    }
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
