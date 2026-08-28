import { describe, expect, test } from "bun:test";
import {
  BPS_DENOMINATOR,
  DEFAULT_AMOUNT_ATOMIC,
  DEFAULT_ARTIST_BPS,
  DEFAULT_STUDIO_BPS,
  DEFAULT_SYNXED_BPS,
  ProtocolError,
  computeSettlement,
  splitAmountAtomic,
  type ProtocolErrorCode,
  type SettlementRequest,
  type SplitShare,
} from "../sdk/typescript/src/index.ts";

function shares(
  artistBps: number,
  studioBps: number,
  synxedBps: number,
): readonly [SplitShare, SplitShare, SplitShare] {
  return [
    { role: "artist", recipient: "", bps: artistBps },
    { role: "studio", recipient: "", bps: studioBps },
    { role: "synxed", recipient: "", bps: synxedBps },
  ];
}

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

describe("splitAmountAtomic", () => {
  test("splits the default $0.020 impression 35/40/25", () => {
    const parts = splitAmountAtomic(
      DEFAULT_AMOUNT_ATOMIC,
      shares(DEFAULT_ARTIST_BPS, DEFAULT_STUDIO_BPS, DEFAULT_SYNXED_BPS),
    );
    expect(parts).toEqual([7_000n, 8_000n, 5_000n]);
  });

  test("conserves every atomic unit across awkward amounts and splits", () => {
    const amounts = [1n, 2n, 3n, 7n, 19n, 101n, 20_000n, 999_999_999_999n];
    const bpsSets: ReadonlyArray<readonly [number, number, number]> = [
      [3_500, 4_000, 2_500],
      [1, 1, 9_998],
      [9_998, 1, 1],
      [0, 0, 10_000],
      [3_333, 3_333, 3_334],
      [10_000, 0, 0],
    ];
    for (const amount of amounts) {
      for (const [a, s, y] of bpsSets) {
        const parts = splitAmountAtomic(amount, shares(a, s, y));
        const total = parts[0] + parts[1] + parts[2];
        expect(total).toBe(amount);
        for (const part of parts) {
          expect(part >= 0n).toBe(true);
        }
      }
    }
  });

  test("rejects bps that sum below the denominator", () => {
    expectCode(
      () => splitAmountAtomic(20_000n, shares(3_500, 4_000, 2_499)),
      "BPS_SUM",
    );
  });

  test("rejects bps that sum above the denominator", () => {
    expectCode(
      () => splitAmountAtomic(20_000n, shares(3_500, 4_000, 2_501)),
      "BPS_SUM",
    );
  });

  test("rejects zero and negative amounts", () => {
    expectCode(
      () => splitAmountAtomic(0n, shares(3_500, 4_000, 2_500)),
      "ZERO_AMOUNT",
    );
    expectCode(
      () => splitAmountAtomic(-5n, shares(3_500, 4_000, 2_500)),
      "ZERO_AMOUNT",
    );
  });

  test("rejects negative, oversized, and fractional bps", () => {
    expectCode(
      () => splitAmountAtomic(20_000n, shares(-1, 4_000, 6_001)),
      "BPS_RANGE",
    );
    expectCode(
      () => splitAmountAtomic(20_000n, shares(BPS_DENOMINATOR + 1, 0, 0)),
      "BPS_RANGE",
    );
    expectCode(
      () => splitAmountAtomic(20_000n, shares(3_500.5, 3_999.5, 2_500)),
      "BPS_INTEGER",
    );
  });

  test("rejects shares that are out of role order", () => {
    const swapped: readonly [SplitShare, SplitShare, SplitShare] = [
      { role: "studio", recipient: "", bps: 4_000 },
      { role: "artist", recipient: "", bps: 3_500 },
      { role: "synxed", recipient: "", bps: 2_500 },
    ];
    expectCode(() => splitAmountAtomic(20_000n, swapped), "ROLE_MISMATCH");
  });
});

describe("computeSettlement", () => {
  const request: SettlementRequest = {
    eventId: "evt_test_0001",
    occurredAt: "2026-01-01T00:00:00.000Z",
    kind: "audio_ad_impression",
    amountAtomic: 20_000n,
    asset: "SOL_LAMPORTS_STANDIN",
    splits: shares(3_500, 4_000, 2_500),
    memo: "test impression",
  };

  test("labels each payout with its role and preserves the total", () => {
    const result = computeSettlement(request);
    expect(result.totalAtomic).toBe(20_000n);
    expect(result.payouts.map((p) => p.role)).toEqual([
      "artist",
      "studio",
      "synxed",
    ]);
    expect(result.payouts.map((p) => p.amountAtomic)).toEqual([
      7_000n,
      8_000n,
      5_000n,
    ]);
    const sum = result.payouts.reduce((acc, p) => acc + p.amountAtomic, 0n);
    expect(sum).toBe(request.amountAtomic);
  });

  test("propagates invalid split errors instead of renormalizing", () => {
    const invalid: SettlementRequest = {
      ...request,
      splits: shares(5_000, 5_000, 5_000),
    };
    expectCode(() => computeSettlement(invalid), "BPS_SUM");
  });
});
