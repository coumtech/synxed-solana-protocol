import { describe, expect, test } from "bun:test";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  SETTLE_TOKEN_N_HEADER_LENGTH,
  SETTLE_TOKEN_N_TAG,
  ProtocolError,
  buildSettlementNTransaction,
  buildTokenSettlementNTransaction,
  encodeSettleTokenNData,
  eventIdSeed,
  reconcileObservedTokenSettlementN,
  type ProgramTokenSettlementObservation,
  type SettlementRequestN,
} from "../sdk/typescript/src/index.ts";

const PROGRAM_ID = new PublicKey("HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT");
const PAYER = new PublicKey("6k3KRgAuv4CwanjLGwYH1rzwTeZwSRbeLETHfen4h51s");
const MINT = new PublicKey("BXXkv6z7ykFGoHGQWGZrdt9hDDQvU7EWZjWHUpTKixbv");
const RECIPIENTS = [
  "6AF4DwckLZ7pxwWYarmJx5Sk6dyziagHNoDA8CJpDQa5",
  "EfKS8o2pDsHAJUKQQ3evE5m6PgYR7rxEYvGQavk2y1Da",
  "GJ7JUe6w6DktBDBPKGWNzhJUhRRFExJqb2hrtdsQFX7s",
  "48fB8mLhZJNZxVjyebuEhu5nvKPSyM31asQE6kkjqhA9",
] as const;
const BPS = [3_500, 3_500, 2_000, 1_000] as const;
const AMOUNTS = [7_000n, 7_000n, 4_000n, 2_000n] as const;

function request(): SettlementRequestN {
  return {
    eventId: "evt_token_settlement",
    occurredAt: "2026-09-12T09:00:00.000Z",
    kind: "audio_ad_impression",
    amountAtomic: 20_000n,
    asset: "SPL_STABLECOIN",
    shares: RECIPIENTS.map((recipient, index) => ({
      label: ["artist", "studio", "synxed", "rewards_pool"][index],
      recipient,
      bps: BPS[index],
    })),
    memo: "USDC settlement test",
  };
}

describe("SettleTokenN", () => {
  test("matches the Rust token instruction golden bytes", () => {
    const seed = Uint8Array.from(Array.from({ length: 32 }, (_, index) => index));
    const data = encodeSettleTokenNData({
      eventSeed: seed,
      amount: 20_000n,
      decimals: 6,
      bps: BPS,
    });
    expect(data).toEqual(
      Uint8Array.from([
        SETTLE_TOKEN_N_TAG,
        ...seed,
        0x20, 0x4e, 0, 0, 0, 0, 0, 0,
        6,
        4,
        0xac, 0x0d,
        0xac, 0x0d,
        0xd0, 0x07,
        0xe8, 0x03,
      ]),
    );
    expect(data).toHaveLength(SETTLE_TOKEN_N_HEADER_LENGTH + 2 * BPS.length);
  });

  test("builds recipient ATAs, idempotent creation, memo, and program instruction", () => {
    const prepared = buildTokenSettlementNTransaction({
      payer: PAYER,
      request: request(),
      mint: MINT,
      decimals: 6,
      programId: PROGRAM_ID,
    });
    expect(prepared.mode).toBe("program-token");
    expect(prepared.tokenAmountsByShare).toEqual(AMOUNTS);
    expect(prepared.sourceTokenAccount).toEqual(
      getAssociatedTokenAddressSync(MINT, PAYER),
    );
    expect(prepared.recipientTokenAccounts).toEqual(
      RECIPIENTS.map((recipient) =>
        getAssociatedTokenAddressSync(MINT, new PublicKey(recipient)),
      ),
    );
    expect(prepared.transaction.instructions).toHaveLength(6);
    expect(prepared.transaction.instructions.at(-1)?.keys).toHaveLength(10);
  });

  test("rejects wrong asset modes, invalid decimals, and a payer recipient", () => {
    expect(() =>
      buildTokenSettlementNTransaction({
        payer: PAYER,
        request: { ...request(), asset: "SOL_LAMPORTS_STANDIN" },
        mint: MINT,
        decimals: 6,
        programId: PROGRAM_ID,
      }),
    ).toThrow("requires SPL_STABLECOIN or USDC");
    expect(() =>
      buildSettlementNTransaction({
        payer: PAYER,
        request: request(),
        programId: PROGRAM_ID,
      }),
    ).toThrow("native settlement requires SOL_LAMPORTS_STANDIN");
    expect(() =>
      buildTokenSettlementNTransaction({
        payer: PAYER,
        request: request(),
        mint: MINT,
        decimals: 256,
        programId: PROGRAM_ID,
      }),
    ).toThrow("token decimals must be an integer in 0..=255");
    try {
      buildTokenSettlementNTransaction({
        payer: new PublicKey(RECIPIENTS[0]),
        request: request(),
        mint: MINT,
        decimals: 6,
        programId: PROGRAM_ID,
      });
      throw new Error("expected payer recipient to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("TOKEN_SOURCE_RECIPIENT");
    }
  });

  test("reconciles exact token evidence into paid and pooled ledger rows", () => {
    const source = getAssociatedTokenAddressSync(MINT, PAYER).toBase58();
    const destinations = RECIPIENTS.map((recipient) =>
      getAssociatedTokenAddressSync(MINT, new PublicKey(recipient)).toBase58(),
    );
    const observation: ProgramTokenSettlementObservation = {
      signature: "token-signature",
      slot: 500_000_001,
      blockTime: 1_789_200_001,
      programId: PROGRAM_ID.toBase58(),
      payer: PAYER.toBase58(),
      sourceTokenAccount: source,
      recipientTokenAccounts: destinations,
      mint: MINT.toBase58(),
      record: "record-address",
      eventSeedHex: Array.from(eventIdSeed(request().eventId), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
      amountOnChain: 20_000n,
      decimals: 6,
      bps: BPS,
      transfers: destinations.map((destination, index) => ({
        source,
        destination,
        mint: MINT.toBase58(),
        amountOnChain: AMOUNTS[index],
        decimals: 6,
      })),
      memo: {
        protocol: "synxed-settlement",
        event: request().eventId,
        occurredAt: request().occurredAt,
        kind: request().kind,
        asset: "SPL_STABLECOIN",
        tokenAmount: "20000",
        mint: MINT.toBase58(),
        decimals: 6,
        memo: request().memo,
      },
    };
    const result = reconcileObservedTokenSettlementN({
      observation,
      request: request(),
      tokenBaseUnitsPerAtomicUnit: 1n,
      mint: MINT,
      decimals: 6,
      beneficiaryIds: {
        artist: "artist:demo",
        studio: "studio:demo",
        synxed: "platform:synxed",
      },
    });
    expect(result.record.mode).toBe("program-token");
    expect(result.record.schemaVersion).toBe(1);
    expect(result.record.programId).toBe(PROGRAM_ID.toBase58());
    expect(result.record.payer).toBe(PAYER.toBase58());
    expect(result.record.settlementRecord).toBe("record-address");
    expect(result.record.mint).toBe(MINT.toBase58());
    expect(result.directEntries).toHaveLength(3);
    expect(result.poolPayouts).toHaveLength(1);

    expect(() =>
      reconcileObservedTokenSettlementN({
        observation: {
          ...observation,
          transfers: observation.transfers.slice(0, -1),
        },
        request: request(),
        tokenBaseUnitsPerAtomicUnit: 1n,
        mint: MINT,
        decimals: 6,
      }),
    ).toThrow("inner token transfers do not exactly match");
  });
});
