//! On-chain instruction codec (enabled with `--features onchain`).

use crate::split::MAX_SHARES;
use solana_program::program_error::ProgramError;

pub const SETTLE_TAG: u8 = 0;
pub const SETTLE_N_TAG: u8 = 1;

/// `SettleN` payload before the bps list: event_id + amount + share count.
const SETTLE_N_HEADER_LEN: usize = 32 + 8 + 1;

#[derive(Debug, PartialEq, Eq)]
pub enum SettlementInstruction {
    /// Settle a 3-way split from the payer to artist, studio, and SYNXED.
    ///
    /// Accounts: payer (signer, writable), artist, studio, synxed (writable),
    /// settlement record PDA (writable), system program.
    Settle {
        event_id: [u8; 32],
        amount: u64,
        artist_bps: u16,
        studio_bps: u16,
        synxed_bps: u16,
    },
    /// Settle an N-way split (1..=`MAX_SHARES` shares).
    ///
    /// Accounts: payer (signer, writable), one writable recipient per share
    /// in `bps` order, settlement record PDA (writable), system program.
    SettleN {
        event_id: [u8; 32],
        amount: u64,
        bps: Vec<u16>,
    },
}

impl SettlementInstruction {
    pub fn pack(&self) -> Vec<u8> {
        match self {
            SettlementInstruction::Settle {
                event_id,
                amount,
                artist_bps,
                studio_bps,
                synxed_bps,
            } => {
                let mut out = Vec::with_capacity(1 + 32 + 8 + 6);
                out.push(SETTLE_TAG);
                out.extend_from_slice(event_id);
                out.extend_from_slice(&amount.to_le_bytes());
                out.extend_from_slice(&artist_bps.to_le_bytes());
                out.extend_from_slice(&studio_bps.to_le_bytes());
                out.extend_from_slice(&synxed_bps.to_le_bytes());
                out
            }
            SettlementInstruction::SettleN {
                event_id,
                amount,
                bps,
            } => {
                let mut out = Vec::with_capacity(1 + SETTLE_N_HEADER_LEN + 2 * bps.len());
                out.push(SETTLE_N_TAG);
                out.extend_from_slice(event_id);
                out.extend_from_slice(&amount.to_le_bytes());
                out.push(bps.len() as u8);
                for share in bps {
                    out.extend_from_slice(&share.to_le_bytes());
                }
                out
            }
        }
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        let (tag, rest) = data
            .split_first()
            .ok_or(ProgramError::InvalidInstructionData)?;
        match tag {
            &SETTLE_TAG => {
                if rest.len() != 32 + 8 + 6 {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let event_id = read_event_id(rest);
                let amount = read_u64(&rest[32..40])?;
                Ok(SettlementInstruction::Settle {
                    event_id,
                    amount,
                    artist_bps: read_u16(&rest[40..42])?,
                    studio_bps: read_u16(&rest[42..44])?,
                    synxed_bps: read_u16(&rest[44..46])?,
                })
            }
            &SETTLE_N_TAG => {
                if rest.len() < SETTLE_N_HEADER_LEN {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let count = usize::from(rest[40]);
                if count == 0 || count > MAX_SHARES || rest.len() != SETTLE_N_HEADER_LEN + 2 * count
                {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let event_id = read_event_id(rest);
                let amount = read_u64(&rest[32..40])?;
                let mut bps = Vec::with_capacity(count);
                for i in 0..count {
                    let start = SETTLE_N_HEADER_LEN + 2 * i;
                    bps.push(read_u16(&rest[start..start + 2])?);
                }
                Ok(SettlementInstruction::SettleN {
                    event_id,
                    amount,
                    bps,
                })
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

fn read_event_id(rest: &[u8]) -> [u8; 32] {
    let mut event_id = [0u8; 32];
    event_id.copy_from_slice(&rest[0..32]);
    event_id
}

fn read_u64(bytes: &[u8]) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ))
}

fn read_u16(bytes: &[u8]) -> Result<u16, ProgramError> {
    Ok(u16::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed() -> [u8; 32] {
        let mut event_id = [0u8; 32];
        for (i, byte) in event_id.iter_mut().enumerate() {
            *byte = i as u8;
        }
        event_id
    }

    fn sample() -> SettlementInstruction {
        SettlementInstruction::Settle {
            event_id: seed(),
            amount: 20_000,
            artist_bps: 3_500,
            studio_bps: 4_000,
            synxed_bps: 2_500,
        }
    }

    fn sample_n() -> SettlementInstruction {
        SettlementInstruction::SettleN {
            event_id: seed(),
            amount: 20_000,
            bps: vec![3_500, 3_500, 2_000, 1_000],
        }
    }

    /// Golden bytes shared with the TypeScript codec test
    /// (`tests/instruction.test.ts`). If this vector changes, both sides
    /// must change together.
    #[test]
    fn pack_matches_shared_golden_bytes() {
        let mut expected = vec![SETTLE_TAG];
        expected.extend((0u8..32).collect::<Vec<u8>>());
        expected.extend([0x20, 0x4e, 0, 0, 0, 0, 0, 0]); // 20000 u64 LE
        expected.extend([0xac, 0x0d]); // 3500 u16 LE
        expected.extend([0xa0, 0x0f]); // 4000 u16 LE
        expected.extend([0xc4, 0x09]); // 2500 u16 LE
        assert_eq!(sample().pack(), expected);
        assert_eq!(expected.len(), 47);
    }

    /// Golden bytes for `SettleN`, also pinned in `tests/instruction-n.test.ts`.
    #[test]
    fn pack_n_matches_shared_golden_bytes() {
        let mut expected = vec![SETTLE_N_TAG];
        expected.extend((0u8..32).collect::<Vec<u8>>());
        expected.extend([0x20, 0x4e, 0, 0, 0, 0, 0, 0]); // 20000 u64 LE
        expected.push(4); // share count
        expected.extend([0xac, 0x0d]); // 3500
        expected.extend([0xac, 0x0d]); // 3500
        expected.extend([0xd0, 0x07]); // 2000
        expected.extend([0xe8, 0x03]); // 1000
        assert_eq!(sample_n().pack(), expected);
        assert_eq!(expected.len(), 50);
    }

    #[test]
    fn unpack_round_trips_pack() {
        assert_eq!(
            SettlementInstruction::unpack(&sample().pack()).unwrap(),
            sample()
        );
        assert_eq!(
            SettlementInstruction::unpack(&sample_n().pack()).unwrap(),
            sample_n()
        );
    }

    #[test]
    fn unpack_rejects_bad_input() {
        let packed = sample().pack();
        // Empty, unknown tag, truncated, and trailing-byte payloads.
        assert!(SettlementInstruction::unpack(&[]).is_err());
        assert!(SettlementInstruction::unpack(&[7]).is_err());
        assert!(SettlementInstruction::unpack(&packed[..packed.len() - 1]).is_err());
        let mut extended = packed.clone();
        extended.push(0);
        assert!(SettlementInstruction::unpack(&extended).is_err());
    }

    #[test]
    fn unpack_n_rejects_bad_share_counts_and_lengths() {
        let packed = sample_n().pack();
        // Truncated bps list and trailing byte.
        assert!(SettlementInstruction::unpack(&packed[..packed.len() - 1]).is_err());
        let mut extended = packed.clone();
        extended.push(0);
        assert!(SettlementInstruction::unpack(&extended).is_err());
        // Zero shares.
        let zero = SettlementInstruction::SettleN {
            event_id: seed(),
            amount: 1,
            bps: vec![],
        }
        .pack();
        assert!(SettlementInstruction::unpack(&zero).is_err());
        // One more than the maximum.
        let too_many = SettlementInstruction::SettleN {
            event_id: seed(),
            amount: 1,
            bps: vec![1_000; MAX_SHARES + 1],
        }
        .pack();
        assert!(SettlementInstruction::unpack(&too_many).is_err());
        // Count byte lies about the list length.
        let mut lying = packed.clone();
        lying[41] = 3;
        assert!(SettlementInstruction::unpack(&lying).is_err());
    }
}
