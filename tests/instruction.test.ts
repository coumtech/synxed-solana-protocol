import { describe, expect, test } from "bun:test";
import { PublicKey } from "@solana/web3.js";
import {
  CREATE_NAMESPACE_TAG,
  EVENT_SEED_LENGTH,
  ProtocolError,
  RETIRED_TAGS,
  SET_NAMESPACE_AUTHORITY_TAG,
  SETTLE_N_TAG,
  SETTLE_TOKEN_N_TAG,
  eventIdSeed,
  findNamespacePda,
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

/** Deterministic throwaway pubkey per label (not a real keypair). */
function key(label: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(label)],
    PROGRAM_ID,
  )[0];
}

describe("instruction tags", () => {
  test("match programs/synxed-settlement/src/instruction.rs", () => {
    expect(RETIRED_TAGS).toEqual([0, 1, 2]);
    expect(CREATE_NAMESPACE_TAG).toBe(3);
    expect(SET_NAMESPACE_AUTHORITY_TAG).toBe(4);
    expect(SETTLE_N_TAG).toBe(5);
    expect(SETTLE_TOKEN_N_TAG).toBe(6);
  });
});

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

describe("findSettlementRecordPda", () => {
  const namespace = findNamespacePda(PROGRAM_ID, key("creator"), FIXED_SEED)[0];

  test("derives from the seeds the program uses, in order", () => {
    const [record, bump] = findSettlementRecordPda(PROGRAM_ID, namespace, FIXED_SEED);
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode("settlement"), namespace.toBytes(), FIXED_SEED],
      PROGRAM_ID,
    );
    expect(record.equals(expected)).toBe(true);
    expect(bump).toBe(expectedBump);
  });

  test("differs per namespace for the same event id", () => {
    const other = findNamespacePda(PROGRAM_ID, key("someone else"), FIXED_SEED)[0];
    const [mine] = findSettlementRecordPda(PROGRAM_ID, namespace, FIXED_SEED);
    const [theirs] = findSettlementRecordPda(PROGRAM_ID, other, FIXED_SEED);
    expect(mine.equals(theirs)).toBe(false);
  });

  test("differs per event id and is deterministic", () => {
    const [a1] = findSettlementRecordPda(PROGRAM_ID, namespace, FIXED_SEED);
    const [a2] = findSettlementRecordPda(PROGRAM_ID, namespace, FIXED_SEED);
    const [b] = findSettlementRecordPda(PROGRAM_ID, namespace, eventIdSeed("evt_other"));
    expect(a1.equals(a2)).toBe(true);
    expect(a1.equals(b)).toBe(false);
  });

  test("rejects event seeds that are not 32 bytes", () => {
    expectCode(
      () => findSettlementRecordPda(PROGRAM_ID, namespace, new Uint8Array(31)),
      "SEED_LENGTH",
    );
  });
});
