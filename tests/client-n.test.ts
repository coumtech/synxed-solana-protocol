import { describe, expect, test } from "bun:test";
import type { Connection, Keypair } from "@solana/web3.js";
import {
  ProtocolError,
  submitSettlementN,
  type SettlementRequestN,
} from "../sdk/typescript/src/index.ts";

// Validation must reject before any network traffic, so a connection and
// payer that are never touched are sufficient for these tests.
const connection = {} as unknown as Connection;
const payer = {} as unknown as Keypair;

function request(
  amountAtomic: bigint,
  bps: readonly number[] = [3_500, 3_500, 2_000, 1_000],
): SettlementRequestN {
  return {
    eventId: "evt_client_n_guard",
    occurredAt: "2026-01-01T00:00:00.000Z",
    kind: "audio_ad_impression",
    amountAtomic,
    asset: "SOL_LAMPORTS_STANDIN",
    shares: bps.map((b, i) => ({ label: `share_${i}`, recipient: "", bps: b })),
    memo: "guard test",
  };
}

describe("submitSettlementN input guards", () => {
  test("rejects scaled totals beyond u64", async () => {
    const oversized = submitSettlementN({
      connection,
      payer,
      request: request(2n ** 54n),
      lamportsPerAtomicUnit: 2n ** 11n,
    });
    await expect(oversized).rejects.toBeInstanceOf(ProtocolError);
    await expect(oversized).rejects.toHaveProperty("code", "AMOUNT_U64");
  });

  test("rejects a non-positive lamports scale", async () => {
    const zeroScale = submitSettlementN({
      connection,
      payer,
      request: request(20_000n),
      lamportsPerAtomicUnit: 0n,
    });
    await expect(zeroScale).rejects.toHaveProperty("code", "SCALE_RANGE");
  });

  test("rejects too many shares before touching the network", async () => {
    const nine = submitSettlementN({
      connection,
      payer,
      request: request(20_000n, Array(9).fill(1_000)),
    });
    await expect(nine).rejects.toHaveProperty("code", "SHARE_COUNT");
  });

  test("fails on the empty recipient only after all split validation", async () => {
    const valid = submitSettlementN({
      connection,
      payer,
      request: request(20_000n),
    });
    await expect(valid).rejects.toHaveProperty("code", "RECIPIENT_PUBKEY");
  });
});
