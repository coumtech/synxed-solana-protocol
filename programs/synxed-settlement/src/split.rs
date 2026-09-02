//! Host-side and on-chain split math.
//!
//! Basis points are integers. `BPS_DENOMINATOR` (10_000) is 100%.
//! Remainder after floor division is assigned to the last share so that
//! payouts always sum to `amount` (conservation).

pub const BPS_DENOMINATOR: u32 = 10_000;
/// Share count of the original three-way `Settle` instruction.
pub const SHARE_COUNT: usize = 3;
/// Upper bound on shares per settlement. Bounded so account lists and
/// instruction data stay small and compute stays predictable.
pub const MAX_SHARES: usize = 8;

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
    ShareCount,
}

impl SplitError {
    pub fn message(self) -> &'static str {
        match self {
            SplitError::BpsSumNotDenominator => "split basis points must sum to 10000",
            SplitError::BpsOutOfRange => "each share bps must be in 0..=10000",
            SplitError::ZeroAmount => "amount must be greater than zero",
            SplitError::ShareCount => "share count must be in 1..=8",
        }
    }
}

/// Validate and split `amount` across `bps.len()` shares, writing the
/// payouts into `out` (which must have the same length).
///
/// The first `n - 1` shares are floor divisions; the last share receives
/// the remainder, so the payouts always sum to `amount` exactly.
pub fn split_shares(amount: u64, bps: &[u16], out: &mut [u64]) -> Result<(), SplitError> {
    let n = bps.len();
    if n == 0 || n > MAX_SHARES || out.len() != n {
        return Err(SplitError::ShareCount);
    }
    if amount == 0 {
        return Err(SplitError::ZeroAmount);
    }
    let mut sum: u32 = 0;
    for &share in bps {
        if share > BPS_DENOMINATOR as u16 {
            return Err(SplitError::BpsOutOfRange);
        }
        sum += u32::from(share);
    }
    if sum != BPS_DENOMINATOR {
        return Err(SplitError::BpsSumNotDenominator);
    }

    let mut allocated: u64 = 0;
    for i in 0..n {
        if i + 1 == n {
            // Cannot underflow: the floored shares sum to at most `amount`.
            out[i] = amount
                .checked_sub(allocated)
                .ok_or(SplitError::ZeroAmount)?;
        } else {
            let part =
                (amount as u128).saturating_mul(u128::from(bps[i])) / u128::from(BPS_DENOMINATOR);
            out[i] = part as u64;
            allocated = allocated.saturating_add(out[i]);
        }
    }
    Ok(())
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
    let mut out = [0u64; SHARE_COUNT];
    split_shares(amount, &[artist_bps, studio_bps, synxed_bps], &mut out)?;
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

    #[test]
    fn four_way_split_with_rewards_pool() {
        let mut out = [0u64; 4];
        split_shares(20_000, &[3_500, 3_500, 2_000, 1_000], &mut out).expect("valid");
        assert_eq!(out, [7_000, 7_000, 4_000, 2_000]);
    }

    #[test]
    fn conserves_amount_for_every_share_count() {
        let amounts = [1u64, 2, 3, 7, 19, 101, 20_000, 999_999_999_999, u64::MAX];
        for n in 1..=MAX_SHARES {
            // Spread 10000 bps unevenly across n shares; last share takes the rest.
            let mut bps = vec![(BPS_DENOMINATOR as u16 / n as u16) - 1; n];
            let used: u32 = bps.iter().map(|&b| u32::from(b)).sum::<u32>() - u32::from(bps[n - 1]);
            bps[n - 1] = (BPS_DENOMINATOR - used) as u16;
            for &amount in &amounts {
                let mut out = vec![0u64; n];
                split_shares(amount, &bps, &mut out).expect("valid split");
                let total = out.iter().fold(0u128, |acc, &x| acc + u128::from(x));
                assert_eq!(total, u128::from(amount), "n={n} amount={amount}");
            }
        }
    }

    #[test]
    fn rejects_bad_share_counts() {
        let mut none: [u64; 0] = [];
        assert_eq!(
            split_shares(20_000, &[], &mut none).unwrap_err(),
            SplitError::ShareCount
        );
        let too_many = [1_250u16; MAX_SHARES + 1];
        let mut out = [0u64; MAX_SHARES + 1];
        assert_eq!(
            split_shares(20_000, &too_many, &mut out).unwrap_err(),
            SplitError::ShareCount
        );
        let mut wrong_len = [0u64; 2];
        assert_eq!(
            split_shares(20_000, &[5_000, 3_000, 2_000], &mut wrong_len).unwrap_err(),
            SplitError::ShareCount
        );
    }

    #[test]
    fn single_share_takes_everything() {
        let mut out = [0u64; 1];
        split_shares(20_000, &[10_000], &mut out).expect("valid");
        assert_eq!(out, [20_000]);
    }
}
