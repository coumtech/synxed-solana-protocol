//! Settle instruction processor.

use crate::instruction::SettlementInstruction;
use crate::split::split_three;
use crate::state::{
    settlement_pda, SETTLEMENT_RECORD_DISCRIMINATOR, SETTLEMENT_RECORD_SIZE, SETTLEMENT_SEED,
};
use solana_program::account_info::{next_account_info, AccountInfo};
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
        } => process_settle(
            program_id, accounts, event_id, amount, artist_bps, studio_bps, synxed_bps,
        ),
    }
}

fn process_settle(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    event_id: [u8; 32],
    amount: u64,
    artist_bps: u16,
    studio_bps: u16,
    synxed_bps: u16,
) -> ProgramResult {
    let acc_iter = &mut accounts.iter();
    let payer = next_account_info(acc_iter)?;
    let artist = next_account_info(acc_iter)?;
    let studio = next_account_info(acc_iter)?;
    let synxed = next_account_info(acc_iter)?;
    let record = next_account_info(acc_iter)?;
    let system_program = next_account_info(acc_iter)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer.is_writable || !artist.is_writable || !studio.is_writable || !synxed.is_writable {
        return Err(ProgramError::InvalidAccountData);
    }
    // Defense-in-depth: the system_instruction builders hard-code the real
    // system program id, but reject a wrong account explicitly and early.
    if *system_program.key != solana_program::system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let parts = split_three(amount, artist_bps, studio_bps, synxed_bps)
        .map_err(|_| ProgramError::InvalidArgument)?;
    let [artist_amt, studio_amt, synxed_amt] = parts;

    let (pda, bump) = settlement_pda(program_id, &event_id);
    if record.key != &pda {
        return Err(ProgramError::InvalidSeeds);
    }
    if !record.is_writable {
        return Err(ProgramError::InvalidAccountData);
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

    transfer(payer, artist, artist_amt, system_program)?;
    transfer(payer, studio, studio_amt, system_program)?;
    transfer(payer, synxed, synxed_amt, system_program)?;
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
