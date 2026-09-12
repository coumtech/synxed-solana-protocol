import { describe, expect, test } from "bun:test";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  LedgerError,
  allocatePoolPayout,
  assertLedgerCluster,
  eventIdSeed,
  observeProgramSettlement,
  reconcileObservedSettlementN,
  type LedgerErrorCode,
  type ProgramSettlementObservation,
  type SettlementRequestN,
} from "../sdk/typescript/src/index.ts";

const PAYER = "6k3KRgAuv4CwanjLGwYH1rzwTeZwSRbeLETHfen4h51s";
const RECORD = "4xrJM7aoaSkbmzXRgARZP8WSBzdd1nqrSqk45KJhE7n3";
const RECIPIENTS = [
  "6AF4DwckLZ7pxwWYarmJx5Sk6dyziagHNoDA8CJpDQa5",
  "EfKS8o2pDsHAJUKQQ3evE5m6PgYR7rxEYvGQavk2y1Da",
  "GJ7JUe6w6DktBDBPKGWNzhJUhRRFExJqb2hrtdsQFX7s",
  "48fB8mLhZJNZxVjyebuEhu5nvKPSyM31asQE6kkjqhA9",
] as const;
const BPS = [3_500, 3_500, 2_000, 1_000] as const;
const AMOUNTS = [7_000_000n, 7_000_000n, 4_000_000n, 2_000_000n] as const;
const EVENT_ID = "evt_phase2_ledger";
const PROGRAM_ID = new PublicKey("HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT");

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
    memo: "phase 2 ledger test",
  };
}

function observation(): ProgramSettlementObservation {
  return {
    signature: "phase2-test-signature",
    slot: 500_000_000,
    blockTime: 1_789_200_000,
    payer: PAYER,
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
      memo: "phase 2 ledger test",
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

  test("extracts the finalized reference transaction's SettleN evidence", () => {
    const signature =
      "31NVbBvwgnRrnaBN5BQAh8UpovHqBCyhFfvbDXqQi3pMv3xbMeCCpts7eh1UwUxUEQokWrfgHj9aMfKBNXYsvzra";
    const transaction = {
      slot: 491_725_036,
      blockTime: 1_788_310_318,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [],
          recentBlockhash: "reference-fixture",
          instructions: [
            {
              parsed: JSON.stringify({
                protocol: "synxed-settlement",
                event: "evt_bd2961e0-1019-42e0-a9f7-ceb6928ad6af",
                occurredAt: "2026-09-02T00:51:58.000Z",
                kind: "audio_ad_impression",
                asset: "SOL_LAMPORTS_STANDIN",
                lamports: "20000000",
                memo: "audio ad in Skyline Runners (4-way)",
              }),
              program: "spl-memo",
              programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
            },
            {
              accounts: [
                new PublicKey(PAYER),
                ...RECIPIENTS.map((recipient) => new PublicKey(recipient)),
                new PublicKey(RECORD),
                new PublicKey("11111111111111111111111111111111"),
              ],
              data: "2RWubWCVYD4cdnLHpRJR1E417pZE1tKuSLFWKrYD7Zdn6cFw3z54ihSvmfeXhy7ds6eW",
              programId: PROGRAM_ID,
            },
          ],
        },
      },
      meta: {
        err: null,
        innerInstructions: [
          {
            index: 1,
            instructions: [
              ...RECIPIENTS.map((destination, index) => ({
                parsed: {
                  info: { destination, lamports: Number(AMOUNTS[index]), source: PAYER },
                  type: "transfer",
                },
                program: "system",
                programId: new PublicKey("11111111111111111111111111111111"),
              })),
            ],
          },
        ],
      },
    } as unknown as ParsedTransactionWithMeta;

    const observed = observeProgramSettlement(transaction, signature, PROGRAM_ID);
    expect(observed.amountOnChain).toBe(20_000_000n);
    expect(observed.bps).toEqual(BPS);
    expect(observed.recipients).toEqual(RECIPIENTS);
    expect(observed.transfers.map((transfer) => transfer.amountOnChain)).toEqual(
      [...AMOUNTS],
    );
  });

  test("reconciles the 35/35/20/10 split into direct and pooled rows", () => {
    const result = reconcileObservedSettlementN({
      observation: observation(),
      request: request(),
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
          unitsPerAtomicUnit: 1_000n,
        }),
      ).toThrow(LedgerError);
      try {
        reconcileObservedSettlementN({
          observation: changed,
          request: request(),
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
