import { describe, expect, test } from "bun:test";
import {
  MAX_SHARES,
  ProtocolError,
  computeSettlementN,
  splitAmountAtomicShares,
  type ProtocolErrorCode,
  type SettlementRequestN,
} from "../sdk/typescript/src/index.ts";

function expectCode(fn: () => unknown, code: ProtocolErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`expected ProtocolError ${code}, but nothing was thrown`);
}

describe("splitAmountAtomicShares", () => {
  test("splits a $0.020 impression four ways with a rewards pool", () => {
    expect(splitAmountAtomicShares(20_000n, [3_500, 3_500, 2_000, 1_000])).toEqual([
      7_000n,
      7_000n,
      4_000n,
      2_000n,
    ]);
  });

  test("conserves every atomic unit for every share count", () => {
    const amounts = [1n, 2n, 3n, 7n, 19n, 101n, 20_000n, 999_999_999_999n];
    for (let n = 1; n <= MAX_SHARES; n += 1) {
      // Uneven shares; the last one absorbs whatever is left of 10000.
      const bps = Array.from({ length: n }, () => Math.floor(10_000 / n) - 1);
      const used = bps.slice(0, -1).reduce((acc, b) => acc + b, 0);
      bps[n - 1] = 10_000 - used;
      for (const amount of amounts) {
        const parts = splitAmountAtomicShares(amount, bps);
        expect(parts.length).toBe(n);
        expect(parts.reduce((acc, p) => acc + p, 0n)).toBe(amount);
        for (const part of parts) {
          expect(part >= 0n).toBe(true);
        }
      }
    }
  });

  test("a single share takes the whole amount", () => {
    expect(splitAmountAtomicShares(20_000n, [10_000])).toEqual([20_000n]);
  });

  test("rejects zero shares and more than the maximum", () => {
    expectCode(() => splitAmountAtomicShares(20_000n, []), "SHARE_COUNT");
    expectCode(
      () => splitAmountAtomicShares(20_000n, Array(MAX_SHARES + 1).fill(1_000)),
      "SHARE_COUNT",
    );
  });

  test("rejects sums, ranges, fractions, and zero amounts like the 3-way path", () => {
    expectCode(() => splitAmountAtomicShares(20_000n, [5_000, 4_999]), "BPS_SUM");
    expectCode(() => splitAmountAtomicShares(20_000n, [10_001, -1]), "BPS_RANGE");
    expectCode(() => splitAmountAtomicShares(20_000n, [5_000.5, 4_999.5]), "BPS_INTEGER");
    expectCode(() => splitAmountAtomicShares(0n, [10_000]), "ZERO_AMOUNT");
  });
});

describe("computeSettlementN", () => {
  const request: SettlementRequestN = {
    eventId: "evt_nway_0001",
    occurredAt: "2026-01-01T00:00:00.000Z",
    kind: "audio_ad_impression",
    amountAtomic: 20_000n,
    asset: "SOL_LAMPORTS_STANDIN",
    shares: [
      { label: "artist", recipient: "", bps: 3_500 },
      { label: "studio", recipient: "", bps: 3_500 },
      { label: "synxed", recipient: "", bps: 2_000 },
      { label: "rewards_pool", recipient: "", bps: 1_000 },
    ],
    memo: "n-way test",
  };

  test("labels each payout and preserves the total", () => {
    const result = computeSettlementN(request);
    expect(result.totalAtomic).toBe(20_000n);
    expect(result.payouts.map((p) => p.label)).toEqual([
      "artist",
      "studio",
      "synxed",
      "rewards_pool",
    ]);
    expect(result.payouts.map((p) => p.amountAtomic)).toEqual([
      7_000n,
      7_000n,
      4_000n,
      2_000n,
    ]);
  });

  test("rejects an empty label", () => {
    const blank: SettlementRequestN = {
      ...request,
      shares: [{ label: "  ", recipient: "", bps: 10_000 }],
    };
    expectCode(() => computeSettlementN(blank), "LABEL_EMPTY");
  });

  test("propagates invalid split errors instead of renormalizing", () => {
    const invalid: SettlementRequestN = {
      ...request,
      shares: request.shares.map((s) => ({ ...s, bps: 3_000 })), // sums to 12000
    };
    expectCode(() => computeSettlementN(invalid), "BPS_SUM");
  });
});
