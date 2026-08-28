import { describe, expect, test } from "bun:test";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  EVENT_SEED_LENGTH,
  SETTLE_DATA_LENGTH,
  SETTLE_TAG,
  ProtocolError,
  buildSettleInstruction,
  encodeSettleData,
  eventIdSeed,
  findSettlementRecordPda,
  type ProtocolErrorCode,
} from "../sdk/typescript/src/index.ts";

// Any valid pubkey works as a fixture program id; PDAs are derived off-curve.
const PROGRAM_ID = new PublicKey("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

const FIXED_SEED = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));

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

describe("eventIdSeed", () => {
  test("is 32 bytes, deterministic, and collision-averse", () => {
    const a1 = eventIdSeed("evt_demo_1");
    const a2 = eventIdSeed("evt_demo_1");
    const b = eventIdSeed("evt_demo_2");
    expect(a1.length).toBe(EVENT_SEED_LENGTH);
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
  });

  test("is exactly sha256 of the utf8 event id (known-answer)", () => {
    // Computed independently: printf 'evt_demo_1' | shasum -a 256
    const expectedHex =
      "977213b18424e30a8cd18abfb8ea1553600fe9ce56bdda8e6b510d500903e681";
    const actualHex = Array.from(eventIdSeed("evt_demo_1"))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(actualHex).toBe(expectedHex);
  });

  test("rejects an empty event id", () => {
    expectCode(() => eventIdSeed(""), "EVENT_ID_EMPTY");
  });
});

describe("encodeSettleData", () => {
  test("matches the Rust instruction byte layout exactly", () => {
    const data = encodeSettleData({
      eventSeed: FIXED_SEED,
      amount: 20_000n,
      artistBps: 3_500,
      studioBps: 4_000,
      synxedBps: 2_500,
    });
    // tag | seed[32] | 20000u64le | 3500u16le | 4000u16le | 2500u16le
    const expected = Uint8Array.from([
      SETTLE_TAG,
      ...FIXED_SEED,
      0x20, 0x4e, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0xac, 0x0d,
      0xa0, 0x0f,
      0xc4, 0x09,
    ]);
    expect(data.length).toBe(SETTLE_DATA_LENGTH);
    expect(data).toEqual(expected);
  });

  test("rejects seeds that are not 32 bytes", () => {
    expectCode(
      () =>
        encodeSettleData({
          eventSeed: new Uint8Array(31),
          amount: 1n,
          artistBps: 3_500,
          studioBps: 4_000,
          synxedBps: 2_500,
        }),
      "SEED_LENGTH",
    );
  });

  test("rejects amounts outside u64", () => {
    expectCode(
      () =>
        encodeSettleData({
          eventSeed: FIXED_SEED,
          amount: 0n,
          artistBps: 3_500,
          studioBps: 4_000,
          synxedBps: 2_500,
        }),
      "AMOUNT_U64",
    );
    expectCode(
      () =>
        encodeSettleData({
          eventSeed: FIXED_SEED,
          amount: 1n << 64n,
          artistBps: 3_500,
          studioBps: 4_000,
          synxedBps: 2_500,
        }),
      "AMOUNT_U64",
    );
  });

  test("rejects invalid bps configurations before hitting the chain", () => {
    expectCode(
      () =>
        encodeSettleData({
          eventSeed: FIXED_SEED,
          amount: 1n,
          artistBps: 3_500,
          studioBps: 4_000,
          synxedBps: 2_400,
        }),
      "BPS_SUM",
    );
  });
});

describe("findSettlementRecordPda", () => {
  test("is deterministic per (program, event seed)", () => {
    const [pda1, bump1] = findSettlementRecordPda(PROGRAM_ID, FIXED_SEED);
    const [pda2, bump2] = findSettlementRecordPda(PROGRAM_ID, FIXED_SEED);
    expect(pda1.equals(pda2)).toBe(true);
    expect(bump1).toBe(bump2);

    const otherSeed = eventIdSeed("evt_other");
    const [pda3] = findSettlementRecordPda(PROGRAM_ID, otherSeed);
    expect(pda1.equals(pda3)).toBe(false);
  });
});

describe("buildSettleInstruction", () => {
  test("orders accounts to match the on-chain processor", () => {
    const payer = Keypairish("payer");
    const artist = Keypairish("artist");
    const studio = Keypairish("studio");
    const synxed = Keypairish("synxed");
    const instruction = buildSettleInstruction(
      { programId: PROGRAM_ID, payer, artist, studio, synxed },
      {
        eventSeed: FIXED_SEED,
        amount: 20_000n,
        artistBps: 3_500,
        studioBps: 4_000,
        synxedBps: 2_500,
      },
    );
    const [record] = findSettlementRecordPda(PROGRAM_ID, FIXED_SEED);

    expect(instruction.programId.equals(PROGRAM_ID)).toBe(true);
    expect(instruction.keys.length).toBe(6);
    const expectedKeys = [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: artist, isSigner: false, isWritable: true },
      { pubkey: studio, isSigner: false, isWritable: true },
      { pubkey: synxed, isSigner: false, isWritable: true },
      { pubkey: record, isSigner: false, isWritable: true },
      {
        pubkey: SystemProgram.programId,
        isSigner: false,
        isWritable: false,
      },
    ];
    for (let i = 0; i < expectedKeys.length; i += 1) {
      const actual = instruction.keys[i];
      const expected = expectedKeys[i];
      expect(actual.pubkey.equals(expected.pubkey)).toBe(true);
      expect(actual.isSigner).toBe(expected.isSigner);
      expect(actual.isWritable).toBe(expected.isWritable);
    }
  });
});

/** Deterministic throwaway pubkey per label (not a real keypair). */
function Keypairish(label: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(label)],
    PROGRAM_ID,
  )[0];
}
