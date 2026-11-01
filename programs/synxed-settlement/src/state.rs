//! Program-owned accounts: settlement namespaces and settlement records.
//!
//! A namespace belongs to one integrator. Its current authority is the only
//! key that can settle in it, and every settlement record is derived from the
//! namespace's address and the event id, so nobody outside the namespace can
//! create, and so block, one of its records.

use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

pub const SETTLEMENT_SEED: &[u8] = b"settlement";
pub const NAMESPACE_SEED: &[u8] = b"namespace";

/// Settlement record layout: 1-byte discriminator + 32-byte event id + 8-byte
/// amount. Its address, derived from the namespace and the event id, binds it
/// to the namespace.
pub const SETTLEMENT_RECORD_SIZE: usize = 1 + 32 + 8;
pub const SETTLEMENT_RECORD_DISCRIMINATOR: u8 = 1;

/// Namespace layout: 1-byte discriminator, 1-byte bump, 32-byte creator,
/// 32-byte namespace id, 32-byte current authority.
pub const NAMESPACE_SIZE: usize = 1 + 1 + 32 + 32 + 32;
pub const NAMESPACE_DISCRIMINATOR: u8 = 2;
pub const NAMESPACE_AUTHORITY_OFFSET: usize = 66;

/// Address of the record that marks `event_id` as settled in `namespace`.
pub fn settlement_pda(
    program_id: &Pubkey,
    namespace: &Pubkey,
    event_id: &[u8; 32],
) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SETTLEMENT_SEED, namespace.as_ref(), event_id], program_id)
}

/// Address of the namespace `creator` opened under `namespace_id`. The
/// creator is part of the address, so nobody else can open it first, and it
/// stays fixed when the authority is rotated.
pub fn namespace_pda(
    program_id: &Pubkey,
    creator: &Pubkey,
    namespace_id: &[u8; 32],
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[NAMESPACE_SEED, creator.as_ref(), namespace_id],
        program_id,
    )
}

/// Serialize a new namespace account.
pub fn write_namespace(
    data: &mut [u8],
    bump: u8,
    creator: &Pubkey,
    namespace_id: &[u8; 32],
    authority: &Pubkey,
) -> Result<(), ProgramError> {
    if data.len() != NAMESPACE_SIZE {
        return Err(ProgramError::InvalidAccountData);
    }
    data[0] = NAMESPACE_DISCRIMINATOR;
    data[1] = bump;
    data[2..34].copy_from_slice(creator.as_ref());
    data[34..66].copy_from_slice(namespace_id);
    data[NAMESPACE_AUTHORITY_OFFSET..NAMESPACE_SIZE].copy_from_slice(authority.as_ref());
    Ok(())
}

/// The current authority stored in a namespace account's data. Callers must
/// already have checked that the account is owned by this program.
pub fn namespace_authority(data: &[u8]) -> Result<Pubkey, ProgramError> {
    if data.len() != NAMESPACE_SIZE || data[0] != NAMESPACE_DISCRIMINATOR {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut authority = [0u8; 32];
    authority.copy_from_slice(&data[NAMESPACE_AUTHORITY_OFFSET..NAMESPACE_SIZE]);
    Ok(Pubkey::new_from_array(authority))
}
