import { describe, expect, test } from "bun:test";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  SETTLE_TOKEN_N_HEADER_LENGTH,
  ProtocolError,
  buildSettlementNTransaction,
  buildTokenSettlementNTransaction,
  encodeSettleTokenNData,
  eventIdSeed,
  findNamespacePda,
  findSettlementRecordPda,
  namespaceIdFromLabel,
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
const NAMESPACE = findNamespacePda(PROGRAM_ID, PAYER, namespaceIdFromLabel("synxed-demo"))[0];

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
        6,
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
      namespace: NAMESPACE,
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
    const settle = prepared.transaction.instructions.at(-1);
    expect(settle?.keys).toHaveLength(12);
    const [record] = findSettlementRecordPda(PROGRAM_ID, NAMESPACE, eventIdSeed(request().eventId));
    // payer, authority (the payer by default), namespace, source, four
    // destinations, mint, record, system program, token program.
    expect(settle?.keys.slice(0, 4).map((meta) => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable])).toEqual([
      [PAYER.toBase58(), true, true],
      [PAYER.toBase58(), true, false],
      [NAMESPACE.toBase58(), false, false],
      [prepared.sourceTokenAccount.toBase58(), false, true],
    ]);
    expect(settle?.keys[9].pubkey.equals(record)).toBe(true);
  });

  test("signs with a separate namespace authority when one is given", () => {
    const authority = new PublicKey(RECIPIENTS[3]);
    const prepared = buildTokenSettlementNTransaction({
      payer: PAYER,
      request: { ...request(), shares: request().shares.slice(0, 3).map((share, index) => ({ ...share, bps: [4_000, 4_000, 2_000][index] })) },
      mint: MINT,
      decimals: 6,
      programId: PROGRAM_ID,
      namespace: NAMESPACE,
      authority,
    });
    const settle = prepared.transaction.instructions.at(-1);
    expect(settle?.keys[1].pubkey.equals(authority)).toBe(true);
    expect(settle?.keys[1].isSigner).toBe(true);
  });

  test("rejects wrong asset modes, invalid decimals, and a payer recipient", () => {
    expect(() =>
      buildTokenSettlementNTransaction({
        payer: PAYER,
        request: { ...request(), asset: "SOL_LAMPORTS_STANDIN" },
        mint: MINT,
        decimals: 6,
        programId: PROGRAM_ID,
        namespace: NAMESPACE,
      }),
    ).toThrow("requires SPL_STABLECOIN or USDC");
    expect(() =>
      buildSettlementNTransaction({
        payer: PAYER,
        request: request(),
        programId: PROGRAM_ID,
        namespace: NAMESPACE,
      }),
    ).toThrow("native settlement requires SOL_LAMPORTS_STANDIN");
    expect(() =>
      buildTokenSettlementNTransaction({
        payer: PAYER,
        request: request(),
        mint: MINT,
        decimals: 256,
        programId: PROGRAM_ID,
        namespace: NAMESPACE,
      }),
    ).toThrow("token decimals must be an integer in 0..=255");
    try {
      buildTokenSettlementNTransaction({
        payer: new PublicKey(RECIPIENTS[0]),
        request: request(),
        mint: MINT,
        decimals: 6,
        programId: PROGRAM_ID,
        namespace: NAMESPACE,
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
      authority: PAYER.toBase58(),
      namespace: NAMESPACE.toBase58(),
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
      namespace: NAMESPACE,
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
    expect(result.record.schemaVersion).toBe(2);
    expect(result.record.namespace).toBe(NAMESPACE.toBase58());
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
        namespace: NAMESPACE,
        tokenBaseUnitsPerAtomicUnit: 1n,
        mint: MINT,
        decimals: 6,
      }),
    ).toThrow("inner token transfers do not exactly match");
    expect(() =>
      reconcileObservedTokenSettlementN({
        observation,
        request: request(),
        namespace: findNamespacePda(PROGRAM_ID, MINT, namespaceIdFromLabel("synxed-demo"))[0],
        tokenBaseUnitsPerAtomicUnit: 1n,
        mint: MINT,
        decimals: 6,
      }),
    ).toThrow("settled in namespace");
  });
});
