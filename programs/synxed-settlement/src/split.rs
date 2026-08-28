//! Host-side and on-chain split math.
//!
//! Basis points are integers. `BPS_DENOMINATOR` (10_000) is 100%.
//! Remainder after floor division is assigned to the last share so that
//! payouts always sum to `amount` (conservation).

pub const BPS_DENOMINATOR: u32 = 10_000;
pub const SHARE_COUNT: usize = 3;

pub const DEFAULT_ARTIST_BPS: u16 = 3_500;
pub const DEFAULT_STUDIO_BPS: u16 = 4_000;
pub const DEFAULT_SYNXED_BPS: u16 = 2_500;

/// Default gross for an audio-ad impression: $0.020 at 6 decimal places.
pub const DEFAULT_AMOUNT_ATOMIC: u64 = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitError {
    BpsSumNotDenominator,
    BpsOutOfRange,
    ZeroAmount,
}

impl SplitError {
    pub fn message(self) -> &'static str {
        match self {
            SplitError::BpsSumNotDenominator => "split basis points must sum to 10000",
            SplitError::BpsOutOfRange => "each share bps must be in 0..=10000",
            SplitError::ZeroAmount => "amount must be greater than zero",
        }
    }
}

/// Validate and split `amount` across three shares.
///
/// Returns `[artist, studio, synxed]` atomic amounts.
pub fn split_three(
    amount: u64,
    artist_bps: u16,
    studio_bps: u16,
    synxed_bps: u16,
) -> Result<[u64; SHARE_COUNT], SplitError> {
    if amount == 0 {
        return Err(SplitError::ZeroAmount);
    }
    let shares = [artist_bps, studio_bps, synxed_bps];
    let mut sum: u32 = 0;
    for bps in shares {
        if bps > BPS_DENOMINATOR as u16 {
            return Err(SplitError::BpsOutOfRange);
        }
        sum += u32::from(bps);
    }
    if sum != BPS_DENOMINATOR {
        return Err(SplitError::BpsSumNotDenominator);
    }

    let mut out = [0u64; SHARE_COUNT];
    let mut allocated: u64 = 0;
    for i in 0..SHARE_COUNT {
        if i + 1 == SHARE_COUNT {
            out[i] = amount
                .checked_sub(allocated)
                .ok_or(SplitError::ZeroAmount)?;
        } else {
            let part = (amount as u128).saturating_mul(u128::from(shares[i]))
                / u128::from(BPS_DENOMINATOR);
            out[i] = part as u64;
            allocated = allocated.saturating_add(out[i]);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn happy_path_default_two_cent_split() {
        let parts = split_three(
            DEFAULT_AMOUNT_ATOMIC,
            DEFAULT_ARTIST_BPS,
            DEFAULT_STUDIO_BPS,
            DEFAULT_SYNXED_BPS,
        )
        .expect("valid default split");
        assert_eq!(parts, [7_000, 8_000, 5_000]);
        assert_eq!(parts.iter().sum::<u64>(), DEFAULT_AMOUNT_ATOMIC);
    }

    #[test]
    fn remainder_goes_to_last_share() {
        // 1 atomic unit cannot divide evenly; last share keeps the remainder.
        let parts = split_three(1, 3_500, 4_000, 2_500).expect("valid");
        assert_eq!(parts, [0, 0, 1]);
        assert_eq!(parts.iter().sum::<u64>(), 1);
    }

    #[test]
    fn rejects_bps_that_do_not_sum_to_10000() {
        let err = split_three(20_000, 3_500, 4_000, 2_400).unwrap_err();
        assert_eq!(err, SplitError::BpsSumNotDenominator);
    }

    #[test]
    fn rejects_zero_amount() {
        let err = split_three(0, 3_500, 4_000, 2_500).unwrap_err();
        assert_eq!(err, SplitError::ZeroAmount);
    }

    #[test]
    fn rejects_bps_above_denominator() {
        let err = split_three(20_000, 10_001, 0, 0).unwrap_err();
        assert_eq!(err, SplitError::BpsOutOfRange);
    }
}
