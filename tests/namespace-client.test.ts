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
  fetchSettlementRecord,
  findLegacySettlementRecordPda,
  findNamespacePda,
  findSettlementRecordPda,
  namespaceIdFromLabel,
  submitSettlement,
  submitSettlementN,
  submitTokenSettlementN,
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
    expect(settle?.keys[1].pubkey.equals(authority.publicKey)).toBe(true);
    expect(settle?.keys[1].isSigner).toBe(true);
    expect(settle?.keys[2].pubkey.equals(namespace)).toBe(true);
    expect(sent[0].signers.map((signer) => signer.toBase58())).toEqual([
      payer.publicKey.toBase58(),
      authority.publicKey.toBase58(),
    ]);
  });

  test("submitTokenSettlementN signs with a separate authority and names it", async () => {
    const authority = Keypair.generate();
    const sent: Sent[] = [];
    await submitTokenSettlementN({
      connection: stubConnection(new Map(), sent),
      payer,
      request: { ...requestN(), asset: "SPL_STABLECOIN" },
      mint: key("mint"),
      decimals: 6,
      programId: PROGRAM_ID,
      namespace,
      authority,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].signers.map((signer) => signer.toBase58())).toEqual([
      payer.publicKey.toBase58(),
      authority.publicKey.toBase58(),
    ]);
    const settle = sent[0].transaction.instructions.find((instruction) =>
      instruction.programId.equals(PROGRAM_ID),
    );
    expect(settle?.data[0]).toBe(6);
    expect(settle?.keys[1].pubkey.equals(authority.publicKey)).toBe(true);
    expect(settle?.keys[1].isSigner).toBe(true);
    expect(settle?.keys[2].pubkey.equals(namespace)).toBe(true);
  });

  test("submitSettlement and submitSettlementN refuse a half-configured program mode", async () => {
    const sent: Sent[] = [];
    const connection = stubConnection(new Map(), sent);
    // Plain JavaScript callers bypass the types; the guards still refuse.
    // Without them, a stray namespace or authority would settle by plain
    // transfers, which no on-chain record guards against repeating.
    const loose = (options: object) => options as never;
    for (const submit of [
      () => submitSettlement(loose({ connection, payer, request: request3(), programId: PROGRAM_ID })),
      () => submitSettlementN(loose({ connection, payer, request: requestN(), programId: PROGRAM_ID })),
    ]) {
      await expectCode(submit(), "NAMESPACE_REQUIRED");
    }
    for (const submit of [
      () => submitSettlement(loose({ connection, payer, request: request3(), namespace })),
      () => submitSettlement(loose({ connection, payer, request: request3(), authority: payer })),
      () => submitSettlementN(loose({ connection, payer, request: requestN(), namespace })),
      () => submitSettlementN(loose({ connection, payer, request: requestN(), authority: payer })),
    ]) {
      await expectCode(submit(), "PROGRAM_ID_REQUIRED");
    }
    expect(sent).toHaveLength(0);
  });

  test("the guards also catch a loosely typed config that type-checks", async () => {
    // A spread of an optional `namespace` passes the type checker, so the
    // runtime guard is the real enforcement. No cast is used here.
    const sent: Sent[] = [];
    const config: { programId: PublicKey; namespace?: PublicKey } = { programId: PROGRAM_ID };
    await expectCode(
      submitSettlementN({ connection: stubConnection(new Map(), sent), payer, request: requestN(), ...config }),
      "NAMESPACE_REQUIRED",
    );
    expect(sent).toHaveLength(0);
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
      "PROGRAM_ID_REQUIRED",
    );
    expectSyncCode(
      () =>
        buildSettlementNTransaction(loose({ payer, request: requestN(), createNamespaceId: NAMESPACE_ID })),
      "PROGRAM_ID_REQUIRED",
    );
  });
});

describe("fetchNamespace and ensureNamespace", () => {
  const payer = Keypair.generate();
  const address = findNamespacePda(PROGRAM_ID, payer.publicKey, NAMESPACE_ID)[0];

  test("fetchNamespace refuses an empty account another program owns", async () => {
    const foreign = new Map([[address.toBase58(), account(key("another program"), Buffer.alloc(0))]]);
    await expectCode(fetchNamespace(stubConnection(foreign), PROGRAM_ID, address), "NAMESPACE_ACCOUNT");
  });

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
      "NAMESPACE_MISSING",
    );
    expect(sent).toHaveLength(0);
  });

  test("a deposit at the namespace address does not block opening it", async () => {
    // Anyone can send lamports to the address first. The program opens a
    // namespace there all the same, so the SDK must not treat it as taken.
    const funded = new Map([[address.toBase58(), account(SYSTEM_PROGRAM, Buffer.alloc(0))]]);
    expect(await fetchNamespace(stubConnection(funded), PROGRAM_ID, address)).toBeNull();
    const sent: Sent[] = [];
    const ensured = await ensureNamespace({
      connection: stubConnection(funded, sent),
      payer,
      programId: PROGRAM_ID,
      namespaceId: NAMESPACE_ID,
    });
    expect(ensured.created).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].transaction.instructions[0].data[0]).toBe(3);
  });

  test("ensureNamespace checks a pinned address before anything else", async () => {
    const sent: Sent[] = [];
    await expectCode(
      ensureNamespace({
        connection: stubConnection(new Map(), sent),
        payer,
        programId: PROGRAM_ID,
        namespaceId: NAMESPACE_ID,
        expectedAddress: key("pinned elsewhere"),
      }),
      "NAMESPACE_ADDRESS",
    );
    expect(sent).toHaveLength(0);
  });

  test("ensureNamespace finds a namespace another creator opened, and never opens one for it", async () => {
    // A replaced hot payer: the namespace's creator is the old payer key.
    const creator = Keypair.generate().publicKey;
    const pinned = findNamespacePda(PROGRAM_ID, creator, NAMESPACE_ID)[0];
    const accounts = new Map([[pinned.toBase58(), account(PROGRAM_ID, namespaceData(creator, payer.publicKey))]]);
    const ensured = await ensureNamespace({
      connection: stubConnection(accounts),
      payer,
      programId: PROGRAM_ID,
      namespaceId: NAMESPACE_ID,
      creator,
      expectedAddress: pinned,
      create: false,
    });
    expect(ensured.address.equals(pinned)).toBe(true);
    expect(ensured.created).toBe(false);
    const sent: Sent[] = [];
    await expectCode(
      ensureNamespace({
        connection: stubConnection(new Map(), sent),
        payer,
        programId: PROGRAM_ID,
        namespaceId: NAMESPACE_ID,
        creator,
      }),
      "NAMESPACE_MISSING",
    );
    expect(sent).toHaveLength(0);
  });

  test("ensureNamespace opens the namespace with a separate authority, at the payer's address", async () => {
    const authority = Keypair.generate().publicKey;
    const sent: Sent[] = [];
    const ensured = await ensureNamespace({
      connection: stubConnection(new Map(), sent),
      payer,
      programId: PROGRAM_ID,
      namespaceId: NAMESPACE_ID,
      authority,
    });
    const create = sent[0].transaction.instructions[0];
    expect(new PublicKey(create.data.subarray(33, 65)).equals(authority)).toBe(true);
    expect(create.keys[2].pubkey.equals(address)).toBe(true);
    expect(ensured.address.equals(address)).toBe(true);
    expect(ensured.authority.equals(authority)).toBe(true);
    expect(sent[0].signers.map((signer) => signer.toBase58())).toEqual([payer.publicKey.toBase58()]);
  });

  test("ensureNamespace accepts an existing namespace whose authority is the one asked for", async () => {
    const authority = Keypair.generate().publicKey;
    const accounts = new Map([[address.toBase58(), account(PROGRAM_ID, namespaceData(payer.publicKey, authority))]]);
    const sent: Sent[] = [];
    const ensured = await ensureNamespace({
      connection: stubConnection(accounts, sent),
      payer,
      programId: PROGRAM_ID,
      namespaceId: NAMESPACE_ID,
      authority,
    });
    expect(ensured.created).toBe(false);
    expect(ensured.authority.equals(authority)).toBe(true);
    expect(sent).toHaveLength(0);
  });

  test("ensureNamespace refuses a namespace another run opened with another authority", async () => {
    const accounts = new Map<string, AccountInfo<Buffer>>();
    const connection = stubConnection(accounts, [], () => {
      accounts.set(address.toBase58(), account(PROGRAM_ID, namespaceData(payer.publicKey, key("someone"))));
      throw new Error("AccountAlreadyInitialized");
    });
    await expectCode(
      ensureNamespace({ connection, payer, programId: PROGRAM_ID, namespaceId: NAMESPACE_ID }),
      "NAMESPACE_AUTHORITY",
    );
  });

  test("ensureNamespace reports the send error when nothing was opened", async () => {
    const failure = new Error("blockhash not found");
    const connection = stubConnection(new Map(), [], () => {
      throw failure;
    });
    await expect(
      ensureNamespace({ connection, payer, programId: PROGRAM_ID, namespaceId: NAMESPACE_ID }),
    ).rejects.toBe(failure);
  });

  test("ensureNamespace reports the send error when the check after it fails too", async () => {
    const failure = new Error("blockhash not found");
    let reads = 0;
    const connection = {
      ...stubConnection(new Map(), [], () => {
        throw failure;
      }),
      // The first read finds nothing; the re-check after the failed send
      // cannot reach the RPC.
      getAccountInfo: async () => {
        reads += 1;
        if (reads > 1) {
          throw new Error("RPC unavailable");
        }
        return null;
      },
    } as unknown as Connection;
    await expect(
      ensureNamespace({ connection, payer, programId: PROGRAM_ID, namespaceId: NAMESPACE_ID }),
    ).rejects.toBe(failure);
    expect(reads).toBe(2);
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

function recordData(eventSeed: Uint8Array): Buffer {
  const data = Buffer.alloc(41);
  data[0] = 1;
  data.set(eventSeed, 1);
  data.writeBigUInt64LE(20_000_000n, 33);
  return data;
}

describe("fetchSettlementRecord", () => {
  const seed = eventIdSeed("evt_in_a_namespace");
  const namespace = findNamespacePda(PROGRAM_ID, key("creator"), NAMESPACE_ID)[0];
  const [address] = findSettlementRecordPda(PROGRAM_ID, namespace, seed);

  test("reports a record the program owns for this event", async () => {
    const accounts = new Map([[address.toBase58(), account(PROGRAM_ID, recordData(seed))]]);
    const found = await fetchSettlementRecord(stubConnection(accounts), PROGRAM_ID, namespace, seed);
    expect(found?.address.equals(address)).toBe(true);
    expect(found?.amount).toBe(20_000_000n);
  });

  test("returns null for no account and for a plain transfer to the address", async () => {
    expect(await fetchSettlementRecord(stubConnection(new Map()), PROGRAM_ID, namespace, seed)).toBeNull();
    // Anyone can send lamports to the address; that proves nothing.
    const funded = new Map([[address.toBase58(), account(SYSTEM_PROGRAM, Buffer.alloc(0))]]);
    expect(await fetchSettlementRecord(stubConnection(funded), PROGRAM_ID, namespace, seed)).toBeNull();
  });

  test("refuses anything else at the address", async () => {
    const cases = [
      account(PROGRAM_ID, recordData(eventIdSeed("evt_other"))),
      account(PROGRAM_ID, recordData(seed).subarray(0, 40)),
      account(PROGRAM_ID, Buffer.from([2, ...recordData(seed).subarray(1)])),
      account(key("another program"), recordData(seed)),
      account(key("another program"), Buffer.alloc(0)),
      account(SYSTEM_PROGRAM, recordData(seed)),
      account(PROGRAM_ID, Buffer.concat([recordData(seed), Buffer.alloc(1)])),
    ];
    for (const found of cases) {
      const accounts = new Map([[address.toBase58(), found]]);
      await expectCode(
        fetchSettlementRecord(stubConnection(accounts), PROGRAM_ID, namespace, seed),
        "SETTLEMENT_RECORD",
      );
    }
  });
});

describe("fetchLegacySettlementRecord", () => {
  const seed = eventIdSeed("evt_before_namespaces");
  const [address] = findLegacySettlementRecordPda(PROGRAM_ID, seed);

  test("reports a record the program owns for this event", async () => {
    const accounts = new Map([[address.toBase58(), account(PROGRAM_ID, recordData(seed))]]);
    const found = await fetchLegacySettlementRecord(stubConnection(accounts), PROGRAM_ID, seed);
    expect(found?.address.equals(address)).toBe(true);
    expect(found?.amount).toBe(20_000_000n);
  });

  test("returns null for no account and for a plain transfer to the address", async () => {
    expect(await fetchLegacySettlementRecord(stubConnection(new Map()), PROGRAM_ID, seed)).toBeNull();
    // Anyone can send lamports to the address; that proves nothing.
    const funded = new Map([[address.toBase58(), account(SYSTEM_PROGRAM, Buffer.alloc(0))]]);
    expect(await fetchLegacySettlementRecord(stubConnection(funded), PROGRAM_ID, seed)).toBeNull();
  });

  test("refuses an account that is not this event's record", async () => {
    const other = new Map([[address.toBase58(), account(PROGRAM_ID, recordData(eventIdSeed("evt_other")))]]);
    await expectCode(fetchLegacySettlementRecord(stubConnection(other), PROGRAM_ID, seed), "LEGACY_RECORD");
    const foreign = new Map([[address.toBase58(), account(key("another program"), recordData(seed))]]);
    await expectCode(fetchLegacySettlementRecord(stubConnection(foreign), PROGRAM_ID, seed), "LEGACY_RECORD");
  });
});
