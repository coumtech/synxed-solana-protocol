import { describe, expect, test } from "bun:test";
import type { Connection, Keypair } from "@solana/web3.js";
import {
  ProtocolError,
  U64_MAX,
  submitSettlement,
  type SettlementRequest,
} from "../sdk/typescript/src/index.ts";

// Validation must reject before any network traffic, so a connection and
// payer that are never touched are sufficient for these tests.
const connection = {} as unknown as Connection;
const payer = {} as unknown as Keypair;

function request(amountAtomic: bigint): SettlementRequest {
  return {
    eventId: "evt_client_guard",
    occurredAt: "2026-01-01T00:00:00.000Z",
    kind: "audio_ad_impression",
    amountAtomic,
    asset: "SOL_LAMPORTS_STANDIN",
    splits: [
      { role: "artist", recipient: "", bps: 3_500 },
      { role: "studio", recipient: "", bps: 4_000 },
      { role: "synxed", recipient: "", bps: 2_500 },
    ],
    memo: "guard test",
  };
}

describe("submitSettlement input guards", () => {
  test("rejects scaled totals beyond u64 in either mode", async () => {
    // 2^54 * 2^11 = 2^65 > u64 max, while each 35/40/25 share alone would
    // still fit in a u64 — the total must be checked, not just the shares.
    const oversized = submitSettlement({
      connection,
      payer,
      request: request(2n ** 54n),
      lamportsPerAtomicUnit: 2n ** 11n,
    });
    await expect(oversized).rejects.toBeInstanceOf(ProtocolError);
    await expect(oversized).rejects.toHaveProperty("code", "AMOUNT_U64");
  });

  test("accepts a total of exactly u64 max past the bound check", async () => {
    // U64_MAX itself passes the range guard and fails later on the empty
    // recipient — proving the bound is exclusive of valid maxima.
    const atMax = submitSettlement({
      connection,
      payer,
      request: request(U64_MAX),
      lamportsPerAtomicUnit: 1n,
    });
    await expect(atMax).rejects.toHaveProperty("code", "RECIPIENT_PUBKEY");
  });

  test("rejects a non-positive lamports scale", async () => {
    const zeroScale = submitSettlement({
      connection,
      payer,
      request: request(20_000n),
      lamportsPerAtomicUnit: 0n,
    });
    await expect(zeroScale).rejects.toHaveProperty("code", "SCALE_RANGE");
  });
});
