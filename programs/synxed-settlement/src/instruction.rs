//! On-chain instruction codec (enabled with `--features onchain`).

use solana_program::program_error::ProgramError;

pub const SETTLE_TAG: u8 = 0;

#[derive(Debug, PartialEq, Eq)]
pub enum SettlementInstruction {
    /// Settle a 3-way split from the payer to artist, studio, and SYNXED.
    Settle {
        event_id: [u8; 32],
        amount: u64,
        artist_bps: u16,
        studio_bps: u16,
        synxed_bps: u16,
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
                let mut event_id = [0u8; 32];
                event_id.copy_from_slice(&rest[0..32]);
                let amount = u64::from_le_bytes(
                    rest[32..40]
                        .try_into()
                        .map_err(|_| ProgramError::InvalidInstructionData)?,
                );
                let artist_bps = u16::from_le_bytes(
                    rest[40..42]
                        .try_into()
                        .map_err(|_| ProgramError::InvalidInstructionData)?,
                );
                let studio_bps = u16::from_le_bytes(
                    rest[42..44]
                        .try_into()
                        .map_err(|_| ProgramError::InvalidInstructionData)?,
                );
                let synxed_bps = u16::from_le_bytes(
                    rest[44..46]
                        .try_into()
                        .map_err(|_| ProgramError::InvalidInstructionData)?,
                );
                Ok(SettlementInstruction::Settle {
                    event_id,
                    amount,
                    artist_bps,
                    studio_bps,
                    synxed_bps,
                })
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SettlementInstruction {
        let mut event_id = [0u8; 32];
        for (i, byte) in event_id.iter_mut().enumerate() {
            *byte = i as u8;
        }
        SettlementInstruction::Settle {
            event_id,
            amount: 20_000,
            artist_bps: 3_500,
            studio_bps: 4_000,
            synxed_bps: 2_500,
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

    #[test]
    fn unpack_round_trips_pack() {
        let packed = sample().pack();
        assert_eq!(SettlementInstruction::unpack(&packed).unwrap(), sample());
    }

    #[test]
    fn unpack_rejects_bad_input() {
        let packed = sample().pack();
        // Empty, unknown tag, truncated, and trailing-byte payloads.
        assert!(SettlementInstruction::unpack(&[]).is_err());
        assert!(SettlementInstruction::unpack(&[1]).is_err());
        assert!(SettlementInstruction::unpack(&packed[..packed.len() - 1]).is_err());
        let mut extended = packed.clone();
        extended.push(0);
        assert!(SettlementInstruction::unpack(&extended).is_err());
    }
}
