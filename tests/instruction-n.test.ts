import { describe, expect, test } from "bun:test";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  SETTLE_N_HEADER_LENGTH,
  SETTLE_N_TAG,
  ProtocolError,
  buildSettleNInstruction,
  encodeSettleNData,
  findSettlementRecordPda,
  type ProtocolErrorCode,
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
    // tag | seed[32] | 20000u64le | count=4 | 3500 | 3500 | 2000 | 1000 (u16le)
    const expected = Uint8Array.from([
      SETTLE_N_TAG,
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

  test("orders accounts as payer, recipients, record, system program", () => {
    const instruction = buildSettleNInstruction(
      { programId: PROGRAM_ID, payer: key("payer"), recipients },
      { eventSeed: FIXED_SEED, amount: 20_000n, bps: REWARDS_BPS },
    );
    const [record] = findSettlementRecordPda(PROGRAM_ID, FIXED_SEED);
    expect(instruction.keys.length).toBe(recipients.length + 3);
    expect(instruction.keys[0].pubkey.equals(key("payer"))).toBe(true);
    expect(instruction.keys[0].isSigner).toBe(true);
    recipients.forEach((recipient, i) => {
      const meta = instruction.keys[i + 1];
      expect(meta.pubkey.equals(recipient)).toBe(true);
      expect(meta.isSigner).toBe(false);
      expect(meta.isWritable).toBe(true);
    });
    expect(instruction.keys[5].pubkey.equals(record)).toBe(true);
    expect(instruction.keys[5].isWritable).toBe(true);
    expect(instruction.keys[6].pubkey.equals(SystemProgram.programId)).toBe(true);
    expect(instruction.keys[6].isWritable).toBe(false);
  });

  test("rejects a recipient count that does not match the shares", () => {
    expectCode(
      () =>
        buildSettleNInstruction(
          { programId: PROGRAM_ID, payer: key("payer"), recipients: recipients.slice(0, 3) },
          { eventSeed: FIXED_SEED, amount: 20_000n, bps: REWARDS_BPS },
        ),
      "RECIPIENT_COUNT",
    );
  });

  test("rejects the record account in every recipient position", () => {
    const [record] = findSettlementRecordPda(PROGRAM_ID, FIXED_SEED);
    expectCode(
      () =>
        buildSettleNInstruction(
          {
            programId: PROGRAM_ID,
            payer: key("payer"),
            recipients: [recipients[0], recipients[1], recipients[2], record],
          },
          { eventSeed: FIXED_SEED, amount: 20_000n, bps: REWARDS_BPS },
        ),
      "RECIPIENT_IS_RECORD",
    );
  });
});
