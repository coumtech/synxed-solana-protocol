import {
  BPS_DENOMINATOR,
  MAX_SHARES,
  ProtocolError,
  SETTLEMENT_ROLES,
  type ComputedPayout,
  type ComputedPayoutN,
  type SettlementRequest,
  type SettlementRequestN,
  type SplitResult,
  type SplitResultN,
  type SplitShare,
} from "./types.ts";

function assertBps(bps: number): void {
  if (!Number.isInteger(bps)) {
    throw new ProtocolError("BPS_INTEGER", "each share bps must be an integer");
  }
  if (bps < 0 || bps > BPS_DENOMINATOR) {
    throw new ProtocolError(
      "BPS_RANGE",
      `each share bps must be in 0..=${BPS_DENOMINATOR}`,
    );
  }
}

/**
 * Validate an N-way bps configuration: 1..=MAX_SHARES integer shares, each
 * in range, summing to exactly 10000.
 */
export function assertBpsShares(bps: readonly number[]): void {
  if (bps.length === 0 || bps.length > MAX_SHARES) {
    throw new ProtocolError(
      "SHARE_COUNT",
      `share count must be in 1..=${MAX_SHARES}, got ${bps.length}`,
    );
  }
  let sum = 0;
  for (const share of bps) {
    assertBps(share);
    sum += share;
  }
  if (sum !== BPS_DENOMINATOR) {
    throw new ProtocolError(
      "BPS_SUM",
      `split basis points must sum to ${BPS_DENOMINATOR}, got ${sum}`,
    );
  }
}

/** Validate a 3-way bps configuration: integers in range, summing to 10000. */
export function assertBpsTriple(
  bps: readonly [number, number, number],
): void {
  assertBpsShares(bps);
}

/**
 * Split `amount` across N BPS shares. Floor-divides the first N-1 shares
 * and assigns the remainder to the last share so payouts sum to `amount`.
 * Mirrors `split_shares` in the program.
 */
export function splitAmountAtomicShares(
  amount: bigint,
  bps: readonly number[],
): bigint[] {
  if (amount <= 0n) {
    throw new ProtocolError("ZERO_AMOUNT", "amount must be greater than zero");
  }
  assertBpsShares(bps);
  const payouts: bigint[] = [];
  let allocated = 0n;
  for (let i = 0; i < bps.length; i += 1) {
    if (i === bps.length - 1) {
      payouts.push(amount - allocated);
    } else {
      const part = (amount * BigInt(bps[i])) / BigInt(BPS_DENOMINATOR);
      payouts.push(part);
      allocated += part;
    }
  }
  return payouts;
}

function assertRoles(
  splits: readonly [SplitShare, SplitShare, SplitShare],
): void {
  // Positional matching also rules out duplicates: each slot must carry
  // exactly its own distinct role.
  for (let i = 0; i < SETTLEMENT_ROLES.length; i += 1) {
    const expected = SETTLEMENT_ROLES[i];
    const share = splits[i];
    if (share.role !== expected) {
      throw new ProtocolError(
        "ROLE_MISMATCH",
        `splits[${i}] must be role "${expected}"`,
      );
    }
  }
}

/**
 * Split `amount` across three BPS shares. Floor-divides the first two shares
 * and assigns the remainder to the last share so payouts sum to `amount`.
 */
export function splitAmountAtomic(
  amount: bigint,
  shares: readonly [SplitShare, SplitShare, SplitShare],
): readonly [bigint, bigint, bigint] {
  if (amount <= 0n) {
    throw new ProtocolError("ZERO_AMOUNT", "amount must be greater than zero");
  }
  assertRoles(shares);
  const parts = splitAmountAtomicShares(amount, [
    shares[0].bps,
    shares[1].bps,
    shares[2].bps,
  ]);
  return [parts[0], parts[1], parts[2]];
}

export function computeSettlement(request: SettlementRequest): SplitResult {
  const amounts = splitAmountAtomic(request.amountAtomic, request.splits);
  const payouts = [
    payout(request.splits[0], amounts[0]),
    payout(request.splits[1], amounts[1]),
    payout(request.splits[2], amounts[2]),
  ] as const;
  return {
    request,
    payouts,
    totalAtomic: request.amountAtomic,
  };
}

/** Compute the payouts of an N-way settlement request. */
export function computeSettlementN(request: SettlementRequestN): SplitResultN {
  request.shares.forEach((share, i) => {
    if (share.label.trim() === "") {
      throw new ProtocolError("LABEL_EMPTY", `shares[${i}] label must not be empty`);
    }
  });
  const amounts = splitAmountAtomicShares(
    request.amountAtomic,
    request.shares.map((share) => share.bps),
  );
  const payouts: ComputedPayoutN[] = request.shares.map((share, i) => ({
    label: share.label,
    recipient: share.recipient,
    bps: share.bps,
    amountAtomic: amounts[i],
  }));
  return {
    request,
    payouts,
    totalAtomic: request.amountAtomic,
  };
}

function payout(share: SplitShare, amountAtomic: bigint): ComputedPayout {
  return {
    role: share.role,
    recipient: share.recipient,
    bps: share.bps,
    amountAtomic,
  };
}
