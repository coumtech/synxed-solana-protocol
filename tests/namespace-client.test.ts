import { describe, expect, test } from "bun:test";
import {
  Keypair,
  PublicKey,
  type AccountInfo,
  type Connection,
  type Signer,
  type Transaction,
} from "@solana/web3.js";
import {
  NAMESPACE_DISCRIMINATOR,
  ProtocolError,
  buildSettlementNTransaction,
  ensureNamespace,
  eventIdSeed,
  fetchLegacySettlementRecord,
  fetchNamespace,
  findLegacySettlementRecordPda,
  findNamespacePda,
  namespaceIdFromLabel,
  submitSettlement,
  submitSettlementN,
  type ProtocolErrorCode,
  type SettlementRequest,
  type SettlementRequestN,
} from "../sdk/typescript/src/index.ts";

const PROGRAM_ID = new PublicKey("HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT");
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
const NAMESPACE_ID = namespaceIdFromLabel("client-tests");

function key(label: string): PublicKey {
  return PublicKey.findProgramAddressSync([new TextEncoder().encode(label)], PROGRAM_ID)[0];
}

function requestN(): SettlementRequestN {
  return {
    eventId: "evt_namespace_client",
    occurredAt: "2026-10-01T00:00:00.000Z",
    kind: "audio_ad_impression",
    amountAtomic: 20_000n,
    asset: "SOL_LAMPORTS_STANDIN",
    shares: ["artist", "studio", "synxed", "rewards_pool"].map((label, index) => ({
      label,
      recipient: key(label).toBase58(),
      bps: [3_500, 3_500, 2_000, 1_000][index],
    })),
    memo: "client tests",
  };
}

function request3(): SettlementRequest {
  return {
    eventId: "evt_namespace_client_three_way",
    occurredAt: "2026-10-01T00:00:00.000Z",
    kind: "audio_ad_impression",
    amountAtomic: 20_000n,
    asset: "SOL_LAMPORTS_STANDIN",
    splits: [
      { role: "artist", recipient: key("artist").toBase58(), bps: 3_500 },
      { role: "studio", recipient: key("studio").toBase58(), bps: 4_000 },
      { role: "synxed", recipient: key("synxed").toBase58(), bps: 2_500 },
    ],
    memo: "client tests",
  };
}

function namespaceData(creator: PublicKey, authority: PublicKey): Buffer {
  return Buffer.from([
    NAMESPACE_DISCRIMINATOR,
    255,
    ...creator.toBytes(),
    ...NAMESPACE_ID,
    ...authority.toBytes(),
  ]);
}

function account(owner: PublicKey, data: Buffer): AccountInfo<Buffer> {
  return { owner, data, lamports: 1_000_000, executable: false, rentEpoch: 0 };
}

interface Sent {
  transaction: Transaction;
  signers: PublicKey[];
}

/**
 * Stands in for an RPC connection: `accounts` answers getAccountInfo, every
 * sent transaction is recorded, and `onSend` can fail or change state.
 */
function stubConnection(
  accounts: Map<string, AccountInfo<Buffer>>,
  sent: Sent[] = [],
  onSend: (sent: Sent) => void = () => {},
): Connection {
  return {
    getAccountInfo: async (address: PublicKey) => accounts.get(address.toBase58()) ?? null,
    sendTransaction: async (transaction: Transaction, signers: Signer[]) => {
      const record = { transaction, signers: signers.map((signer) => signer.publicKey) };
      sent.push(record);
      onSend(record);
      return "stub-signature";
    },
    confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } }),
  } as unknown as Connection;
}

async function expectCode(promise: Promise<unknown>, code: ProtocolErrorCode): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`expected ProtocolError ${code}, but nothing was thrown`);
}

function expectSyncCode(fn: () => unknown, code: ProtocolErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(code);
    return;
  }
  throw new Error(`expected ProtocolError ${code}, but nothing was thrown`);
}

describe("submitting in a namespace", () => {
  const payer = Keypair.generate();
  const namespace = findNamespacePda(PROGRAM_ID, payer.publicKey, NAMESPACE_ID)[0];

  test("submitSettlementN signs with a separate authority and names it", async () => {
    const authority = Keypair.generate();
    const sent: Sent[] = [];
    await submitSettlementN({
      connection: stubConnection(new Map(), sent),
      payer,
      request: requestN(),
      programId: PROGRAM_ID,
      namespace,
      authority,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].signers.map((signer) => signer.toBase58())).toEqual([
      payer.publicKey.toBase58(),
      authority.publicKey.toBase58(),
    ]);
    const settle = sent[0].transaction.instructions.at(-1);
    expect(settle?.keys[1].pubkey.equals(authority.publicKey)).toBe(true);
    expect(settle?.keys[1].isSigner).toBe(true);
    expect(settle?.keys[2].pubkey.equals(namespace)).toBe(true);
  });

  test("submitSettlementN signs once when the payer is the authority", async () => {
    const sent: Sent[] = [];
    await submitSettlementN({
      connection: stubConnection(new Map(), sent),
      payer,
      request: requestN(),
      programId: PROGRAM_ID,
      namespace,
    });
    expect(sent[0].signers.map((signer) => signer.toBase58())).toEqual([payer.publicKey.toBase58()]);
    expect(sent[0].transaction.instructions.at(-1)?.keys[1].pubkey.equals(payer.publicKey)).toBe(true);
  });

  test("submitSettlement sends a three-share SettleN in the namespace", async () => {
    const authority = Keypair.generate();
    const sent: Sent[] = [];
    const submission = await submitSettlement({
      connection: stubConnection(new Map(), sent),
      payer,
      request: request3(),
      lamportsPerAtomicUnit: 1_000n,
      programId: PROGRAM_ID,
      namespace,
      authority,
    });
    expect(submission.mode).toBe("program");
    const settle = sent[0].transaction.instructions.at(-1);
    expect(settle?.data[0]).toBe(5);
    expect(settle?.data[41]).toBe(3);
    expect(settle?.keys).toHaveLength(3 + 5);
    expect(settle?.keys[2].pubkey.equals(namespace)).toBe(true);
    expect(sent[0].signers).toHaveLength(2);
  });

  test("submitSettlement and submitSettlementN refuse a half-configured program mode", async () => {
    const connection = stubConnection(new Map());
    // Plain JavaScript callers bypass the types; the guards still refuse.
    const loose = (options: object) => options as never;
    await expectCode(
      submitSettlement(loose({ connection, payer, request: request3(), programId: PROGRAM_ID })),
      "NAMESPACE_REQUIRED",
    );
    await expectCode(
      submitSettlement(loose({ connection, payer, request: request3(), namespace })),
      "NAMESPACE_REQUIRED",
    );
    await expectCode(
      submitSettlementN(loose({ connection, payer, request: requestN(), programId: PROGRAM_ID })),
      "NAMESPACE_REQUIRED",
    );
    await expectCode(
      submitSettlementN(loose({ connection, payer, request: requestN(), authority: payer })),
      "NAMESPACE_REQUIRED",
    );
  });
});

describe("buildSettlementNTransaction in a namespace", () => {
  const payer = Keypair.generate().publicKey;
  const namespace = findNamespacePda(PROGRAM_ID, payer, NAMESPACE_ID)[0];
  const loose = (options: object) => options as never;

  test("names a separate authority as the signing authority", () => {
    const authority = Keypair.generate().publicKey;
    const prepared = buildSettlementNTransaction({
      payer,
      request: requestN(),
      programId: PROGRAM_ID,
      namespace,
      authority,
    });
    const settle = prepared.transaction.instructions.at(-1);
    expect(settle?.keys[0].pubkey.equals(payer)).toBe(true);
    expect(settle?.keys[1].pubkey.equals(authority)).toBe(true);
    expect(settle?.keys[1].isSigner).toBe(true);
  });

  test("opens the namespace with the given authority, not the payer", () => {
    const authority = Keypair.generate().publicKey;
    const prepared = buildSettlementNTransaction({
      payer,
      request: requestN(),
      programId: PROGRAM_ID,
      namespace,
      authority,
      createNamespaceId: NAMESPACE_ID,
    });
    const create = prepared.transaction.instructions[0];
    expect(create.data[0]).toBe(3);
    expect(new PublicKey(create.data.subarray(33, 65)).equals(authority)).toBe(true);
    expect(create.keys[1].pubkey.equals(payer)).toBe(true);
  });

  test("refuses an authority or a namespace to open without a program", () => {
    expectSyncCode(
      () => buildSettlementNTransaction(loose({ payer, request: requestN(), authority: payer })),
      "NAMESPACE_REQUIRED",
    );
    expectSyncCode(
      () =>
        buildSettlementNTransaction(loose({ payer, request: requestN(), createNamespaceId: NAMESPACE_ID })),
      "NAMESPACE_REQUIRED",
    );
  });
});

describe("fetchNamespace and ensureNamespace", () => {
  const payer = Keypair.generate();
  const address = findNamespacePda(PROGRAM_ID, payer.publicKey, NAMESPACE_ID)[0];

  test("fetchNamespace reads a namespace, returns null for nothing, refuses another owner", async () => {
    const accounts = new Map([[address.toBase58(), account(PROGRAM_ID, namespaceData(payer.publicKey, payer.publicKey))]]);
    const found = await fetchNamespace(stubConnection(accounts), PROGRAM_ID, address);
    expect(found?.authority.equals(payer.publicKey)).toBe(true);
    expect(found?.creator.equals(payer.publicKey)).toBe(true);
    expect(await fetchNamespace(stubConnection(new Map()), PROGRAM_ID, address)).toBeNull();
    const foreign = new Map([[address.toBase58(), account(SYSTEM_PROGRAM, namespaceData(payer.publicKey, payer.publicKey))]]);
    await expectCode(fetchNamespace(stubConnection(foreign), PROGRAM_ID, address), "NAMESPACE_ACCOUNT");
  });

  test("ensureNamespace opens a missing namespace with CreateNamespace", async () => {
    const sent: Sent[] = [];
    const ensured = await ensureNamespace({
      connection: stubConnection(new Map(), sent),
      payer,
      programId: PROGRAM_ID,
      namespaceId: NAMESPACE_ID,
    });
    expect(ensured.created).toBe(true);
    expect(ensured.address.equals(address)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].transaction.instructions[0].data[0]).toBe(3);
  });

  test("ensureNamespace refuses an existing namespace with another authority", async () => {
    const accounts = new Map([[address.toBase58(), account(PROGRAM_ID, namespaceData(payer.publicKey, key("someone")))]]);
    await expectCode(
      ensureNamespace({ connection: stubConnection(accounts), payer, programId: PROGRAM_ID, namespaceId: NAMESPACE_ID }),
      "NAMESPACE_AUTHORITY",
    );
  });

  test("ensureNamespace with create false never opens one", async () => {
    const sent: Sent[] = [];
    await expectCode(
      ensureNamespace({
        connection: stubConnection(new Map(), sent),
        payer,
        programId: PROGRAM_ID,
        namespaceId: NAMESPACE_ID,
        create: false,
      }),
      "NAMESPACE_ACCOUNT",
    );
    expect(sent).toHaveLength(0);
  });

  test("ensureNamespace accepts a namespace another run opened first", async () => {
    const accounts = new Map<string, AccountInfo<Buffer>>();
    const connection = stubConnection(accounts, [], () => {
      accounts.set(address.toBase58(), account(PROGRAM_ID, namespaceData(payer.publicKey, payer.publicKey)));
      throw new Error("AccountAlreadyInitialized");
    });
    const ensured = await ensureNamespace({ connection, payer, programId: PROGRAM_ID, namespaceId: NAMESPACE_ID });
    expect(ensured.created).toBe(false);
    expect(ensured.authority.equals(payer.publicKey)).toBe(true);
  });
});

describe("fetchLegacySettlementRecord", () => {
  const seed = eventIdSeed("evt_before_namespaces");
  const [address] = findLegacySettlementRecordPda(PROGRAM_ID, seed);
  const record = (eventSeed: Uint8Array): Buffer => {
    const data = Buffer.alloc(41);
    data[0] = 1;
    data.set(eventSeed, 1);
    data.writeBigUInt64LE(20_000_000n, 33);
    return data;
  };

  test("reports a record the program owns for this event", async () => {
    const accounts = new Map([[address.toBase58(), account(PROGRAM_ID, record(seed))]]);
    const found = await fetchLegacySettlementRecord(stubConnection(accounts), PROGRAM_ID, seed);
    expect(found?.address.equals(address)).toBe(true);
    expect(found?.amount).toBe(20_000_000n);
  });

  test("ignores nothing and a plain transfer to the address", async () => {
    expect(await fetchLegacySettlementRecord(stubConnection(new Map()), PROGRAM_ID, seed)).toBeNull();
    // Anyone can send lamports to the address; that proves nothing.
    const funded = new Map([[address.toBase58(), account(SYSTEM_PROGRAM, Buffer.alloc(0))]]);
    expect(await fetchLegacySettlementRecord(stubConnection(funded), PROGRAM_ID, seed)).toBeNull();
  });

  test("refuses a program-owned account that is not this event's record", async () => {
    const other = new Map([[address.toBase58(), account(PROGRAM_ID, record(eventIdSeed("evt_other")))]]);
    await expectCode(fetchLegacySettlementRecord(stubConnection(other), PROGRAM_ID, seed), "LEGACY_RECORD");
  });
});
