import { describe, expect, test } from "bun:test";
import {
  PublicKey,
  type ConfirmedSignatureInfo,
  type Connection,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import {
  LedgerError,
  allocatePoolPayout,
  assertLedgerCluster,
  encodeSettleNData,
  encodeSettleTokenNData,
  eventIdSeed,
  findLegacySettlementRecordPda,
  findLegacySettlementTransaction,
  findNamespacePda,
  findSettlementRecordPda,
  findSettlementTransaction,
  namespaceIdFromLabel,
  observeProgramSettlement,
  reconcileObservedSettlementN,
  type LedgerErrorCode,
  type ProgramSettlementObservation,
  type SettlementRequestN,
} from "../sdk/typescript/src/index.ts";

const PAYER = "6k3KRgAuv4CwanjLGwYH1rzwTeZwSRbeLETHfen4h51s";
// The namespace authority, deliberately not the payer.
const AUTHORITY = "48fB8mLhZJNZxVjyebuEhu5nvKPSyM31asQE6kkjqhA9";
// The record of the pre-namespace reference transaction below.
const LEGACY_RECORD = "4xrJM7aoaSkbmzXRgARZP8WSBzdd1nqrSqk45KJhE7n3";
const RECIPIENTS = [
  "6AF4DwckLZ7pxwWYarmJx5Sk6dyziagHNoDA8CJpDQa5",
  "EfKS8o2pDsHAJUKQQ3evE5m6PgYR7rxEYvGQavk2y1Da",
  "GJ7JUe6w6DktBDBPKGWNzhJUhRRFExJqb2hrtdsQFX7s",
  "48fB8mLhZJNZxVjyebuEhu5nvKPSyM31asQE6kkjqhA9",
] as const;
const BPS = [3_500, 3_500, 2_000, 1_000] as const;
const AMOUNTS = [7_000_000n, 7_000_000n, 4_000_000n, 2_000_000n] as const;
const EVENT_ID = "evt_ledger_reconciliation";
const PROGRAM_ID = new PublicKey("HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT");
const NAMESPACE = findNamespacePda(
  PROGRAM_ID,
  new PublicKey(PAYER),
  namespaceIdFromLabel("synxed-demo"),
)[0];
const RECORD = findSettlementRecordPda(PROGRAM_ID, NAMESPACE, eventIdSeed(EVENT_ID))[0].toBase58();
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// RPC instruction data is base58; a small encoder keeps the test independent
// of the SDK's own bs58 dependency.
function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function request(): SettlementRequestN {
  return {
    eventId: EVENT_ID,
    occurredAt: "2026-09-12T08:00:00.000Z",
    kind: "audio_ad_impression",
    amountAtomic: 20_000n,
    asset: "SOL_LAMPORTS_STANDIN",
    shares: [
      { label: "artist", recipient: RECIPIENTS[0], bps: BPS[0] },
      { label: "studio", recipient: RECIPIENTS[1], bps: BPS[1] },
      { label: "synxed", recipient: RECIPIENTS[2], bps: BPS[2] },
      { label: "rewards_pool", recipient: RECIPIENTS[3], bps: BPS[3] },
    ],
    memo: "ledger reconciliation test",
  };
}

function observation(): ProgramSettlementObservation {
  return {
    signature: "ledger-test-signature",
    slot: 500_000_000,
    blockTime: 1_789_200_000,
    programId: PROGRAM_ID.toBase58(),
    payer: PAYER,
    authority: AUTHORITY,
    namespace: NAMESPACE.toBase58(),
    record: RECORD,
    eventSeedHex: toHex(eventIdSeed(EVENT_ID)),
    amountOnChain: 20_000_000n,
    bps: BPS,
    recipients: RECIPIENTS,
    transfers: [
      { source: PAYER, destination: RECORD, amountOnChain: 1_070_277n },
      ...RECIPIENTS.map((destination, index) => ({
        source: PAYER,
        destination,
        amountOnChain: AMOUNTS[index],
      })),
    ],
    memo: {
      protocol: "synxed-settlement",
      event: EVENT_ID,
      occurredAt: "2026-09-12T08:00:00.000Z",
      kind: "audio_ad_impression",
      asset: "SOL_LAMPORTS_STANDIN",
      lamports: "20000000",
      memo: "ledger reconciliation test",
    },
  };
}

describe("ledger reconciliation", () => {
  test("checks RPC cluster identity before wallet signing", async () => {
    await expect(
      assertLedgerCluster({
        getGenesisHash: async () =>
          "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      }),
    ).rejects.toMatchObject({ code: "CLUSTER_MISMATCH" });
  });

  // A parsed RPC transaction in the shape getParsedTransaction returns.
  // `leading` instructions come first; the memo and the settlement follow.
  function parsedSettlement(
    accounts: readonly PublicKey[],
    data: string,
    memo: Readonly<Record<string, unknown>>,
    leading: readonly unknown[] = [],
    leadingInner: ReadonlyArray<{ index: number; instructions: unknown[] }> = [],
  ): ParsedTransactionWithMeta {
    const settleIndex = leading.length + 1;
    return {
      slot: 491_725_036,
      blockTime: 1_788_310_318,
      transaction: {
        signatures: ["fixture-signature"],
        message: {
          accountKeys: [],
          recentBlockhash: "fixture",
          instructions: [
            ...leading,
            {
              parsed: JSON.stringify(memo),
              program: "spl-memo",
              programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
            },
            { accounts: [...accounts], data, programId: PROGRAM_ID },
          ],
        },
      },
      meta: {
        err: null,
        innerInstructions: [
          ...leadingInner,
          {
            index: settleIndex,
            instructions: RECIPIENTS.map((destination, index) => ({
              parsed: {
                info: { destination, lamports: Number(AMOUNTS[index]), source: PAYER },
                type: "transfer",
              },
              program: "system",
              programId: SYSTEM_PROGRAM,
            })),
          },
        ],
      },
    } as unknown as ParsedTransactionWithMeta;
  }

  const settleNData = base58(
    encodeSettleNData({ eventSeed: eventIdSeed(EVENT_ID), amount: 20_000_000n, bps: BPS }),
  );
  const settleNAccounts = (namespace: PublicKey = NAMESPACE): PublicKey[] => [
    new PublicKey(PAYER),
    new PublicKey(AUTHORITY),
    namespace,
    ...RECIPIENTS.map((recipient) => new PublicKey(recipient)),
    new PublicKey(RECORD),
    SYSTEM_PROGRAM,
  ];
  const otherNamespace = findNamespacePda(PROGRAM_ID, SYSTEM_PROGRAM, new Uint8Array(32))[0];

  test("extracts SettleN evidence, with the authority and namespace", () => {
    const observed = observeProgramSettlement(
      parsedSettlement(settleNAccounts(), settleNData, observation().memo),
      "fixture-signature",
      PROGRAM_ID,
    );
    expect(observed.amountOnChain).toBe(20_000_000n);
    expect(observed.bps).toEqual(BPS);
    expect(observed.recipients).toEqual(RECIPIENTS);
    expect(observed.payer).toBe(PAYER);
    expect(observed.authority).toBe(AUTHORITY);
    expect(observed.namespace).toBe(NAMESPACE.toBase58());
    expect(observed.record).toBe(RECORD);
    expect(observed.transfers.map((transfer) => transfer.amountOnChain)).toEqual(
      [...AMOUNTS],
    );
    const reconciled = reconcileObservedSettlementN({
      observation: observed,
      request: request(),
      namespace: NAMESPACE,
      unitsPerAtomicUnit: 1_000n,
    });
    expect(reconciled.record.namespace).toBe(NAMESPACE.toBase58());
  });

  test("reads a first wallet settlement that also opens the namespace", () => {
    const createNamespace = {
      accounts: [new PublicKey(PAYER), new PublicKey(PAYER), NAMESPACE, SYSTEM_PROGRAM],
      data: base58(Uint8Array.from([3, ...namespaceIdFromLabel("synxed-demo"), ...new PublicKey(PAYER).toBytes()])),
      programId: PROGRAM_ID,
    };
    // CreateNamespace carries its own inner rent transfer, which is not a payout.
    const rent = {
      index: 0,
      instructions: [{
        parsed: { info: { destination: NAMESPACE.toBase58(), lamports: 1_148_080, source: PAYER }, type: "transfer" },
        program: "system",
        programId: SYSTEM_PROGRAM,
      }],
    };
    const observed = observeProgramSettlement(
      parsedSettlement(settleNAccounts(), settleNData, observation().memo, [createNamespace], [rent]),
      "fixture-signature",
      PROGRAM_ID,
    );
    expect(observed.transfers.map((transfer) => transfer.amountOnChain)).toEqual([...AMOUNTS]);
    const reconciled = reconcileObservedSettlementN({
      observation: observed,
      request: request(),
      namespace: NAMESPACE,
      unitsPerAtomicUnit: 1_000n,
    });
    expect(reconciled.record.signature).toBe("fixture-signature");
  });

  test("refuses a second settlement or a rotation in the same transaction", () => {
    const secondSettlement = { accounts: settleNAccounts(), data: settleNData, programId: PROGRAM_ID };
    const rotation = {
      accounts: [new PublicKey(PAYER), NAMESPACE],
      data: base58(Uint8Array.from([4, ...SYSTEM_PROGRAM.toBytes().map((_, i) => i + 1)])),
      programId: PROGRAM_ID,
    };
    for (const extra of [secondSettlement, rotation]) {
      expectLedgerCode(
        () =>
          observeProgramSettlement(
            parsedSettlement(settleNAccounts(), settleNData, observation().memo, [extra]),
            "fixture-signature",
            PROGRAM_ID,
          ),
        "PROGRAM_INSTRUCTION",
      );
    }
  });

  test("refuses a CreateNamespace for a namespace other than the settlement's", () => {
    const createOther = {
      accounts: [new PublicKey(PAYER), new PublicKey(PAYER), otherNamespace, SYSTEM_PROGRAM],
      data: base58(Uint8Array.from([3, ...new Uint8Array(32), ...new PublicKey(PAYER).toBytes()])),
      programId: PROGRAM_ID,
    };
    expectLedgerCode(
      () =>
        observeProgramSettlement(
          parsedSettlement(settleNAccounts(), settleNData, observation().memo, [createOther]),
          "fixture-signature",
          PROGRAM_ID,
        ),
      "PROGRAM_INSTRUCTION",
    );
  });

  test("refuses a record that is not derived from the namespace in the instruction", () => {
    expectLedgerCode(
      () =>
        observeProgramSettlement(
          parsedSettlement(settleNAccounts(otherNamespace), settleNData, observation().memo),
          "fixture-signature",
          PROGRAM_ID,
        ),
      "ACCOUNT_LAYOUT",
    );
  });

  test("refuses a settlement made with a retired instruction", () => {
    // The finalized devnet reference transaction from before namespaces: tag 1,
    // payer, four recipients, record, system program.
    const legacyData = "2RWubWCVYD4cdnLHpRJR1E417pZE1tKuSLFWKrYD7Zdn6cFw3z54ihSvmfeXhy7ds6eW";
    const legacy = parsedSettlement(
      [
        new PublicKey(PAYER),
        ...RECIPIENTS.map((recipient) => new PublicKey(recipient)),
        new PublicKey(LEGACY_RECORD),
        SYSTEM_PROGRAM,
      ],
      legacyData,
      {
        protocol: "synxed-settlement",
        event: "evt_bd2961e0-1019-42e0-a9f7-ceb6928ad6af",
        occurredAt: "2026-09-02T00:51:58.000Z",
        kind: "audio_ad_impression",
        asset: "SOL_LAMPORTS_STANDIN",
        lamports: "20000000",
        memo: "audio ad in Skyline Runners (4-way)",
      },
    );
    expectLedgerCode(
      () => observeProgramSettlement(legacy, "fixture-signature", PROGRAM_ID),
      "INSTRUCTION_DATA",
    );
  });

  test("refuses evidence from another namespace", () => {
    expectLedgerCode(
      () =>
        reconcileObservedSettlementN({
          observation: observation(),
          request: request(),
          namespace: otherNamespace,
          unitsPerAtomicUnit: 1_000n,
        }),
      "NAMESPACE_MISMATCH",
    );
  });

  test("reconciles the 35/35/20/10 split into direct and pooled rows", () => {
    const result = reconcileObservedSettlementN({
      observation: observation(),
      request: request(),
      namespace: NAMESPACE,
      unitsPerAtomicUnit: 1_000n,
      beneficiaryIds: {
        artist: "artist:demo",
        studio: "studio:demo",
        synxed: "platform:synxed",
      },
    });

    expect(result.record.payouts.map((line) => line.amountOnChain)).toEqual([
      "7000000",
      "7000000",
      "4000000",
      "2000000",
    ]);
    expect(result.record.schemaVersion).toBe(2);
    expect(result.record.programId).toBe(PROGRAM_ID.toBase58());
    expect(result.record.namespace).toBe(NAMESPACE.toBase58());
    expect(result.record.authority).toBe(AUTHORITY);
    expect(result.record.payer).toBe(PAYER);
    expect(result.record.settlementRecord).toBe(RECORD);
    expect(result.record.payouts.map((line) => line.role)).toEqual([
      "artist",
      "studio",
      "platform",
      "rewards_pool",
    ]);
    expect(result.directEntries).toHaveLength(3);
    expect(result.directEntries.every((entry) => entry.state === "paid")).toBe(true);
    expect(result.poolPayouts).toEqual([result.record.payouts[3]]);
  });

  test("fails closed on changed amounts, recipients, memo, or transfers", () => {
    const base = observation();
    const cases: Array<readonly [ProgramSettlementObservation, LedgerErrorCode]> = [
      [{ ...base, amountOnChain: base.amountOnChain + 1n }, "AMOUNT_MISMATCH"],
      [
        { ...base, recipients: [...base.recipients].reverse() },
        "RECIPIENT_MISMATCH",
      ],
      [{ ...base, memo: { ...base.memo, event: "wrong" } }, "MEMO_MISMATCH"],
      [{ ...base, transfers: base.transfers.slice(0, -1) }, "TRANSFER_MISMATCH"],
    ];
    for (const [changed, code] of cases) {
      expect(() =>
        reconcileObservedSettlementN({
          observation: changed,
          request: request(),
          namespace: NAMESPACE,
          unitsPerAtomicUnit: 1_000n,
        }),
      ).toThrow(LedgerError);
      try {
        reconcileObservedSettlementN({
          observation: changed,
          request: request(),
          namespace: NAMESPACE,
          unitsPerAtomicUnit: 1_000n,
        });
      } catch (error) {
        expect((error as LedgerError).code).toBe(code);
      }
    }
  });

  test("rejects non-conserving or duplicate pool allocations", () => {
    const result = reconcileObservedSettlementN({
      observation: observation(),
      request: request(),
      namespace: NAMESPACE,
      unitsPerAtomicUnit: 1_000n,
    });
    const pool = result.poolPayouts[0];
    expect(() =>
      allocatePoolPayout(pool, result.record.signature, [
        { beneficiaryId: "listener:1", amountOnChain: 1_000_000n },
      ]),
    ).toThrow(LedgerError);
    expect(() =>
      allocatePoolPayout(pool, result.record.signature, [
        { beneficiaryId: "listener:1", amountOnChain: 1_000_000n },
        { beneficiaryId: "listener:1", amountOnChain: 1_000_000n },
      ]),
    ).toThrow(LedgerError);
  });

  test("creates deterministic accrued rows for a conserved pool allocation", () => {
    const result = reconcileObservedSettlementN({
      observation: observation(),
      request: request(),
      namespace: NAMESPACE,
      unitsPerAtomicUnit: 1_000n,
    });
    const entries = allocatePoolPayout(
      result.poolPayouts[0],
      result.record.signature,
      [
        { beneficiaryId: "listener:1", amountOnChain: 1_250_000n },
        {
          beneficiaryId: "listener:2",
          wallet: RECIPIENTS[0],
          amountOnChain: 750_000n,
        },
      ],
    );
    expect(entries.map((entry) => entry.state)).toEqual(["accrued", "accrued"]);
    expect(entries.reduce((sum, entry) => sum + BigInt(entry.amountOnChain), 0n)).toBe(
      2_000_000n,
    );
    expect(entries[0].entryId).not.toBe(entries[1].entryId);
  });

  describe("finding the transaction that created a record", () => {
    interface HistoryEntry {
      signature: string;
      err: unknown;
      transaction: ParsedTransactionWithMeta | null;
    }

    function signed(transaction: ParsedTransactionWithMeta, signature: string): ParsedTransactionWithMeta {
      return {
        ...transaction,
        transaction: { ...transaction.transaction, signatures: [signature] },
      } as ParsedTransactionWithMeta;
    }

    // A plain lamport transfer to the record address, which anyone can send.
    function deposit(signature: string, destination: string): ParsedTransactionWithMeta {
      return {
        slot: 491_725_000,
        blockTime: 1_788_310_000,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: [],
            recentBlockhash: "fixture",
            instructions: [{
              parsed: { info: { destination, lamports: 890_880, source: PAYER }, type: "transfer" },
              program: "system",
              programId: SYSTEM_PROGRAM,
            }],
          },
        },
        meta: { err: null, innerInstructions: [] },
      } as unknown as ParsedTransactionWithMeta;
    }

    /**
     * Answers the record's history calls from `history`, newest first, logs the
     * signature pages in `calls`, and counts transaction requests in `fetches`.
     */
    function historyConnection(
      history: readonly HistoryEntry[],
      calls: { address: string; limit: number; before?: string; commitment?: string }[] = [],
      fetches: { requests: number; singles?: number; configs?: unknown[]; failSingles?: boolean } = { requests: 0 },
      // How batches are answered: in order, reversed (JSON-RPC allows any
      // order, and the public devnet endpoint uses it), refused, or with one
      // answer missing and the batch short (a pruned or lagging backend).
      batches: "in-order" | "reversed" | "refused" | "partial" = "in-order",
    ): Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions" | "getParsedTransaction"> {
      const configs = (fetches.configs ??= []);
      const lookup = (signature: string) => history.find((entry) => entry.signature === signature)?.transaction ?? null;
      return {
        getSignaturesForAddress: async (address, options, commitment) => {
          const limit = options?.limit ?? 1_000;
          const start = options?.before === undefined
            ? 0
            : history.findIndex((entry) => entry.signature === options.before) + 1;
          calls.push({
            address: address.toBase58(),
            limit,
            ...(options?.before !== undefined ? { before: options.before } : {}),
            ...(commitment !== undefined ? { commitment } : {}),
          });
          return history.slice(start, start + limit).map((entry, index) => ({
            signature: entry.signature,
            slot: 491_725_036 - start - index,
            err: entry.err,
            memo: null,
            blockTime: null,
          })) as ConfirmedSignatureInfo[];
        },
        getParsedTransactions: async (signatures: string[], config?: unknown) => {
          // Asserted after the call: the finder catches a throw here and falls
          // back, which would hide the assertion.
          configs.push(config);
          fetches.requests += 1;
          if (batches === "refused") {
            throw new Error("failed to get transactions: Too many requests for a specific RPC call");
          }
          const answers: (ParsedTransactionWithMeta | null)[] = signatures.map(lookup);
          if (batches === "partial") {
            // One answer missing (null), and one request not answered at all.
            answers[0] = null;
            answers.length = 2;
          }
          return batches === "reversed" ? answers.reverse() : answers;
        },
        getParsedTransaction: async (signature: string, config?: unknown) => {
          configs.push(config);
          fetches.singles = (fetches.singles ?? 0) + 1;
          if (fetches.failSingles === true) {
            throw new Error("429 Too Many Requests: Too many requests for a specific RPC call");
          }
          return lookup(signature);
        },
      } as Pick<Connection, "getSignaturesForAddress" | "getParsedTransactions" | "getParsedTransaction">;
    }

    const settlement = (signature: string) =>
      signed(parsedSettlement(settleNAccounts(), settleNData, observation().memo), signature);

    test("finds the one settlement among a failed retry and a deposit", async () => {
      const calls: { address: string; limit: number; before?: string; commitment?: string }[] = [];
      const found = await findSettlementTransaction({
        connection: historyConnection(
          [
            { signature: "failed-retry", err: { InstructionError: [1, { Custom: 0 }] }, transaction: null },
            { signature: "settled", err: null, transaction: settlement("settled") },
            { signature: "deposit", err: null, transaction: deposit("deposit", RECORD) },
          ],
          calls,
        ),
        programId: PROGRAM_ID,
        namespace: NAMESPACE,
        eventId: EVENT_ID,
      });
      expect(found).toEqual({ signature: "settled", slot: 491_725_036, topLevel: true });
      expect(calls).toEqual([{ address: RECORD, limit: 1_000, commitment: "finalized" }]);
    });

    test("finds a settlement another program invoked, and says so", async () => {
      const invoked = signed(parsedSettlement(settleNAccounts(), settleNData, observation().memo), "invoked");
      const message = invoked.transaction.message;
      const settle = message.instructions.at(-1);
      // A multisig program's instruction stands where the settlement was, and
      // the settlement runs inside it. Any other program id stands in for it.
      const multisig = { accounts: [], data: "1", programId: new PublicKey(RECIPIENTS[0]) };
      const wrapped = {
        ...invoked,
        transaction: {
          ...invoked.transaction,
          message: { ...message, instructions: [...message.instructions.slice(0, -1), multisig] },
        },
        // An earlier instruction invoked another program first, so the
        // settlement sits in a later inner group.
        meta: {
          ...invoked.meta,
          innerInstructions: [
            { index: 0, instructions: [deposit("unrelated", RECIPIENTS[2]).transaction.message.instructions[0]] },
            { index: message.instructions.length - 1, instructions: [settle] },
          ],
        },
      } as unknown as ParsedTransactionWithMeta;
      const found = await findSettlementTransaction({
        connection: historyConnection([{ signature: "invoked", err: null, transaction: wrapped }]),
        programId: PROGRAM_ID,
        namespace: NAMESPACE,
        eventId: EVENT_ID,
      });
      expect(found.topLevel).toBe(false);
    });

    test("treats a decoy inner invocation as a second candidate, not as the settlement", async () => {
      // A program can invoke the settlement program and ignore its error. The
      // endpoint lists the failed invocation in meta.innerInstructions with no
      // per-instruction status, so it looks like a settlement here. It cannot
      // move funds, but it must not pass as the record's one creator either.
      const decoy = signed(parsedSettlement(settleNAccounts(), settleNData, observation().memo), "decoy");
      const message = decoy.transaction.message;
      const settle = message.instructions.at(-1);
      const wrapped = {
        ...decoy,
        transaction: {
          ...decoy.transaction,
          message: {
            ...message,
            instructions: [
              ...message.instructions.slice(0, -1),
              { accounts: [], data: "1", programId: new PublicKey(RECIPIENTS[0]) },
            ],
          },
        },
        meta: { ...decoy.meta, innerInstructions: [{ index: 1, instructions: [settle] }] },
      } as unknown as ParsedTransactionWithMeta;
      await expect(
        findSettlementTransaction({
          connection: historyConnection([
            { signature: "decoy", err: null, transaction: wrapped },
            { signature: "settled", err: null, transaction: settlement("settled") },
          ]),
          programId: PROGRAM_ID,
          namespace: NAMESPACE,
          eventId: EVENT_ID,
        }),
      ).rejects.toMatchObject({ code: "RECORD_HISTORY" });
    });

    test("refuses a history with no settlement, two settlements, or a missing transaction", async () => {
      const cases: HistoryEntry[][] = [
        [{ signature: "deposit", err: null, transaction: deposit("deposit", RECORD) }],
        [
          { signature: "one", err: null, transaction: settlement("one") },
          { signature: "two", err: null, transaction: settlement("two") },
        ],
        [{ signature: "pruned", err: null, transaction: null }],
        // An RPC answer for a different signature than the one asked for.
        [{ signature: "asked", err: null, transaction: settlement("answered") }],
      ];
      for (const history of cases) {
        await expect(
          findSettlementTransaction({
            connection: historyConnection(history),
            programId: PROGRAM_ID,
            namespace: NAMESPACE,
            eventId: EVENT_ID,
          }),
        ).rejects.toMatchObject({ code: "RECORD_HISTORY" });
      }
    });

    test("does not count a settlement in another namespace or of another event", async () => {
      const otherEvent = base58(
        encodeSettleNData({ eventSeed: eventIdSeed("evt_other"), amount: 20_000_000n, bps: BPS }),
      );
      const cases = [
        signed(parsedSettlement(settleNAccounts(otherNamespace), settleNData, observation().memo), "elsewhere"),
        signed(parsedSettlement(settleNAccounts(), otherEvent, observation().memo), "elsewhere"),
      ];
      for (const transaction of cases) {
        await expect(
          findSettlementTransaction({
            connection: historyConnection([{ signature: "elsewhere", err: null, transaction }]),
            programId: PROGRAM_ID,
            namespace: NAMESPACE,
            eventId: EVENT_ID,
          }),
        ).rejects.toMatchObject({ code: "RECORD_HISTORY" });
      }
    });

    test("pages through a long history, and stops at maxSignatures", async () => {
      const failures: HistoryEntry[] = Array.from({ length: 1_200 }, (_, index) => ({
        signature: `failed-${index}`,
        err: { InstructionError: [1, { Custom: 0 }] },
        transaction: null,
      }));
      const history = [...failures, { signature: "settled", err: null, transaction: settlement("settled") }];
      const calls: { address: string; limit: number; before?: string; commitment?: string }[] = [];
      const found = await findSettlementTransaction({
        connection: historyConnection(history, calls),
        programId: PROGRAM_ID,
        namespace: NAMESPACE,
        eventId: EVENT_ID,
      });
      expect(found.signature).toBe("settled");
      expect(calls.map((call) => [call.limit, call.before])).toEqual([
        [1_000, undefined],
        [1_000, "failed-999"],
      ]);
      await expect(
        findSettlementTransaction({
          connection: historyConnection(history),
          programId: PROGRAM_ID,
          namespace: NAMESPACE,
          eventId: EVENT_ID,
          maxSignatures: 1_100,
        }),
      ).rejects.toMatchObject({ code: "RECORD_HISTORY" });
    });

    test("pages past a failed entry at the end of a page", async () => {
      // The cursor is the page's oldest entry, whatever its status. Taking it
      // from the last successful entry re-reads the failed tail and can trip
      // the maxSignatures cap early.
      const page: HistoryEntry[] = Array.from({ length: 999 }, (_, index) => ({
        signature: `deposit-${index}`,
        err: null,
        transaction: deposit(`deposit-${index}`, RECORD),
      }));
      const history = [
        ...page,
        { signature: "failed-oldest", err: { InstructionError: [1, { Custom: 0 }] }, transaction: null },
        { signature: "settled", err: null, transaction: settlement("settled") },
      ] as HistoryEntry[];
      const calls: { address: string; limit: number; before?: string; commitment?: string }[] = [];
      const found = await findSettlementTransaction({
        connection: historyConnection(history, calls),
        programId: PROGRAM_ID,
        namespace: NAMESPACE,
        eventId: EVENT_ID,
      });
      expect(found.signature).toBe("settled");
      expect(calls.map((call) => call.before)).toEqual([undefined, "failed-oldest"]);
    });

    test("skips a transaction without meta, and instruction data that is not base58", async () => {
      const noMeta = { ...settlement("no-meta"), meta: null } as unknown as ParsedTransactionWithMeta;
      const badData = signed(parsedSettlement(settleNAccounts(), "0OIl", observation().memo), "bad-data");
      for (const transaction of [noMeta, badData]) {
        await expect(
          findSettlementTransaction({
            connection: historyConnection([
              { signature: transaction.transaction.signatures[0], err: null, transaction },
            ]),
            programId: PROGRAM_ID,
            namespace: NAMESPACE,
            eventId: EVENT_ID,
          }),
        ).rejects.toMatchObject({ code: "RECORD_HISTORY" });
      }
    });

    test("does not count a lookalike from another program, or a transaction the RPC marks failed", async () => {
      // Anyone can send a no-op program the settlement's data and accounts.
      const lookalike = signed(parsedSettlement(settleNAccounts(), settleNData, observation().memo), "lookalike");
      const message = lookalike.transaction.message;
      const noop = {
        ...lookalike,
        transaction: {
          ...lookalike.transaction,
          message: {
            ...message,
            instructions: message.instructions.map((instruction, index) =>
              index === message.instructions.length - 1
                ? { ...instruction, programId: new PublicKey(RECIPIENTS[1]) }
                : instruction,
            ),
          },
        },
      } as ParsedTransactionWithMeta;
      // The signature list says it succeeded; the transaction says it failed.
      const failed = signed(parsedSettlement(settleNAccounts(), settleNData, observation().memo), "failed");
      const failedInMeta = {
        ...failed,
        meta: { ...failed.meta, err: { InstructionError: [1, { Custom: 0 }] } },
      } as unknown as ParsedTransactionWithMeta;
      for (const decoy of [noop, failedInMeta]) {
        const signature = decoy.transaction.signatures[0];
        await expect(
          findSettlementTransaction({
            connection: historyConnection([{ signature, err: null, transaction: decoy }]),
            programId: PROGRAM_ID,
            namespace: NAMESPACE,
            eventId: EVENT_ID,
          }),
        ).rejects.toMatchObject({ code: "RECORD_HISTORY" });
        const found = await findSettlementTransaction({
          connection: historyConnection([
            { signature, err: null, transaction: decoy },
            { signature: "settled", err: null, transaction: settlement("settled") },
          ]),
          programId: PROGRAM_ID,
          namespace: NAMESPACE,
          eventId: EVENT_ID,
        });
        expect(found.signature).toBe("settled");
      }
    });

    test("matches a batch's answers by signature, and fetches refused or missing answers one by one", async () => {
      // The settlement is newest, so reversing the answers moves it away from
      // its request position: positional matching then misses it entirely.
      const history: HistoryEntry[] = [
        { signature: "settled", err: null, transaction: settlement("settled") },
        { signature: "deposit-2", err: null, transaction: deposit("deposit-2", RECORD) },
        { signature: "deposit-1", err: null, transaction: deposit("deposit-1", RECORD) },
      ];
      const cases = [
        ["in-order", 0],
        ["reversed", 0],
        ["refused", history.length],
        ["partial", 2],
      ] as const;
      for (const [batches, singles] of cases) {
        const fetches: { requests: number; singles?: number; configs?: unknown[] } = { requests: 0, singles: 0 };
        const found = await findSettlementTransaction({
          connection: historyConnection(history, [], fetches, batches),
          programId: PROGRAM_ID,
          namespace: NAMESPACE,
          eventId: EVENT_ID,
        });
        expect(found.signature).toBe("settled");
        // Reordered answers are all used; refused and missing ones are
        // fetched singly.
        expect(fetches.singles).toBe(singles);
        // Every request, batch or single, is finalized and v0.
        expect(fetches.configs?.length).toBeGreaterThan(0);
        for (const config of fetches.configs ?? []) {
          expect(config).toEqual({ commitment: "finalized", maxSupportedTransactionVersion: 0 });
        }
      }
    });

    test("reports an unresolved history when a single fetch is throttled", async () => {
      const history: HistoryEntry[] = [
        { signature: "settled", err: null, transaction: settlement("settled") },
        { signature: "deposit", err: null, transaction: deposit("deposit", RECORD) },
      ];
      const fetches = { requests: 0, singles: 0, failSingles: true };
      await expect(
        findSettlementTransaction({
          connection: historyConnection(history, [], fetches, "partial"),
          programId: PROGRAM_ID,
          namespace: NAMESPACE,
          eventId: EVENT_ID,
        }),
      ).rejects.toMatchObject({ code: "RECORD_HISTORY" });
    });

    test("fetches a spammed history in batches, not one request per transaction", async () => {
      const deposits: HistoryEntry[] = Array.from({ length: 250 }, (_, index) => ({
        signature: `deposit-${index}`,
        err: null,
        transaction: deposit(`deposit-${index}`, RECORD),
      }));
      const fetches = { requests: 0 };
      const found = await findSettlementTransaction({
        connection: historyConnection(
          [...deposits, { signature: "settled", err: null, transaction: settlement("settled") }],
          [],
          fetches,
        ),
        programId: PROGRAM_ID,
        namespace: NAMESPACE,
        eventId: EVENT_ID,
      });
      expect(found.signature).toBe("settled");
      expect(fetches.requests).toBe(3);
    });

    test("finds the retired instruction that created a legacy record", async () => {
      // The devnet reference settlement from before namespaces (tag 1).
      const legacy = signed(
        parsedSettlement(
          [
            new PublicKey(PAYER),
            ...RECIPIENTS.map((recipient) => new PublicKey(recipient)),
            new PublicKey(LEGACY_RECORD),
            SYSTEM_PROGRAM,
          ],
          "2RWubWCVYD4cdnLHpRJR1E417pZE1tKuSLFWKrYD7Zdn6cFw3z54ihSvmfeXhy7ds6eW",
          {},
        ),
        "legacy",
      );
      const calls: { address: string; limit: number; before?: string; commitment?: string }[] = [];
      const found = await findLegacySettlementTransaction({
        connection: historyConnection(
          [
            { signature: "deposit", err: null, transaction: deposit("deposit", LEGACY_RECORD) },
            { signature: "legacy", err: null, transaction: legacy },
          ],
          calls,
        ),
        programId: PROGRAM_ID,
        eventId: "evt_bd2961e0-1019-42e0-a9f7-ceb6928ad6af",
      });
      expect(found).toEqual({ signature: "legacy", slot: 491_725_036, topLevel: true });
      expect(calls[0].address).toBe(LEGACY_RECORD);
      // A namespaced settlement never counts as the legacy record's creator,
      // even one that names the legacy record (as a recipient, say).
      const legacyRecord = findLegacySettlementRecordPda(PROGRAM_ID, eventIdSeed(EVENT_ID))[0];
      const accounts = settleNAccounts();
      accounts[3] = legacyRecord;
      const namingIt = signed(parsedSettlement(accounts, settleNData, observation().memo), "settled");
      await expect(
        findLegacySettlementTransaction({
          connection: historyConnection([{ signature: "settled", err: null, transaction: namingIt }]),
          programId: PROGRAM_ID,
          eventId: EVENT_ID,
        }),
      ).rejects.toMatchObject({ code: "RECORD_HISTORY" });
    });

    test("does not count an old settlement of another event that paid the legacy record's address", async () => {
      // The retired program let a settlement of one event pay any wallet,
      // including the address another event's record would later take.
      const otherSeed = eventIdSeed("evt_another_event");
      const bps = [5_000, 5_000];
      const otherData = Uint8Array.from([
        1,
        ...otherSeed,
        ...new Uint8Array(new BigUint64Array([20_000_000n]).buffer),
        bps.length,
        ...new Uint8Array(new Uint16Array(bps).buffer),
      ]);
      const otherRecord = findLegacySettlementRecordPda(PROGRAM_ID, otherSeed)[0];
      const paidIt = signed(
        parsedSettlement(
          [new PublicKey(PAYER), new PublicKey(RECIPIENTS[0]), new PublicKey(LEGACY_RECORD), otherRecord, SYSTEM_PROGRAM],
          base58(otherData),
          {},
        ),
        "other-event",
      );
      const legacy = signed(
        parsedSettlement(
          [
            new PublicKey(PAYER),
            ...RECIPIENTS.map((recipient) => new PublicKey(recipient)),
            new PublicKey(LEGACY_RECORD),
            SYSTEM_PROGRAM,
          ],
          "2RWubWCVYD4cdnLHpRJR1E417pZE1tKuSLFWKrYD7Zdn6cFw3z54ihSvmfeXhy7ds6eW",
          {},
        ),
        "legacy",
      );
      const found = await findLegacySettlementTransaction({
        connection: historyConnection([
          { signature: "legacy", err: null, transaction: legacy },
          { signature: "other-event", err: null, transaction: paidIt },
        ]),
        programId: PROGRAM_ID,
        eventId: "evt_bd2961e0-1019-42e0-a9f7-ceb6928ad6af",
      });
      expect(found.signature).toBe("legacy");
    });

    test("reports an inner invocation as not top level, even when it is the only visible candidate", async () => {
      // A pruned provider can hide the real creator and leave a decoy CPI as
      // the only candidate. It is reported as inner so the legacy decision
      // treats it as unresolved rather than as a settlement.
      const legacy = signed(
        parsedSettlement(
          [
            new PublicKey(PAYER),
            ...RECIPIENTS.map((recipient) => new PublicKey(recipient)),
            new PublicKey(LEGACY_RECORD),
            SYSTEM_PROGRAM,
          ],
          "2RWubWCVYD4cdnLHpRJR1E417pZE1tKuSLFWKrYD7Zdn6cFw3z54ihSvmfeXhy7ds6eW",
          {},
        ),
        "legacy-decoy",
      );
      const message = legacy.transaction.message;
      const settle = message.instructions.at(-1);
      const wrapped = {
        ...legacy,
        transaction: {
          ...legacy.transaction,
          message: {
            ...message,
            instructions: [
              ...message.instructions.slice(0, -1),
              { accounts: [], data: "1", programId: new PublicKey(RECIPIENTS[0]) },
            ],
          },
        },
        meta: { ...legacy.meta, innerInstructions: [{ index: 1, instructions: [settle] }] },
      } as unknown as ParsedTransactionWithMeta;
      const found = await findLegacySettlementTransaction({
        connection: historyConnection([{ signature: "legacy-decoy", err: null, transaction: wrapped }]),
        programId: PROGRAM_ID,
        eventId: "evt_bd2961e0-1019-42e0-a9f7-ceb6928ad6af",
      });
      expect(found).toMatchObject({ signature: "legacy-decoy", topLevel: false });
    });

    test("does not count a retired settlement that never names the legacy record", async () => {
      // The event id in the data matches, but the instruction does not list
      // the legacy record among its accounts, so it did not create it.
      const notIt = signed(
        parsedSettlement(
          [new PublicKey(PAYER), ...RECIPIENTS.map((recipient) => new PublicKey(recipient)), SYSTEM_PROGRAM],
          "2RWubWCVYD4cdnLHpRJR1E417pZE1tKuSLFWKrYD7Zdn6cFw3z54ihSvmfeXhy7ds6eW",
          {},
        ),
        "not-it",
      );
      await expect(
        findLegacySettlementTransaction({
          connection: historyConnection([{ signature: "not-it", err: null, transaction: notIt }]),
          programId: PROGRAM_ID,
          eventId: "evt_bd2961e0-1019-42e0-a9f7-ceb6928ad6af",
        }),
      ).rejects.toMatchObject({ code: "RECORD_HISTORY" });
    });

    test("finds a token settlement", async () => {
      const tokenData = base58(
        encodeSettleTokenNData({ eventSeed: eventIdSeed(EVENT_ID), amount: 20_000n, decimals: 6, bps: BPS }),
      );
      const token = signed(parsedSettlement(settleNAccounts(), tokenData, observation().memo), "token");
      const found = await findSettlementTransaction({
        connection: historyConnection([{ signature: "token", err: null, transaction: token }]),
        programId: PROGRAM_ID,
        namespace: NAMESPACE,
        eventId: EVENT_ID,
      });
      expect(found).toEqual({ signature: "token", slot: 491_725_036, topLevel: true });
    });

    test("refuses a maxSignatures that is not a positive integer", async () => {
      for (const maxSignatures of [0, -1, 1.5, Number.NaN]) {
        await expect(
          findSettlementTransaction({
            connection: historyConnection([{ signature: "settled", err: null, transaction: settlement("settled") }]),
            programId: PROGRAM_ID,
            namespace: NAMESPACE,
            eventId: EVENT_ID,
            maxSignatures,
          }),
        ).rejects.toMatchObject({ code: "RECORD_HISTORY" });
      }
    });
  });
});
