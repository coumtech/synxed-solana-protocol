import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  type AccountInfo,
  type Connection,
  type ParsedTransactionWithMeta,
  type SignatureStatus,
} from "@solana/web3.js";
import {
  NAMESPACE_DISCRIMINATOR,
  SETTLE_N_TAG,
  buildSettlementNTransaction,
  eventIdSeed,
  findNamespacePda,
  findSettlementRecordPda,
  namespaceIdFromLabel,
  splitAmountAtomicShares,
  type SettlementRequestN,
} from "../sdk/typescript/src/index.ts";
import { prepareEvent } from "../examples/studio-backend/src/events.ts";
import { Store } from "../examples/studio-backend/src/store.ts";
import { SettlementWorker, type WorkerOptions } from "../examples/studio-backend/src/worker.ts";
import { base58 } from "./base58.ts";

const PROGRAM_ID = new PublicKey("HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT");
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const RECORD_RENT = 858_520;
const NAMESPACE_ID = namespaceIdFromLabel("studio-tests");
const EXAMPLE_EVENTS = join(import.meta.dir, "..", "examples", "studio-backend", "events.example.json");

type SendBehaviour = "land" | "lose" | "land-then-error" | "refuse";

/**
 * A small stand-in for the cluster and the settlement program. It keeps the
 * program's rules that matter here: a SettleN needs the namespace's authority
 * to sign, creates the event's record once, and fails with
 * AccountAlreadyInitialized afterwards (refused in preflight, or landing
 * with an error when preflight is skipped).
 */
class FakeChain {
  readonly accounts = new Map<string, AccountInfo<Buffer>>();
  readonly transactions = new Map<string, ParsedTransactionWithMeta>();
  readonly statuses = new Map<string, SignatureStatus>();
  /** Signatures per address, newest first. */
  readonly history = new Map<string, string[]>();
  /** Every signature the chain was handed, in order. */
  readonly received: string[] = [];
  readonly behaviours: SendBehaviour[] = [];
  blockHeight = 1_000;
  slot = 500_000;

  connection(): Connection {
    return {
      getGenesisHash: async () => DEVNET_GENESIS,
      getLatestBlockhash: async () => ({
        blockhash: new PublicKey(new Uint8Array(32).fill(this.blockHeight % 251)).toBase58(),
        lastValidBlockHeight: this.blockHeight + 150,
      }),
      getBlockHeight: async () => this.blockHeight,
      sendRawTransaction: async (raw: Buffer, options?: { skipPreflight?: boolean }) =>
        this.receive(raw, options?.skipPreflight === true),
      getSignatureStatuses: async (signatures: string[]) => ({
        context: { slot: this.slot },
        value: signatures.map((signature) => this.statuses.get(signature) ?? null),
      }),
      getAccountInfo: async (address: PublicKey) => this.accounts.get(address.toBase58()) ?? null,
      getSignaturesForAddress: async (address: PublicKey, options?: { limit?: number; before?: string }) => {
        const all = this.history.get(address.toBase58()) ?? [];
        const start = options?.before === undefined ? 0 : all.indexOf(options.before) + 1;
        return all.slice(start, start + (options?.limit ?? 1_000)).map((signature) => ({
          signature,
          slot: this.transactions.get(signature)?.slot ?? 0,
          err: this.statuses.get(signature)?.err ?? null,
          memo: null,
          blockTime: null,
        }));
      },
      getParsedTransaction: async (signature: string) => this.transactions.get(signature) ?? null,
      getParsedTransactions: async (signatures: string[]) =>
        signatures.map((signature) => this.transactions.get(signature) ?? null),
      simulateTransaction: async () => ({
        context: { slot: this.slot },
        value: { err: null, logs: ["Program log: simulated"], accounts: null, unitsConsumed: 1_000 },
      }),
    } as unknown as Connection;
  }

  openNamespace(creator: PublicKey, authority: PublicKey): PublicKey {
    const [address, bump] = findNamespacePda(PROGRAM_ID, creator, NAMESPACE_ID);
    this.accounts.set(address.toBase58(), {
      owner: PROGRAM_ID,
      data: Buffer.from([NAMESPACE_DISCRIMINATOR, bump, ...creator.toBytes(), ...NAMESPACE_ID, ...authority.toBytes()]),
      lamports: 1_148_080,
      executable: false,
      rentEpoch: 0,
    });
    return address;
  }

  receive(raw: Buffer, skipPreflight: boolean): string {
    const transaction = Transaction.from(raw);
    if (!transaction.verifySignatures() || transaction.signature === null) {
      throw new Error("signature verification failed");
    }
    const signature = base58(transaction.signature);
    this.received.push(signature);
    if (this.statuses.has(signature)) {
      return signature;
    }
    const behaviour = this.behaviours.shift() ?? "land";
    if (behaviour === "lose") {
      throw new Error("fetch failed");
    }
    if (behaviour === "refuse") {
      throw new SendTransactionError({
        action: "simulate",
        signature: "",
        transactionMessage: "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.",
        logs: [],
      });
    }
    const index = transaction.instructions.findIndex(
      (instruction) => instruction.programId.equals(PROGRAM_ID) && instruction.data[0] === SETTLE_N_TAG,
    );
    const settle = transaction.instructions[index];
    const count = settle.data[41];
    const record = settle.keys[3 + count].pubkey;
    if (this.accounts.has(record.toBase58())) {
      if (!skipPreflight) {
        throw new SendTransactionError({
          action: "simulate",
          signature: "",
          // The wording RPC nodes use for the program's AccountAlreadyInitialized.
          transactionMessage: `Transaction simulation failed: Error processing Instruction ${index}: instruction requires an uninitialized account`,
          logs: [],
        });
      }
      this.land(signature, transaction, index, { InstructionError: [index, "AccountAlreadyInitialized"] });
    } else {
      const namespace = this.accounts.get(settle.keys[2].pubkey.toBase58());
      const authorized = namespace !== undefined &&
        new PublicKey(namespace.data.subarray(66, 98)).equals(settle.keys[1].pubkey);
      if (!authorized) {
        this.land(signature, transaction, index, { InstructionError: [index, "IncorrectAuthority"] });
      } else {
        const data = Buffer.alloc(41);
        data[0] = 1;
        data.set(settle.data.subarray(1, 33), 1);
        data.set(settle.data.subarray(33, 41), 33);
        this.accounts.set(record.toBase58(), {
          owner: PROGRAM_ID,
          data,
          lamports: RECORD_RENT,
          executable: false,
          rentEpoch: 0,
        });
        this.land(signature, transaction, index, null);
      }
    }
    if (behaviour === "land-then-error") {
      throw new Error("socket hang up");
    }
    return signature;
  }

  // Record a landed transaction in the shape getParsedTransaction returns.
  land(signature: string, transaction: Transaction, index: number, err: unknown): void {
    this.slot += 1;
    const settle = transaction.instructions[index];
    const count = settle.data[41];
    const payer = settle.keys[0].pubkey.toBase58();
    const recipients = settle.keys.slice(3, 3 + count).map((meta) => meta.pubkey.toBase58());
    const record = settle.keys[3 + count].pubkey.toBase58();
    const amount = settle.data.readBigUInt64LE(33);
    const bps = Array.from({ length: count }, (_, i) => settle.data.readUInt16LE(42 + 2 * i));
    const amounts = splitAmountAtomicShares(amount, bps);
    const transfer = (destination: string, lamports: number) => ({
      parsed: { type: "transfer", info: { source: payer, destination, lamports } },
      program: "system",
      programId: SystemProgram.programId,
    });
    const inner = err !== null
      ? []
      : [
          transfer(record, RECORD_RENT),
          ...recipients.flatMap((destination, i) => (amounts[i] > 0n ? [transfer(destination, Number(amounts[i]))] : [])),
        ];
    this.transactions.set(signature, {
      slot: this.slot,
      blockTime: 1_790_000_000 + this.slot,
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [],
          recentBlockhash: transaction.recentBlockhash,
          instructions: transaction.instructions.map((instruction) =>
            instruction.programId.equals(MEMO_PROGRAM_ID)
              ? { parsed: instruction.data.toString("utf8"), program: "spl-memo", programId: instruction.programId }
              : {
                  accounts: instruction.keys.map((meta) => meta.pubkey),
                  data: base58(instruction.data),
                  programId: instruction.programId,
                },
          ),
        },
      },
      meta: { err, innerInstructions: [{ index, instructions: inner }] },
    } as unknown as ParsedTransactionWithMeta);
    this.statuses.set(signature, {
      slot: this.slot,
      confirmations: null,
      err: err as SignatureStatus["err"],
      confirmationStatus: "finalized",
    });
    this.history.set(record, [signature, ...(this.history.get(record) ?? [])]);
  }

  /** A copy that shares the accounts and transactions but can be changed apart. */
  mirror(): FakeChain {
    const copy = new FakeChain();
    for (const [key, value] of this.accounts) copy.accounts.set(key, value);
    for (const [key, value] of this.transactions) copy.transactions.set(key, value);
    for (const [key, value] of this.statuses) copy.statuses.set(key, value);
    for (const [key, value] of this.history) copy.history.set(key, [...value]);
    copy.blockHeight = this.blockHeight;
    return copy;
  }
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databaseFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "synxed-studio-test-"));
  directories.push(directory);
  return join(directory, "studio.sqlite");
}

function exampleEvents() {
  const parsed: unknown = JSON.parse(readFileSync(EXAMPLE_EVENTS, "utf8"));
  return (parsed as unknown[]).map(prepareEvent);
}

interface Setup {
  chain: FakeChain;
  store: Store;
  payer: Keypair;
  namespace: PublicKey;
  path: string;
  worker: (overrides?: Partial<WorkerOptions>) => SettlementWorker;
}

function setup(): Setup {
  const chain = new FakeChain();
  const payer = Keypair.generate();
  const namespace = chain.openNamespace(payer.publicKey, payer.publicKey);
  const path = databaseFile();
  const store = new Store(path);
  for (const { request, beneficiaryIds } of exampleEvents().slice(0, 1)) {
    store.enqueue(request, beneficiaryIds);
  }
  const worker = (overrides: Partial<WorkerOptions> = {}) =>
    new SettlementWorker({
      store,
      connection: chain.connection(),
      payer,
      programId: PROGRAM_ID,
      namespace,
      lamportsPerAtomicUnit: 1_000n,
      finalityTimeoutMs: 200,
      pollIntervalMs: 5,
      ...overrides,
    });
  return { chain, store, payer, namespace, path, worker };
}

const EVENT = "evt_studio_example_0001";

describe("studio backend: events", () => {
  test("the example events file is valid", () => {
    const events = exampleEvents();
    expect(events.map(({ request }) => request.eventId)).toEqual([EVENT, "evt_studio_example_0002"]);
    expect(events[0].beneficiaryIds).toEqual({
      artist: "artist:aurora-lane",
      studio: "studio:skyline-games",
      synxed: "platform:synxed",
    });
  });

  test("refuses malformed events", () => {
    const [valid] = JSON.parse(readFileSync(EXAMPLE_EVENTS, "utf8")) as Record<string, unknown>[];
    const shares = valid["shares"] as Record<string, unknown>[];
    const cases: [Record<string, unknown>, string][] = [
      [{ ...valid, eventId: " evt" }, "eventId"],
      [{ ...valid, amountAtomic: "20000.5" }, "amountAtomic"],
      [{ ...valid, amountAtomic: 20_000 }, "amountAtomic"],
      [{ ...valid, occurredAt: "yesterday" }, "occurredAt"],
      [{ ...valid, shares: [{ ...shares[0], recipient: "not-a-key" }, ...shares.slice(1)] }, "invalid recipient"],
      [{ ...valid, shares: [{ ...shares[0], beneficiaryId: " " }, ...shares.slice(1)] }, "empty beneficiaryId"],
      [{ ...valid, shares: [{ ...shares[0], bps: 3_600 }, ...shares.slice(1)] }, "10000"],
    ];
    for (const [event, message] of cases) {
      expect(() => prepareEvent(event)).toThrow(message);
    }
  });

  test("enqueuing the same event again is a no-op, and a changed one is refused", () => {
    const { store } = setup();
    const [first] = exampleEvents();
    expect(store.enqueue(first.request, first.beneficiaryIds)).toBe("unchanged");
    const changed: SettlementRequestN = { ...first.request, amountAtomic: 1n };
    expect(() => store.enqueue(changed, first.beneficiaryIds)).toThrow("different request");
  });
});

describe("studio backend: settlement worker", () => {
  test("settles a pending event and writes its ledger rows", async () => {
    const { chain, store, worker } = setup();
    const summary = await worker().run();
    expect(summary.settled).toEqual({ [EVENT]: "paid" });
    expect(store.event(EVENT)?.status).toBe("paid");
    expect(chain.received).toHaveLength(1);
    const [attempt] = store.attempts(EVENT);
    expect(attempt.status).toBe("landed");
    expect(store.settlement(EVENT)?.signature).toBe(attempt.signature ?? "");
    expect(store.balances()).toEqual([
      { beneficiaryId: "artist:aurora-lane", amountOnChain: "7000000" },
      { beneficiaryId: "platform:synxed", amountOnChain: "4000000" },
      { beneficiaryId: "studio:skyline-games", amountOnChain: "7000000" },
    ]);
    expect(store.poolPayouts(EVENT).map((payout) => [payout.role, payout.amountOnChain])).toEqual([
      ["rewards_pool", "2000000"],
    ]);
    // A second run has nothing to do.
    expect(await worker().run()).toEqual({ resolved: {}, settled: {} });
  });

  test("a dry run simulates without signing, sending, or writing", async () => {
    const { chain, store, worker } = setup();
    const [result] = await worker().dryRun();
    expect(result.eventId).toBe(EVENT);
    expect(result.lamportsTotal).toBe(20_000_000n);
    expect(result.lamportsByShare).toEqual([7_000_000n, 7_000_000n, 4_000_000n, 2_000_000n]);
    expect(result.error).toBeNull();
    expect(chain.received).toHaveLength(0);
    expect(store.event(EVENT)?.status).toBe("pending");
    expect(store.attempts(EVENT)).toHaveLength(0);
  });

  test("a crash after signing resends the same bytes, never a second attempt", async () => {
    const { chain, store, worker } = setup();
    let stored: string | null = null;
    await expect(
      worker({
        beforeSend: (eventId) => {
          // The signature is stored before anything is sent.
          stored = store.attempts(eventId)[0].signature;
          throw new Error("crash");
        },
      }).run(),
    ).rejects.toThrow("crash");
    expect(stored).not.toBeNull();
    expect(store.event(EVENT)?.status).toBe("in_flight");
    expect(chain.received).toHaveLength(0);
    // Restarted: the attempt may still land, so it is resent unchanged.
    expect((await worker().run()).resolved).toEqual({ [EVENT]: "waiting" });
    expect((await worker().run()).resolved).toEqual({ [EVENT]: "paid" });
    expect(new Set(chain.received)).toEqual(new Set([stored ?? ""]));
    expect(store.attempts(EVENT)).toHaveLength(1);
  });

  test("an attempt that expired without landing is retried under the same event id", async () => {
    const { chain, store, worker } = setup();
    await expect(worker({ beforeSend: () => { throw new Error("crash"); } }).run()).rejects.toThrow("crash");
    chain.blockHeight += 200; // past the attempt's last valid block height
    const summary = await worker().run();
    expect(summary).toEqual({ resolved: { [EVENT]: "retry" }, settled: { [EVENT]: "paid" } });
    expect(store.attempts(EVENT).map((attempt) => attempt.status)).toEqual(["expired", "landed"]);
    expect(chain.received).toHaveLength(1);
  });

  test("an unknown send result is decided by the chain", async () => {
    const { chain, store, worker } = setup();
    chain.behaviours.push("land-then-error");
    expect((await worker().run()).settled).toEqual({ [EVENT]: "paid" });
    expect(store.attempts(EVENT).map((attempt) => attempt.status)).toEqual(["landed"]);
    expect(chain.received).toHaveLength(1);
  });

  test("a lost send waits for its blockhash, then retries", async () => {
    const { chain, store, worker } = setup();
    chain.behaviours.push("lose", "lose");
    // The first attempt is lost twice (the send and the first resend).
    expect((await worker({ finalityTimeoutMs: 0 }).run()).settled).toEqual({ [EVENT]: "waiting" });
    chain.blockHeight += 200;
    expect(await worker().run()).toEqual({ resolved: { [EVENT]: "retry" }, settled: { [EVENT]: "paid" } });
    expect(store.attempts(EVENT).map((attempt) => attempt.status)).toEqual(["expired", "landed"]);
  });

  test("an event already settled on chain is reconciled, not paid again", async () => {
    // The first database is lost after the settlement landed.
    const first = setup();
    await first.worker().run();
    const landed = first.store.settlement(EVENT)?.signature;
    // A later blockhash, so the new attempt is a different transaction.
    first.chain.blockHeight += 10;
    const store = new Store(databaseFile());
    const [event] = exampleEvents();
    store.enqueue(event.request, event.beneficiaryIds);
    const worker = new SettlementWorker({
      store,
      connection: first.chain.connection(),
      payer: first.payer,
      programId: PROGRAM_ID,
      namespace: first.namespace,
      lamportsPerAtomicUnit: 1_000n,
      finalityTimeoutMs: 200,
      pollIntervalMs: 5,
    });
    expect((await worker.run()).settled).toEqual({ [EVENT]: "paid" });
    expect(store.settlement(EVENT)?.signature).toBe(landed ?? "");
    // The refused attempt is kept, and no second settlement landed.
    expect(store.attempts(EVENT).map((attempt) => attempt.status)).toEqual(["failed"]);
    const record = findSettlementRecordPda(PROGRAM_ID, first.namespace, eventIdSeed(EVENT))[0];
    expect(first.chain.history.get(record.toBase58())).toEqual([landed ?? ""]);
  });

  test("a record made from a request nobody stored is an incident", async () => {
    const { chain, store, payer, namespace, worker } = setup();
    // The namespace's own key settles the event to other wallets first.
    const [event] = exampleEvents();
    const elsewhere = {
      ...event.request,
      shares: event.request.shares.map((share) => ({ ...share, recipient: Keypair.generate().publicKey.toBase58() })),
    };
    settleOutside(chain, payer, namespace, elsewhere);
    const second = chain.mirror();
    expect((await worker({ secondConnection: second.connection() }).run()).settled).toEqual({ [EVENT]: "incident" });
    expect(store.event(EVENT)?.status).toBe("incident");
    expect(store.ledgerEntries()).toHaveLength(0);
    // An incident is never settled again by the worker.
    expect(await worker().run()).toEqual({ resolved: {}, settled: {} });
  });

  // Land a settlement of `request` outside the worker, as another process
  // holding the namespace's key would, and return its signature.
  function settleOutside(chain: FakeChain, payer: Keypair, namespace: PublicKey, request: SettlementRequestN): string {
    const transaction = buildSettlementNTransaction({
      payer: payer.publicKey,
      request,
      lamportsPerAtomicUnit: 1_000n,
      programId: PROGRAM_ID,
      namespace,
    }).transaction;
    transaction.recentBlockhash = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
    transaction.feePayer = payer.publicKey;
    transaction.sign(payer);
    return chain.receive(transaction.serialize(), false);
  }

  test("evidence the SDK cannot read stays unresolved, never an incident", async () => {
    const { chain, store, payer, namespace, worker } = setup();
    const signature = settleOutside(chain, payer, namespace, exampleEvents()[0].request);
    const landed = chain.transactions.get(signature);
    if (landed === undefined) throw new Error("not landed");
    chain.transactions.set(signature, { ...landed, blockTime: null });
    expect((await worker().run()).settled).toEqual({ [EVENT]: "unresolved" });
    expect(store.event(EVENT)?.status).toBe("in_flight");
    expect(store.event(EVENT)?.note).toContain("BLOCK_TIME_MISSING");
  });

  test("a settlement another program invoked is left to a person, with a note", async () => {
    const { chain, store, payer, namespace, worker } = setup();
    const signature = settleOutside(chain, payer, namespace, exampleEvents()[0].request);
    const landed = chain.transactions.get(signature);
    if (landed === undefined || landed.meta === null) throw new Error("not landed");
    // A multisig program's instruction stands where the settlement was, and
    // the settlement runs inside it.
    const instructions = [...landed.transaction.message.instructions];
    const index = instructions.length - 1;
    const settle = instructions[index];
    instructions[index] = { accounts: [], data: "1", programId: Keypair.generate().publicKey };
    const inner = landed.meta.innerInstructions ?? [];
    chain.transactions.set(signature, {
      ...landed,
      transaction: { ...landed.transaction, message: { ...landed.transaction.message, instructions } },
      meta: {
        ...landed.meta,
        innerInstructions: [{ index, instructions: [settle, ...(inner[0]?.instructions ?? [])] }],
      },
    } as ParsedTransactionWithMeta);
    expect((await worker().run()).settled).toEqual({ [EVENT]: "unresolved" });
    expect(store.event(EVENT)?.note).toContain("another program");
  });

  test("the second provider must agree before an event is paid or retried", async () => {
    const { chain, store, worker } = setup();
    // The second provider has not seen the settlement transaction.
    const second = new FakeChain();
    second.blockHeight = chain.blockHeight;
    const settled = await worker({ secondConnection: second.connection() }).run();
    expect(settled.settled).toEqual({ [EVENT]: "unresolved" });
    expect(store.event(EVENT)?.status).toBe("in_flight");
    expect(store.ledgerEntries()).toHaveLength(0);
    // Once it agrees, the same evidence pays the event.
    expect((await worker({ secondConnection: chain.mirror().connection() }).run()).resolved).toEqual({ [EVENT]: "paid" });
  });

  test("a missing record is retried only when the second provider agrees", async () => {
    const { chain, store, worker } = setup();
    await expect(worker({ beforeSend: () => { throw new Error("crash"); } }).run()).rejects.toThrow("crash");
    chain.blockHeight += 200;
    // The second provider sees a record the primary does not.
    const second = chain.mirror();
    const record = findSettlementRecordPda(PROGRAM_ID, setupNamespace(store), eventIdSeed(EVENT))[0];
    second.accounts.set(record.toBase58(), {
      owner: PROGRAM_ID,
      data: Buffer.from([1, ...eventIdSeed(EVENT), ...new Uint8Array(8)]),
      lamports: RECORD_RENT,
      executable: false,
      rentEpoch: 0,
    });
    expect((await worker({ secondConnection: second.connection() }).run()).resolved).toEqual({ [EVENT]: "unresolved" });
    expect(store.event(EVENT)?.status).toBe("in_flight");
    expect(chain.received).toHaveLength(0);
  });

  test("a refused send returns the event to pending, and the worker gives up after maxAttempts", async () => {
    const { chain, store, worker } = setup();
    chain.behaviours.push("refuse", "refuse");
    expect((await worker({ maxAttempts: 2 }).run()).settled).toEqual({ [EVENT]: "failed" });
    expect(store.event(EVENT)?.status).toBe("pending");
    expect((await worker({ maxAttempts: 2 }).run()).settled).toEqual({ [EVENT]: "failed" });
    expect((await worker({ maxAttempts: 2 }).run()).settled).toEqual({ [EVENT]: "needs_attention" });
    expect(store.event(EVENT)?.status).toBe("needs_attention");
    // Both attempts used the same blockhash, so they are the same transaction.
    const [first, second] = store.attempts(EVENT);
    expect(first.status).toBe("failed");
    expect(second.status).toBe("failed");
    expect(second.signature).toBe(first.signature ?? "");
  });

  test("an attempt made in another namespace is left to a person", async () => {
    const { chain, store, payer, worker } = setup();
    await expect(worker({ beforeSend: () => { throw new Error("crash"); } }).run()).rejects.toThrow("crash");
    const other = chain.openNamespace(Keypair.generate().publicKey, payer.publicKey);
    expect((await worker({ namespace: other }).run()).resolved).toEqual({ [EVENT]: "needs_attention" });
    expect(store.event(EVENT)?.status).toBe("needs_attention");
  });
});

// The namespace the stored attempts were made in.
function setupNamespace(store: Store): PublicKey {
  return new PublicKey(store.attempts(EVENT)[0].params.namespace);
}
