//! PDA record marking an `event_id` as already settled.

use solana_program::pubkey::Pubkey;

pub const SETTLEMENT_SEED: &[u8] = b"settlement";

/// Account layout: 1-byte discriminator + 32-byte event_id + 8-byte amount.
pub const SETTLEMENT_RECORD_SIZE: usize = 1 + 32 + 8;
pub const SETTLEMENT_RECORD_DISCRIMINATOR: u8 = 1;

pub fn settlement_pda(program_id: &Pubkey, event_id: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SETTLEMENT_SEED, event_id], program_id)
}
