import { describe, expect, test } from "bun:test";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  LedgerError,
  allocatePoolPayout,
  assertLedgerCluster,
  encodeSettleNData,
  eventIdSeed,
  findNamespacePda,
  findSettlementRecordPda,
  namespaceIdFromLabel,
  observeProgramSettlement,
  reconcileObservedSettlementN,
  type LedgerErrorCode,
  type ProgramSettlementObservation,
  type SettlementRequestN,
} from "../sdk/typescript/src/index.ts";

const PAYER = "6k3KRgAuv4CwanjLGwYH1rzwTeZwSRbeLETHfen4h51s";
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
    authority: PAYER,
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
  function parsedSettlement(
    accounts: readonly PublicKey[],
    data: string,
    memo: Readonly<Record<string, unknown>>,
  ): ParsedTransactionWithMeta {
    return {
      slot: 491_725_036,
      blockTime: 1_788_310_318,
      transaction: {
        signatures: ["fixture-signature"],
        message: {
          accountKeys: [],
          recentBlockhash: "fixture",
          instructions: [
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
          {
            index: 1,
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
    new PublicKey(PAYER),
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
    expect(observed.authority).toBe(PAYER);
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
    expect(result.record.authority).toBe(PAYER);
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
});
