import { describe, expect, test } from "bun:test";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  SETTLE_N_HEADER_LENGTH,
  SETTLE_N_TAG,
  ProtocolError,
  buildSettleNInstruction,
  encodeSettleNData,
  findNamespacePda,
  findSettlementRecordPda,
  type ProtocolErrorCode,
  type SettleNAccounts,
} from "../sdk/typescript/src/index.ts";

const PROGRAM_ID = new PublicKey("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
const FIXED_SEED = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));
const REWARDS_BPS = [3_500, 3_500, 2_000, 1_000] as const;

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

function key(label: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(label)],
    PROGRAM_ID,
  )[0];
}

describe("encodeSettleNData", () => {
  test("matches the Rust SettleN golden bytes exactly", () => {
    const data = encodeSettleNData({
      eventSeed: FIXED_SEED,
      amount: 20_000n,
      bps: REWARDS_BPS,
    });
    // tag(5) | seed[32] | 20000u64le | count=4 | 3500 | 3500 | 2000 | 1000 (u16le)
    const expected = Uint8Array.from([
      5,
      ...FIXED_SEED,
      0x20, 0x4e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x04,
      0xac, 0x0d,
      0xac, 0x0d,
      0xd0, 0x07,
      0xe8, 0x03,
    ]);
    expect(data.length).toBe(SETTLE_N_HEADER_LENGTH + 2 * REWARDS_BPS.length);
    expect(data.length).toBe(50);
    expect(data).toEqual(expected);
  });

  test("rejects zero shares, nine shares, and bad amounts", () => {
    expectCode(
      () => encodeSettleNData({ eventSeed: FIXED_SEED, amount: 1n, bps: [] }),
      "SHARE_COUNT",
    );
    expectCode(
      () =>
        encodeSettleNData({
          eventSeed: FIXED_SEED,
          amount: 1n,
          bps: Array(9).fill(1_000),
        }),
      "SHARE_COUNT",
    );
    expectCode(
      () => encodeSettleNData({ eventSeed: FIXED_SEED, amount: 0n, bps: [10_000] }),
      "AMOUNT_U64",
    );
  });
});

describe("buildSettleNInstruction", () => {
  const recipients = [key("artist"), key("studio"), key("synxed"), key("pool")];
  const namespace = findNamespacePda(PROGRAM_ID, key("payer"), FIXED_SEED)[0];
  const accounts = (overrides: Partial<SettleNAccounts> = {}): SettleNAccounts => ({
    programId: PROGRAM_ID,
    payer: key("payer"),
    authority: key("authority"),
    namespace,
    recipients,
    ...overrides,
  });

  test("orders payer, authority, namespace, recipients, record, system program", () => {
    const instruction = buildSettleNInstruction(accounts(), {
      eventSeed: FIXED_SEED,
      amount: 20_000n,
      bps: REWARDS_BPS,
    });
    const [record] = findSettlementRecordPda(PROGRAM_ID, namespace, FIXED_SEED);
    const metas = instruction.keys.map((meta) => [
      meta.pubkey.toBase58(),
      meta.isSigner,
      meta.isWritable,
    ]);
    expect(metas).toEqual([
      [key("payer").toBase58(), true, true],
      [key("authority").toBase58(), true, false],
      [namespace.toBase58(), false, false],
      ...recipients.map((recipient) => [recipient.toBase58(), false, true]),
      [record.toBase58(), false, true],
      [SystemProgram.programId.toBase58(), false, false],
    ]);
  });

  test("derives the record from the namespace", () => {
    const other = findNamespacePda(PROGRAM_ID, key("other"), FIXED_SEED)[0];
    const instruction = buildSettleNInstruction(accounts({ namespace: other }), {
      eventSeed: FIXED_SEED,
      amount: 20_000n,
      bps: REWARDS_BPS,
    });
    const [record] = findSettlementRecordPda(PROGRAM_ID, other, FIXED_SEED);
    expect(instruction.keys[3 + recipients.length].pubkey.equals(record)).toBe(true);
  });

  test("rejects a recipient count that does not match the shares", () => {
    expectCode(
      () =>
        buildSettleNInstruction(accounts({ recipients: recipients.slice(0, 3) }), {
          eventSeed: FIXED_SEED,
          amount: 20_000n,
          bps: REWARDS_BPS,
        }),
      "RECIPIENT_COUNT",
    );
  });

  test("rejects the record or the namespace in a recipient position", () => {
    const [record] = findSettlementRecordPda(PROGRAM_ID, namespace, FIXED_SEED);
    const params = { eventSeed: FIXED_SEED, amount: 20_000n, bps: REWARDS_BPS };
    expectCode(
      () =>
        buildSettleNInstruction(
          accounts({ recipients: [recipients[0], recipients[1], recipients[2], record] }),
          params,
        ),
      "RECIPIENT_IS_RECORD",
    );
    expectCode(
      () =>
        buildSettleNInstruction(
          accounts({ recipients: [namespace, recipients[1], recipients[2], recipients[3]] }),
          params,
        ),
      "RECIPIENT_IS_NAMESPACE",
    );
  });
});
