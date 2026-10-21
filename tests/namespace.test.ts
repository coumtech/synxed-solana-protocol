import { describe, expect, test } from "bun:test";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  CREATE_NAMESPACE_DATA_LENGTH,
  CREATE_NAMESPACE_TAG,
  NAMESPACE_ACCOUNT_SIZE,
  NAMESPACE_DISCRIMINATOR,
  ProtocolError,
  SET_NAMESPACE_AUTHORITY_DATA_LENGTH,
  SET_NAMESPACE_AUTHORITY_TAG,
  buildCreateNamespaceInstruction,
  buildSetNamespaceAuthorityInstruction,
  decodeNamespaceAccount,
  encodeCreateNamespaceData,
  encodeSetNamespaceAuthorityData,
  findNamespacePda,
  namespaceIdFromLabel,
  type ProtocolErrorCode,
} from "../sdk/typescript/src/index.ts";

const PROGRAM_ID = new PublicKey("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
// The Rust golden vectors use bytes 0..31 for the id and 255 down to 224 for
// the key (`programs/synxed-settlement/src/instruction.rs`).
const ASCENDING = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i));
const DESCENDING = Uint8Array.from(Array.from({ length: 32 }, (_, i) => 255 - i));
const DESCENDING_KEY = new PublicKey(DESCENDING);

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

describe("namespace instruction data", () => {
  test("CreateNamespace matches the Rust golden bytes exactly", () => {
    const data = encodeCreateNamespaceData({
      namespaceId: ASCENDING,
      authority: DESCENDING_KEY,
    });
    expect(data).toEqual(Uint8Array.from([CREATE_NAMESPACE_TAG, ...ASCENDING, ...DESCENDING]));
    expect(data.length).toBe(CREATE_NAMESPACE_DATA_LENGTH);
    expect(data.length).toBe(65);
  });

  test("SetNamespaceAuthority matches the Rust golden bytes exactly", () => {
    const data = encodeSetNamespaceAuthorityData(DESCENDING_KEY);
    expect(data).toEqual(Uint8Array.from([SET_NAMESPACE_AUTHORITY_TAG, ...DESCENDING]));
    expect(data.length).toBe(SET_NAMESPACE_AUTHORITY_DATA_LENGTH);
    expect(data.length).toBe(33);
  });

  test("refuses the all-zero key as an authority, as the program does", () => {
    expectCode(
      () => encodeCreateNamespaceData({ namespaceId: ASCENDING, authority: PublicKey.default }),
      "NAMESPACE_AUTHORITY",
    );
    expectCode(() => encodeSetNamespaceAuthorityData(PublicKey.default), "NAMESPACE_AUTHORITY");
  });

  test("refuses a namespace id that is not 32 bytes", () => {
    expectCode(
      () => encodeCreateNamespaceData({ namespaceId: new Uint8Array(31), authority: DESCENDING_KEY }),
      "NAMESPACE_ID",
    );
    expectCode(() => findNamespacePda(PROGRAM_ID, key("creator"), new Uint8Array(33)), "NAMESPACE_ID");
  });
});

describe("namespaceIdFromLabel", () => {
  test("is sha256 of the utf8 label (known-answer)", () => {
    // Computed independently: printf 'synxed-demo' | shasum -a 256
    const hex = Array.from(namespaceIdFromLabel("synxed-demo"))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    expect(hex).toBe("005408fbfa5f3c911c25c3db8fbc9f92da9c17f4ba861c19f5b87047d80fbbc5");
  });

  test("rejects an empty label", () => {
    expectCode(() => namespaceIdFromLabel(""), "NAMESPACE_ID");
  });
});

describe("findNamespacePda", () => {
  test("derives from the seeds the program uses, in order", () => {
    const creator = key("creator");
    const [namespace, bump] = findNamespacePda(PROGRAM_ID, creator, ASCENDING);
    const [expected, expectedBump] = PublicKey.findProgramAddressSync(
      [new TextEncoder().encode("namespace"), creator.toBytes(), ASCENDING],
      PROGRAM_ID,
    );
    expect(namespace.equals(expected)).toBe(true);
    expect(bump).toBe(expectedBump);
  });

  test("differs per creator and per namespace id", () => {
    const [mine] = findNamespacePda(PROGRAM_ID, key("creator"), ASCENDING);
    const [otherCreator] = findNamespacePda(PROGRAM_ID, key("other"), ASCENDING);
    const [otherId] = findNamespacePda(PROGRAM_ID, key("creator"), DESCENDING);
    expect(mine.equals(otherCreator)).toBe(false);
    expect(mine.equals(otherId)).toBe(false);
  });
});

describe("namespace instruction builders", () => {
  test("CreateNamespace orders payer, creator, namespace, system program", () => {
    const payer = key("payer");
    const creator = key("creator");
    const instruction = buildCreateNamespaceInstruction(
      { programId: PROGRAM_ID, payer, creator },
      { namespaceId: ASCENDING, authority: DESCENDING_KEY },
    );
    const [namespace] = findNamespacePda(PROGRAM_ID, creator, ASCENDING);
    const metas = instruction.keys.map((meta) => [
      meta.pubkey.toBase58(),
      meta.isSigner,
      meta.isWritable,
    ]);
    expect(metas).toEqual([
      [payer.toBase58(), true, true],
      [creator.toBase58(), true, false],
      [namespace.toBase58(), false, true],
      [SystemProgram.programId.toBase58(), false, false],
    ]);
    expect(instruction.programId.equals(PROGRAM_ID)).toBe(true);
    expect(Array.from(instruction.data)).toEqual(
      Array.from(encodeCreateNamespaceData({ namespaceId: ASCENDING, authority: DESCENDING_KEY })),
    );
  });

  test("SetNamespaceAuthority orders the signing authority, then the writable namespace", () => {
    const authority = key("authority");
    const namespace = key("namespace");
    const instruction = buildSetNamespaceAuthorityInstruction(
      { programId: PROGRAM_ID, authority, namespace },
      DESCENDING_KEY,
    );
    const metas = instruction.keys.map((meta) => [
      meta.pubkey.toBase58(),
      meta.isSigner,
      meta.isWritable,
    ]);
    expect(metas).toEqual([
      [authority.toBase58(), true, false],
      [namespace.toBase58(), false, true],
    ]);
    expect(Array.from(instruction.data)).toEqual(
      Array.from(encodeSetNamespaceAuthorityData(DESCENDING_KEY)),
    );
  });
});

describe("decodeNamespaceAccount", () => {
  const creator = key("creator");
  const authority = key("authority");
  const data = Uint8Array.from([
    NAMESPACE_DISCRIMINATOR,
    254,
    ...creator.toBytes(),
    ...ASCENDING,
    ...authority.toBytes(),
  ]);

  test("reads the layout the program writes", () => {
    expect(data.length).toBe(NAMESPACE_ACCOUNT_SIZE);
    const decoded = decodeNamespaceAccount(data);
    expect(decoded.bump).toBe(254);
    expect(decoded.creator.equals(creator)).toBe(true);
    expect(decoded.namespaceId).toEqual(ASCENDING);
    expect(decoded.authority.equals(authority)).toBe(true);
  });

  test("refuses a settlement record, a wrong type byte, and a wrong size", () => {
    expectCode(() => decodeNamespaceAccount(new Uint8Array(41).fill(1, 0, 1)), "NAMESPACE_ACCOUNT");
    const wrongType = Uint8Array.from(data);
    wrongType[0] = 1;
    expectCode(() => decodeNamespaceAccount(wrongType), "NAMESPACE_ACCOUNT");
    expectCode(() => decodeNamespaceAccount(Uint8Array.from([...data, 0])), "NAMESPACE_ACCOUNT");
  });
});
