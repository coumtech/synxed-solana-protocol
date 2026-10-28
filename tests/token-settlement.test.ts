import { describe, expect, test } from "bun:test";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  LedgerError,
  MEMO_PROGRAM_ID,
  SETTLE_TOKEN_N_HEADER_LENGTH,
  ProtocolError,
  buildCreateNamespaceInstruction,
  buildSettleTokenNInstruction,
  buildSettlementNTransaction,
  buildTokenSettlementNTransaction,
  encodeSettleTokenNData,
  eventIdSeed,
  findNamespacePda,
  findSettlementRecordPda,
  namespaceIdFromLabel,
  observeProgramTokenSettlement,
  reconcileObservedTokenSettlementN,
  type LedgerErrorCode,
  type ProgramTokenSettlementObservation,
  type SettlementRequestN,
} from "../sdk/typescript/src/index.ts";
import { base58 } from "./base58.ts";

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
    expect(settle?.keys.map((meta) => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable])).toEqual([
      [PAYER.toBase58(), true, true],
      [PAYER.toBase58(), true, false],
      [NAMESPACE.toBase58(), false, false],
      [prepared.sourceTokenAccount.toBase58(), false, true],
      ...prepared.recipientTokenAccounts.map((account) => [account.toBase58(), false, true]),
      [MINT.toBase58(), false, false],
      [record.toBase58(), false, true],
      ["11111111111111111111111111111111", false, false],
      ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", false, false],
    ]);
  });

  test("refuses the record or the namespace as a token destination", () => {
    const [record] = findSettlementRecordPda(PROGRAM_ID, NAMESPACE, eventIdSeed("evt_token_guard"));
    const destinations = RECIPIENTS.map((recipient) => getAssociatedTokenAddressSync(MINT, new PublicKey(recipient)));
    const build = (swap: PublicKey) =>
      buildSettleTokenNInstruction(
        {
          programId: PROGRAM_ID,
          payer: PAYER,
          authority: PAYER,
          namespace: NAMESPACE,
          sourceTokenAccount: getAssociatedTokenAddressSync(MINT, PAYER),
          recipientTokenAccounts: [destinations[0], destinations[1], destinations[2], swap],
          mint: MINT,
        },
        { eventSeed: eventIdSeed("evt_token_guard"), amount: 20_000n, decimals: 6, bps: BPS },
      );
    for (const [swap, code] of [[record, "RECIPIENT_IS_RECORD"], [NAMESPACE, "RECIPIENT_IS_NAMESPACE"]] as const) {
      try {
        build(swap);
        throw new Error(`expected ${code}`);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ProtocolError);
        expect((error as ProtocolError).code).toBe(code);
      }
    }
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

// The token evidence reader, end to end: a parsed transaction built from the
// SDK's own token builder, with an authority separate from the payer and the
// CreateNamespace a first wallet settlement carries.
describe("token settlement evidence", () => {
  const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
  const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const authority = Keypair.generate().publicKey;
  const namespaceId = namespaceIdFromLabel("token-evidence");
  const namespace = findNamespacePda(PROGRAM_ID, PAYER, namespaceId)[0];
  const prepared = buildTokenSettlementNTransaction({
    payer: PAYER,
    authority,
    request: request(),
    mint: MINT,
    decimals: 6,
    programId: PROGRAM_ID,
    namespace,
  });
  const settle = prepared.transaction.instructions.at(-1);
  if (settle === undefined) throw new Error("no settlement instruction");
  const record = settle.keys[9].pubkey.toBase58();
  const createIx = buildCreateNamespaceInstruction(
    { programId: PROGRAM_ID, payer: PAYER, creator: PAYER },
    { namespaceId, authority },
  );

  // Every instruction as getParsedTransaction returns it; `createCount`
  // CreateNamespace instructions lead, each with its own rent transfer.
  function parsed(options: { createCount?: number; settleAccounts?: PublicKey[] } = {}): ParsedTransactionWithMeta {
    const createCount = options.createCount ?? 1;
    const top: unknown[] = [];
    const inner: { index: number; instructions: unknown[] }[] = [];
    for (let i = 0; i < createCount; i += 1) {
      inner.push({
        index: top.length,
        instructions: [{
          parsed: { type: "transfer", info: { source: PAYER.toBase58(), destination: namespace.toBase58(), lamports: 1_148_080 } },
          program: "system",
          programId: SYSTEM_PROGRAM,
        }],
      });
      top.push({ accounts: createIx.keys.map((meta) => meta.pubkey), data: base58(createIx.data), programId: PROGRAM_ID });
    }
    for (const ix of prepared.transaction.instructions) {
      if (ix === settle) {
        inner.push({
          index: top.length,
          instructions: [
            {
              parsed: { type: "transfer", info: { source: PAYER.toBase58(), destination: record, lamports: 858_520 } },
              program: "system",
              programId: SYSTEM_PROGRAM,
            },
            ...prepared.recipientTokenAccounts.map((destination, index) => ({
              parsed: {
                type: "transferChecked",
                info: {
                  source: prepared.sourceTokenAccount.toBase58(),
                  destination: destination.toBase58(),
                  mint: MINT.toBase58(),
                  authority: PAYER.toBase58(),
                  tokenAmount: { amount: String(prepared.tokenAmountsByShare[index]), decimals: 6 },
                },
              },
              program: "spl-token",
              programId: TOKEN_PROGRAM,
            })),
          ],
        });
        top.push({
          accounts: options.settleAccounts ?? ix.keys.map((meta) => meta.pubkey),
          data: base58(ix.data),
          programId: PROGRAM_ID,
        });
      } else if (ix.programId.equals(MEMO_PROGRAM_ID)) {
        top.push({ parsed: ix.data.toString("utf8"), program: "spl-memo", programId: ix.programId });
      } else {
        top.push({ parsed: { type: "createIdempotent", info: {} }, program: "spl-associated-token-account", programId: ix.programId });
      }
    }
    return {
      slot: 1,
      blockTime: 1_790_000_000,
      transaction: { signatures: ["token-evidence"], message: { accountKeys: [], recentBlockhash: "x", instructions: top } },
      meta: { err: null, innerInstructions: inner },
    } as unknown as ParsedTransactionWithMeta;
  }

  function expectLedgerCode(fn: () => unknown, code: LedgerErrorCode): void {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe(code);
      return;
    }
    throw new Error(`expected LedgerError ${code}, but nothing was thrown`);
  }

  test("reads every account of the n + 8 layout and reconciles", () => {
    const observed = observeProgramTokenSettlement(parsed(), "token-evidence", PROGRAM_ID);
    expect(observed.payer).toBe(PAYER.toBase58());
    expect(observed.authority).toBe(authority.toBase58());
    expect(observed.namespace).toBe(namespace.toBase58());
    expect(observed.sourceTokenAccount).toBe(prepared.sourceTokenAccount.toBase58());
    expect(observed.recipientTokenAccounts).toEqual(prepared.recipientTokenAccounts.map((account) => account.toBase58()));
    expect(observed.mint).toBe(MINT.toBase58());
    expect(observed.record).toBe(record);
    expect(observed.amountOnChain).toBe(20_000n);
    const result = reconcileObservedTokenSettlementN({
      observation: observed,
      request: request(),
      namespace,
      tokenBaseUnitsPerAtomicUnit: 1n,
      mint: MINT,
      decimals: 6,
    });
    expect(result.record.schemaVersion).toBe(2);
    expect(result.record.authority).toBe(authority.toBase58());
    expect(result.record.payer).toBe(PAYER.toBase58());
    expect(result.record.namespace).toBe(namespace.toBase58());
    expect(result.record.settlementRecord).toBe(record);
  });

  test("refuses a record that is not derived from the namespace in the instruction", () => {
    const other = findNamespacePda(PROGRAM_ID, MINT, namespaceId)[0];
    const accounts = settle.keys.map((meta) => meta.pubkey);
    accounts[2] = other;
    // No CreateNamespace here: one for the original namespace would be
    // refused first, as the next test shows.
    expectLedgerCode(
      () =>
        observeProgramTokenSettlement(
          parsed({ createCount: 0, settleAccounts: accounts }),
          "token-evidence",
          PROGRAM_ID,
        ),
      "ACCOUNT_LAYOUT",
    );
  });

  test("refuses a CreateNamespace for a namespace other than the settlement's", () => {
    // The settlement and its record move to another namespace; the
    // CreateNamespace beside it still opens the original one.
    const other = findNamespacePda(PROGRAM_ID, MINT, namespaceId)[0];
    const accounts = settle.keys.map((meta) => meta.pubkey);
    accounts[2] = other;
    accounts[9] = findSettlementRecordPda(PROGRAM_ID, other, eventIdSeed(request().eventId))[0];
    expectLedgerCode(
      () => observeProgramTokenSettlement(parsed({ settleAccounts: accounts }), "token-evidence", PROGRAM_ID),
      "PROGRAM_INSTRUCTION",
    );
    expect(() =>
      observeProgramTokenSettlement(
        parsed({ createCount: 0, settleAccounts: accounts }),
        "token-evidence",
        PROGRAM_ID,
      ),
    ).not.toThrow();
  });

  test("allows one CreateNamespace beside the settlement, not two", () => {
    expect(() => observeProgramTokenSettlement(parsed({ createCount: 0 }), "token-evidence", PROGRAM_ID)).not.toThrow();
    expectLedgerCode(
      () => observeProgramTokenSettlement(parsed({ createCount: 2 }), "token-evidence", PROGRAM_ID),
      "PROGRAM_INSTRUCTION",
    );
  });
});
