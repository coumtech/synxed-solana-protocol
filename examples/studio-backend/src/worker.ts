// The settlement worker: settles pending events one transaction each, and
// decides every uncertain outcome from the chain, following known limitation 1
// of docs/security-model.md. It never marks an event paid without finalized
// evidence that matches a stored request, and never sends a second attempt
// while an earlier one could still land.

import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  LedgerError,
  buildSettlementNTransaction,
  eventIdSeed,
  fetchSettlementRecord,
  findSettlementTransaction,
  reconcileSettlementN,
  type LedgerCluster,
  type LedgerErrorCode,
  type SettlementReconciliation,
  type SettlementRequestN,
} from "@coumtech/synxed-solana-protocol";
import type { AttemptParams, StoredAttempt, StoredEvent, Store } from "./store.ts";

/** Ledger errors that mean the evidence contradicts the request. */
const MISMATCH_CODES: ReadonlySet<LedgerErrorCode> = new Set([
  "NAMESPACE_MISMATCH",
  "EVENT_MISMATCH",
  "AMOUNT_MISMATCH",
  "ASSET_MISMATCH",
  "SHARES_MISMATCH",
  "RECIPIENT_MISMATCH",
  "TRANSFER_MISMATCH",
  "MEMO_MISMATCH",
  "MEMO_MISSING",
]);

export interface WorkerOptions {
  store: Store;
  connection: Connection;
  /**
   * A second, independent RPC provider. A paid event, an incident, and a
   * missing record before a new attempt are all confirmed on it. Without it
   * the primary is trusted alone, which is fine on devnet only.
   */
  secondConnection?: Connection;
  payer: Keypair;
  /** The namespace authority, when it is not the payer. */
  authority?: Keypair;
  programId: PublicKey;
  /** The pinned settlement namespace; it must exist already. */
  namespace: PublicKey;
  lamportsPerAtomicUnit: bigint;
  cluster?: LedgerCluster;
  /** Attempts per event before a person must look (default 5). */
  maxAttempts?: number;
  /** How long to wait for finality when reconciling (default 90 seconds). */
  finalityTimeoutMs?: number;
  pollIntervalMs?: number;
  log?: (line: string) => void;
  /** Runs after an attempt's signature is stored, before it is sent. */
  beforeSend?: (eventId: string, signature: string) => void;
}

/**
 * - `paid`: reconciled and written to the ledger.
 * - `waiting`: an attempt may still land; resolve it again later.
 * - `retry`: no attempt can land and no record exists; the event is pending.
 * - `failed`: this attempt was refused; the event is pending again.
 * - `incident`: the record matches no stored request.
 * - `unresolved`: the evidence is incomplete or the providers disagree.
 * - `needs_attention`: the worker gave up on the event.
 */
export type Outcome =
  | "paid"
  | "waiting"
  | "retry"
  | "failed"
  | "incident"
  | "unresolved"
  | "needs_attention";

export interface DryRunResult {
  eventId: string;
  lamportsTotal: bigint;
  lamportsByShare: readonly bigint[];
  /** The simulation's error, or null when it would succeed. */
  error: unknown;
  logs: readonly string[];
}

export interface RunSummary {
  resolved: Record<string, Outcome>;
  settled: Record<string, Outcome>;
}

type ReconcileResult =
  | { ok: true; reconciliation: SettlementReconciliation }
  | { ok: false; mismatch: boolean; error: string };

export class SettlementWorker {
  readonly #options: WorkerOptions;
  readonly #authority: Keypair;
  readonly #maxAttempts: number;
  readonly #log: (line: string) => void;

  constructor(options: WorkerOptions) {
    this.#options = options;
    this.#authority = options.authority ?? options.payer;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#log = options.log ?? (() => {});
  }

  /**
   * Resolve every in-flight event first, then settle up to `limit` pending
   * ones. Only one attempt per event is ever open at a time.
   */
  async run(limit = 10): Promise<RunSummary> {
    const { store } = this.#options;
    const summary: RunSummary = { resolved: {}, settled: {} };
    for (const event of store.eventsWithStatus("in_flight")) {
      summary.resolved[event.eventId] = await this.resolve(event.eventId);
    }
    for (const event of store.eventsWithStatus("pending", limit)) {
      summary.settled[event.eventId] = await this.settle(event);
    }
    return summary;
  }

  /** Build and simulate pending events without signing, sending, or writing. */
  async dryRun(limit = 10): Promise<DryRunResult[]> {
    const { connection, payer, store } = this.#options;
    const results: DryRunResult[] = [];
    for (const event of store.eventsWithStatus("pending", limit)) {
      const prepared = this.#build(event.request);
      prepared.transaction.feePayer = payer.publicKey;
      prepared.transaction.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      const simulated = await connection.simulateTransaction(
        new VersionedTransaction(prepared.transaction.compileMessage()),
        { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
      );
      results.push({
        eventId: event.eventId,
        lamportsTotal: prepared.lamportsTotal,
        lamportsByShare: prepared.lamportsByShare,
        error: simulated.value.err,
        logs: simulated.value.logs ?? [],
      });
    }
    return results;
  }

  /**
   * Send one attempt for a pending event and follow it to an outcome. The
   * request is stored before signing and the signature before sending, so a
   * crash at any point leaves enough to resolve the event from the chain.
   */
  async settle(event: StoredEvent): Promise<Outcome> {
    const { store, connection, payer } = this.#options;
    if (event.attempts >= this.#maxAttempts) {
      store.setEventStatus(event.eventId, "needs_attention", `${event.attempts} attempts failed`);
      return "needs_attention";
    }
    const attempt = store.beginAttempt(event.eventId, event.request, this.#params());
    const prepared = this.#build(event.request);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const transaction = prepared.transaction;
    transaction.feePayer = payer.publicKey;
    transaction.recentBlockhash = blockhash;
    transaction.sign(...this.#signers());
    if (transaction.signature === null) {
      throw new Error("the transaction was not signed");
    }
    const signature = bs58.encode(transaction.signature);
    const raw = transaction.serialize();
    store.recordSigned(event.eventId, attempt, signature, raw.toString("base64"), lastValidBlockHeight);
    this.#options.beforeSend?.(event.eventId, signature);
    this.#log(`${event.eventId}: attempt ${attempt} sent as ${signature}`);
    try {
      await connection.sendRawTransaction(raw, { preflightCommitment: "confirmed" });
    } catch (error) {
      // With preflight on, a simulation failure means the node did not
      // forward the transaction, so this attempt cannot land.
      if (error instanceof SendTransactionError && error.message.startsWith("Simulation failed")) {
        store.setAttemptStatus(event.eventId, attempt, "failed", error.transactionError.message);
        if (!/account already initialized/i.test(error.transactionError.message)) {
          store.setEventStatus(event.eventId, "pending", error.transactionError.message);
          this.#log(`${event.eventId}: attempt ${attempt} refused: ${error.transactionError.message}`);
          return "failed";
        }
        // The event's record exists already: the chain decides below.
        this.#log(`${event.eventId}: already settled in this namespace`);
      } else {
        // Anything else leaves it unknown whether the cluster has it.
        this.#log(`${event.eventId}: send outcome unknown: ${String(error)}`);
      }
    }
    return this.#awaitOutcome(event.eventId);
  }

  /**
   * Decide an in-flight event from the chain: wait for any attempt that may
   * still land, then let the event's settlement record decide.
   */
  async resolve(eventId: string): Promise<Outcome> {
    const { store, connection, programId, namespace } = this.#options;
    const event = store.event(eventId);
    if (event === null || event.status !== "in_flight") {
      throw new Error(`event ${eventId} is not in flight`);
    }
    const attempts = store.attempts(eventId);
    const elsewhere = attempts.find(
      (attempt) => attempt.params.programId !== programId.toBase58() || attempt.params.namespace !== namespace.toBase58(),
    );
    if (elsewhere !== undefined) {
      // Its record lives in another namespace, which this worker does not read.
      store.setEventStatus(eventId, "needs_attention", `attempt ${elsewhere.attempt} was made in another namespace`);
      return "needs_attention";
    }
    if (await this.#mayStillLand(attempts)) {
      return "waiting";
    }
    const seed = eventIdSeed(eventId);
    const record = await fetchSettlementRecord(connection, programId, namespace, seed);
    if (record === null) {
      const second = this.#options.secondConnection;
      if (second !== undefined && (await fetchSettlementRecord(second, programId, namespace, seed)) !== null) {
        store.setEventStatus(eventId, "in_flight", "the providers disagree on the record");
        return "unresolved";
      }
      for (const attempt of attempts) {
        if (attempt.status === "signed") {
          store.setAttemptStatus(eventId, attempt.attempt, "expired");
        }
      }
      if (event.attempts >= this.#maxAttempts) {
        store.setEventStatus(eventId, "needs_attention", `${event.attempts} attempts did not land`);
        return "needs_attention";
      }
      store.setEventStatus(eventId, "pending", "no attempt landed");
      return "retry";
    }
    return this.#resolveRecord(event, attempts);
  }

  // The record exists: find the transaction that created it and reconcile it
  // against every request stored for the event.
  async #resolveRecord(event: StoredEvent, attempts: readonly StoredAttempt[]): Promise<Outcome> {
    const { store, connection, programId, namespace } = this.#options;
    let created;
    try {
      created = await findSettlementTransaction({ connection, programId, namespace, eventId: event.eventId });
    } catch (error) {
      store.setEventStatus(event.eventId, "in_flight", `creating transaction not found: ${String(error)}`);
      return "unresolved";
    }
    if (!created.topLevel) {
      store.setEventStatus(event.eventId, "in_flight", `${created.signature} settled through another program; compare it by hand`);
      return "unresolved";
    }
    const requests = distinctRequests(attempts.length > 0 ? attempts : [{ request: event.request, params: this.#params() }]);
    const primary = await Promise.all(
      requests.map((stored) => this.#reconcile(connection, created.signature, stored)),
    );
    const matched = primary.findIndex((result) => result.ok);
    if (matched !== -1) {
      const stored = requests[matched];
      const second = this.#options.secondConnection;
      if (second !== undefined && !(await this.#reconcile(second, created.signature, stored)).ok) {
        store.setEventStatus(event.eventId, "in_flight", "the providers disagree on the creating transaction");
        return "unresolved";
      }
      // The decision was made without beneficiary ids, which only label rows.
      const rows = await this.#reconcile(connection, created.signature, stored, event.beneficiaryIds);
      if (!rows.ok) {
        store.setEventStatus(event.eventId, "in_flight", rows.error);
        return "unresolved";
      }
      const landed = attempts.find((attempt) => attempt.signature === created.signature)?.attempt ?? null;
      store.recordPaid(
        event.eventId,
        landed,
        rows.reconciliation.record,
        rows.reconciliation.directEntries,
        rows.reconciliation.poolPayouts,
      );
      this.#log(`${event.eventId}: paid by ${created.signature}`);
      return "paid";
    }
    if (primary.every((result) => !result.ok && result.mismatch)) {
      const second = this.#options.secondConnection;
      const confirmed = second === undefined ||
        (await Promise.all(requests.map((stored) => this.#reconcile(second, created.signature, stored))))
          .every((result) => !result.ok && result.mismatch);
      if (confirmed) {
        // The namespace's authority settled something nobody recorded.
        store.setEventStatus(event.eventId, "incident", `${created.signature} matches no stored request`);
        this.#log(`${event.eventId}: INCIDENT, ${created.signature} matches no stored request`);
        return "incident";
      }
    }
    const reasons = primary.flatMap((result) => (result.ok ? [] : [result.error]));
    store.setEventStatus(event.eventId, "in_flight", reasons.join("; "));
    return "unresolved";
  }

  // Resolve until the outcome is known, for at most the finality timeout.
  async #awaitOutcome(eventId: string): Promise<Outcome> {
    const deadline = Date.now() + (this.#options.finalityTimeoutMs ?? 90_000);
    for (;;) {
      const outcome = await this.resolve(eventId);
      if (outcome !== "waiting" || Date.now() >= deadline) {
        return outcome;
      }
      await delay(this.#options.pollIntervalMs ?? 2_000);
    }
  }

  /**
   * Whether any signed attempt could still land. A signed attempt the
   * cluster has not seen is resent unchanged while its blockhash is valid;
   * the same bytes have the same signature, so it can land at most once.
   * An attempt that landed with an error is known not to have created the
   * record, once that is finalized.
   */
  async #mayStillLand(attempts: readonly StoredAttempt[]): Promise<boolean> {
    const { store, connection } = this.#options;
    let waiting = false;
    let height: number | null = null;
    for (const attempt of attempts) {
      if (attempt.status === "prepared") {
        // Never signed, so it can never land.
        store.setAttemptStatus(attempt.eventId, attempt.attempt, "failed", "never signed");
        continue;
      }
      if (attempt.status !== "signed" || attempt.signature === null) {
        continue;
      }
      const { value } = await connection.getSignatureStatuses([attempt.signature], {
        searchTransactionHistory: true,
      });
      const status = value[0] ?? null;
      if (status !== null) {
        if (status.confirmationStatus !== "finalized" && status.confirmationStatus !== "confirmed") {
          waiting = true;
        } else if (status.err !== null) {
          if (status.confirmationStatus === "finalized") {
            store.setAttemptStatus(attempt.eventId, attempt.attempt, "failed", JSON.stringify(status.err));
          } else {
            waiting = true;
          }
        }
        continue;
      }
      height ??= await connection.getBlockHeight("confirmed");
      if (attempt.lastValidBlockHeight !== null && height <= attempt.lastValidBlockHeight && attempt.rawTransaction !== null) {
        await connection
          .sendRawTransaction(Buffer.from(attempt.rawTransaction, "base64"), { skipPreflight: true })
          .catch(() => undefined);
        waiting = true;
      }
    }
    return waiting;
  }

  async #reconcile(
    connection: Connection,
    signature: string,
    stored: { request: SettlementRequestN; params: AttemptParams },
    beneficiaryIds?: Readonly<Record<string, string>>,
  ): Promise<ReconcileResult> {
    try {
      const reconciliation = await reconcileSettlementN({
        connection,
        signature,
        programId: new PublicKey(stored.params.programId),
        namespace: new PublicKey(stored.params.namespace),
        request: stored.request,
        unitsPerAtomicUnit: BigInt(stored.params.lamportsPerAtomicUnit),
        cluster: this.#options.cluster ?? "devnet",
        ...(beneficiaryIds !== undefined ? { beneficiaryIds } : {}),
        ...(this.#options.finalityTimeoutMs !== undefined ? { finalityTimeoutMs: this.#options.finalityTimeoutMs } : {}),
        ...(this.#options.pollIntervalMs !== undefined ? { pollIntervalMs: this.#options.pollIntervalMs } : {}),
      });
      return { ok: true, reconciliation };
    } catch (error) {
      const mismatch = error instanceof LedgerError && MISMATCH_CODES.has(error.code);
      return { ok: false, mismatch, error: String(error) };
    }
  }

  #build(request: SettlementRequestN) {
    const { payer, programId, namespace, lamportsPerAtomicUnit } = this.#options;
    return buildSettlementNTransaction({
      payer: payer.publicKey,
      request,
      lamportsPerAtomicUnit,
      programId,
      namespace,
      authority: this.#authority.publicKey,
    });
  }

  #signers(): Keypair[] {
    const { payer } = this.#options;
    return this.#authority.publicKey.equals(payer.publicKey) ? [payer] : [payer, this.#authority];
  }

  #params(): AttemptParams {
    const { programId, namespace, lamportsPerAtomicUnit, payer } = this.#options;
    return {
      programId: programId.toBase58(),
      namespace: namespace.toBase58(),
      lamportsPerAtomicUnit: lamportsPerAtomicUnit.toString(),
      payer: payer.publicKey.toBase58(),
      authority: this.#authority.publicKey.toBase58(),
    };
  }
}

// One entry per distinct stored request, keeping the first attempt's params.
function distinctRequests(
  attempts: readonly { request: SettlementRequestN; params: AttemptParams }[],
): { request: SettlementRequestN; params: AttemptParams }[] {
  const seen = new Set<string>();
  return attempts.filter((attempt) => {
    const key = JSON.stringify({ ...attempt.request, amountAtomic: attempt.request.amountAtomic.toString() }) +
      JSON.stringify(attempt.params);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
