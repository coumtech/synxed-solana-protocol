import {
  BPS_DENOMINATOR,
  ProtocolError,
  SETTLEMENT_ROLES,
  type ComputedPayout,
  type SettlementRequest,
  type SplitResult,
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

/** Validate a 3-way bps configuration: integers in range, summing to 10000. */
export function assertBpsTriple(
  bps: readonly [number, number, number],
): void {
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
  assertBpsTriple([shares[0].bps, shares[1].bps, shares[2].bps]);

  const first = (amount * BigInt(shares[0].bps)) / BigInt(BPS_DENOMINATOR);
  const second = (amount * BigInt(shares[1].bps)) / BigInt(BPS_DENOMINATOR);
  const third = amount - first - second;
  return [first, second, third];
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

function payout(share: SplitShare, amountAtomic: bigint): ComputedPayout {
  return {
    role: share.role,
    recipient: share.recipient,
    bps: share.bps,
    amountAtomic,
  };
}
