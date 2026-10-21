//! On-chain instruction codec (enabled with `--features onchain`).
//!
//! Tags 0 to 2 were the original settlement instructions. They keyed the
//! settlement record on the event id alone, so anyone who learned an unsettled
//! event id could settle it first and block the real settlement. They are
//! retired: the program rejects them, and every settlement now goes through a
//! namespace (tags 5 and 6).

use crate::split::MAX_SHARES;
use solana_program::msg;
use solana_program::program_error::ProgramError;
use solana_program::pubkey::Pubkey;

/// Retired tags: the original `Settle`, `SettleN`, and `SettleTokenN`.
pub const RETIRED_TAGS: [u8; 3] = [0, 1, 2];
pub const CREATE_NAMESPACE_TAG: u8 = 3;
pub const SET_NAMESPACE_AUTHORITY_TAG: u8 = 4;
pub const SETTLE_N_TAG: u8 = 5;
pub const SETTLE_TOKEN_N_TAG: u8 = 6;

/// `CreateNamespace` payload: namespace id + initial authority.
const CREATE_NAMESPACE_LEN: usize = 32 + 32;
/// `SetNamespaceAuthority` payload: the new authority.
const SET_NAMESPACE_AUTHORITY_LEN: usize = 32;
/// `SettleN` payload before the bps list: event_id + amount + share count.
const SETTLE_N_HEADER_LEN: usize = 32 + 8 + 1;
/// `SettleTokenN` payload before the bps list: event_id + amount + decimals +
/// share count.
const SETTLE_TOKEN_N_HEADER_LEN: usize = 32 + 8 + 1 + 1;

#[derive(Debug, PartialEq, Eq)]
pub enum SettlementInstruction {
    /// Open a settlement namespace.
    ///
    /// Accounts: payer (signer, writable), creator (signer), namespace PDA
    /// `["namespace", creator, namespace_id]` (writable), system program.
    CreateNamespace {
        namespace_id: [u8; 32],
        authority: Pubkey,
    },
    /// Replace a namespace's authority. Existing records stay valid, so
    /// rotating the key does not reset idempotency.
    ///
    /// Accounts: current authority (signer), namespace (writable).
    SetNamespaceAuthority { new_authority: Pubkey },
    /// Settle an N-way split (1..=`MAX_SHARES` shares) in native lamports.
    ///
    /// Accounts: payer (signer, writable), namespace authority (signer),
    /// namespace, one writable recipient per share in `bps` order, settlement
    /// record PDA `["settlement", namespace, event_id]` (writable), system
    /// program.
    SettleN {
        event_id: [u8; 32],
        amount: u64,
        bps: Vec<u16>,
    },
    /// Settle an N-way split in classic SPL Token base units.
    ///
    /// Accounts: payer/token authority (signer, writable), namespace authority
    /// (signer), namespace, source token account (writable), one writable
    /// destination token account per share, mint, settlement record PDA
    /// (writable), system program, classic SPL Token program.
    SettleTokenN {
        event_id: [u8; 32],
        amount: u64,
        decimals: u8,
        bps: Vec<u16>,
    },
}

impl SettlementInstruction {
    pub fn pack(&self) -> Vec<u8> {
        match self {
            SettlementInstruction::CreateNamespace {
                namespace_id,
                authority,
            } => {
                let mut out = Vec::with_capacity(1 + CREATE_NAMESPACE_LEN);
                out.push(CREATE_NAMESPACE_TAG);
                out.extend_from_slice(namespace_id);
                out.extend_from_slice(authority.as_ref());
                out
            }
            SettlementInstruction::SetNamespaceAuthority { new_authority } => {
                let mut out = Vec::with_capacity(1 + SET_NAMESPACE_AUTHORITY_LEN);
                out.push(SET_NAMESPACE_AUTHORITY_TAG);
                out.extend_from_slice(new_authority.as_ref());
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
            SettlementInstruction::SettleTokenN {
                event_id,
                amount,
                decimals,
                bps,
            } => {
                let mut out = Vec::with_capacity(1 + SETTLE_TOKEN_N_HEADER_LEN + 2 * bps.len());
                out.push(SETTLE_TOKEN_N_TAG);
                out.extend_from_slice(event_id);
                out.extend_from_slice(&amount.to_le_bytes());
                out.push(*decimals);
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
        match *tag {
            tag if RETIRED_TAGS.contains(&tag) => {
                msg!(
                    "instruction tag {} is retired: settle through a namespace (tags 5 and 6)",
                    tag
                );
                Err(ProgramError::InvalidInstructionData)
            }
            CREATE_NAMESPACE_TAG => {
                if rest.len() != CREATE_NAMESPACE_LEN {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(SettlementInstruction::CreateNamespace {
                    namespace_id: read_32(&rest[0..32]),
                    authority: Pubkey::new_from_array(read_32(&rest[32..64])),
                })
            }
            SET_NAMESPACE_AUTHORITY_TAG => {
                if rest.len() != SET_NAMESPACE_AUTHORITY_LEN {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(SettlementInstruction::SetNamespaceAuthority {
                    new_authority: Pubkey::new_from_array(read_32(rest)),
                })
            }
            SETTLE_N_TAG => {
                if rest.len() < SETTLE_N_HEADER_LEN {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let count = usize::from(rest[40]);
                if count == 0 || count > MAX_SHARES || rest.len() != SETTLE_N_HEADER_LEN + 2 * count
                {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(SettlementInstruction::SettleN {
                    event_id: read_32(&rest[0..32]),
                    amount: read_u64(&rest[32..40])?,
                    bps: read_bps(&rest[SETTLE_N_HEADER_LEN..], count)?,
                })
            }
            SETTLE_TOKEN_N_TAG => {
                if rest.len() < SETTLE_TOKEN_N_HEADER_LEN {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let count = usize::from(rest[41]);
                if count == 0
                    || count > MAX_SHARES
                    || rest.len() != SETTLE_TOKEN_N_HEADER_LEN + 2 * count
                {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(SettlementInstruction::SettleTokenN {
                    event_id: read_32(&rest[0..32]),
                    amount: read_u64(&rest[32..40])?,
                    decimals: rest[40],
                    bps: read_bps(&rest[SETTLE_TOKEN_N_HEADER_LEN..], count)?,
                })
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

/// Copy 32 bytes; callers have already checked the length.
fn read_32(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes[0..32]);
    out
}

fn read_u64(bytes: &[u8]) -> Result<u64, ProgramError> {
    Ok(u64::from_le_bytes(
        bytes
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    ))
}

fn read_bps(bytes: &[u8], count: usize) -> Result<Vec<u16>, ProgramError> {
    let mut bps = Vec::with_capacity(count);
    for i in 0..count {
        let start = 2 * i;
        bps.push(u16::from_le_bytes(
            bytes[start..start + 2]
                .try_into()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
        ));
    }
    Ok(bps)
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

    /// 32 bytes counting down from 255, so it differs from `seed()`.
    fn key() -> Pubkey {
        let mut bytes = [0u8; 32];
        for (i, byte) in bytes.iter_mut().enumerate() {
            *byte = 255 - i as u8;
        }
        Pubkey::new_from_array(bytes)
    }

    fn sample_create() -> SettlementInstruction {
        SettlementInstruction::CreateNamespace {
            namespace_id: seed(),
            authority: key(),
        }
    }

    fn sample_rotate() -> SettlementInstruction {
        SettlementInstruction::SetNamespaceAuthority {
            new_authority: key(),
        }
    }

    fn sample_n() -> SettlementInstruction {
        SettlementInstruction::SettleN {
            event_id: seed(),
            amount: 20_000,
            bps: vec![3_500, 3_500, 2_000, 1_000],
        }
    }

    fn sample_token_n() -> SettlementInstruction {
        SettlementInstruction::SettleTokenN {
            event_id: seed(),
            amount: 20_000,
            decimals: 6,
            bps: vec![3_500, 3_500, 2_000, 1_000],
        }
    }

    fn descending() -> Vec<u8> {
        (0u8..32).map(|i| 255 - i).collect()
    }

    /// Golden bytes shared with the TypeScript codec tests
    /// (`tests/instruction-n.test.ts`, `tests/namespace.test.ts`). If a
    /// vector changes, both sides must change together.
    #[test]
    fn pack_create_namespace_matches_shared_golden_bytes() {
        let mut expected = vec![CREATE_NAMESPACE_TAG];
        expected.extend((0u8..32).collect::<Vec<u8>>());
        expected.extend(descending());
        assert_eq!(sample_create().pack(), expected);
        assert_eq!(expected.len(), 65);
    }

    #[test]
    fn pack_set_namespace_authority_matches_shared_golden_bytes() {
        let mut expected = vec![SET_NAMESPACE_AUTHORITY_TAG];
        expected.extend(descending());
        assert_eq!(sample_rotate().pack(), expected);
        assert_eq!(expected.len(), 33);
    }

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
    fn pack_token_n_matches_shared_golden_bytes() {
        let mut expected = vec![SETTLE_TOKEN_N_TAG];
        expected.extend((0u8..32).collect::<Vec<u8>>());
        expected.extend([0x20, 0x4e, 0, 0, 0, 0, 0, 0]);
        expected.push(6);
        expected.push(4);
        expected.extend([0xac, 0x0d, 0xac, 0x0d, 0xd0, 0x07, 0xe8, 0x03]);
        assert_eq!(sample_token_n().pack(), expected);
        assert_eq!(expected.len(), 51);
    }

    #[test]
    fn unpack_round_trips_pack() {
        for sample in [
            sample_create(),
            sample_rotate(),
            sample_n(),
            sample_token_n(),
        ] {
            assert_eq!(
                SettlementInstruction::unpack(&sample.pack()).unwrap(),
                sample
            );
        }
    }

    #[test]
    fn unpack_rejects_retired_and_unknown_tags() {
        // The original Settle (0), SettleN (1), and SettleTokenN (2) payloads,
        // byte for byte, are refused rather than reinterpreted.
        let mut legacy_settle = vec![0u8];
        legacy_settle.extend(seed());
        legacy_settle.extend([
            0x20, 0x4e, 0, 0, 0, 0, 0, 0, 0xac, 0x0d, 0xa0, 0x0f, 0xc4, 0x09,
        ]);
        assert_eq!(
            SettlementInstruction::unpack(&legacy_settle),
            Err(ProgramError::InvalidInstructionData)
        );
        for tag in RETIRED_TAGS {
            let mut legacy = sample_n().pack();
            legacy[0] = tag;
            assert_eq!(
                SettlementInstruction::unpack(&legacy),
                Err(ProgramError::InvalidInstructionData)
            );
        }
        assert!(SettlementInstruction::unpack(&[]).is_err());
        assert!(SettlementInstruction::unpack(&[7]).is_err());
        assert!(SettlementInstruction::unpack(&[255]).is_err());
    }

    #[test]
    fn unpack_rejects_wrong_lengths() {
        for sample in [
            sample_create(),
            sample_rotate(),
            sample_n(),
            sample_token_n(),
        ] {
            let packed = sample.pack();
            assert!(SettlementInstruction::unpack(&packed[..packed.len() - 1]).is_err());
            let mut extended = packed.clone();
            extended.push(0);
            assert!(SettlementInstruction::unpack(&extended).is_err());
        }
    }

    #[test]
    fn unpack_rejects_bad_share_counts() {
        for build in [
            |bps: Vec<u16>| SettlementInstruction::SettleN {
                event_id: seed(),
                amount: 1,
                bps,
            },
            |bps: Vec<u16>| SettlementInstruction::SettleTokenN {
                event_id: seed(),
                amount: 1,
                decimals: 6,
                bps,
            },
        ] {
            assert!(SettlementInstruction::unpack(&build(vec![]).pack()).is_err());
            assert!(
                SettlementInstruction::unpack(&build(vec![1_000; MAX_SHARES + 1]).pack()).is_err()
            );
        }
        // A count byte that lies about the list length.
        let mut lying = sample_n().pack();
        lying[41] = 3;
        assert!(SettlementInstruction::unpack(&lying).is_err());
        let mut lying_token = sample_token_n().pack();
        lying_token[42] = 3;
        assert!(SettlementInstruction::unpack(&lying_token).is_err());
    }
}
