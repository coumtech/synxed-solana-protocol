// The worker's durable state, in SQLite (bun:sqlite). Every write that the
// settlement procedure depends on happens before the step it protects: the
// request before signing, the signature and signed bytes before sending.

import { Database } from "bun:sqlite";
import type {
  LedgerEntry,
  PayoutLine,
  SettlementRecord,
  SettlementRequestN,
} from "@coumtech/synxed-solana-protocol";

/**
 * - `pending`: no attempt can still land; the worker may send one.
 * - `in_flight`: an attempt was prepared and may have landed; only the
 *   chain decides what happened, so the worker resolves it before anything
 *   else.
 * - `paid`: reconciled against finalized evidence; ledger rows are written.
 * - `incident`: the event's record exists but matches no stored request.
 * - `needs_attention`: the worker gave up; a person decides.
 */
export type EventStatus = "pending" | "in_flight" | "paid" | "incident" | "needs_attention";

/**
 * - `prepared`: written before signing; nothing was sent.
 * - `signed`: the signature and signed bytes are stored; it may have been sent.
 * - `failed`: known not to have created the record (refused before sending,
 *   or it landed with an error).
 * - `expired`: its blockhash expired and no record exists.
 * - `landed`: the transaction that created the event's record.
 */
export type AttemptStatus = "prepared" | "signed" | "failed" | "expired" | "landed";

/** What the event is settled as. Fixed when the event is enqueued. */
export interface StoredEvent {
  eventId: string;
  request: SettlementRequestN;
  /** Stable ledger identities by share label; pooled labels have none. */
  beneficiaryIds: Readonly<Record<string, string>>;
  status: EventStatus;
  attempts: number;
  note: string | null;
}

/** The parameters an attempt was built with, kept to reconcile it later. */
export interface AttemptParams {
  programId: string;
  namespace: string;
  lamportsPerAtomicUnit: string;
  payer: string;
  authority: string;
}

export interface StoredAttempt {
  eventId: string;
  attempt: number;
  request: SettlementRequestN;
  params: AttemptParams;
  signature: string | null;
  /** The signed transaction, base64, resent unchanged until it expires. */
  rawTransaction: string | null;
  lastValidBlockHeight: number | null;
  status: AttemptStatus;
  error: string | null;
}

export interface StatusCount {
  status: EventStatus;
  count: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  beneficiary_ids TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  event_id TEXT NOT NULL REFERENCES events (event_id),
  attempt INTEGER NOT NULL,
  request TEXT NOT NULL,
  params TEXT NOT NULL,
  signature TEXT UNIQUE,
  raw_transaction TEXT,
  last_valid_block_height INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, attempt)
);
CREATE TABLE IF NOT EXISTS settlements (
  event_id TEXT PRIMARY KEY REFERENCES events (event_id),
  signature TEXT NOT NULL UNIQUE,
  record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  entry_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events (event_id),
  beneficiary_id TEXT NOT NULL,
  amount_on_chain TEXT NOT NULL,
  entry TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pool_payouts (
  event_id TEXT NOT NULL REFERENCES events (event_id),
  role TEXT NOT NULL,
  payout TEXT NOT NULL,
  PRIMARY KEY (event_id, role)
);
`;

// bigint fields travel as decimal strings.
function encodeRequest(request: SettlementRequestN): string {
  return JSON.stringify({ ...request, amountAtomic: request.amountAtomic.toString() });
}

function decodeRequest(text: string): SettlementRequestN {
  const parsed = JSON.parse(text) as Omit<SettlementRequestN, "amountAtomic"> & { amountAtomic: string };
  return { ...parsed, amountAtomic: BigInt(parsed.amountAtomic) };
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

interface EventRow {
  event_id: string;
  request: string;
  beneficiary_ids: string;
  status: EventStatus;
  attempts: number;
  note: string | null;
}

interface AttemptRow {
  event_id: string;
  attempt: number;
  request: string;
  params: string;
  signature: string | null;
  raw_transaction: string | null;
  last_valid_block_height: number | null;
  status: AttemptStatus;
  error: string | null;
}

function toEvent(row: EventRow): StoredEvent {
  return {
    eventId: row.event_id,
    request: decodeRequest(row.request),
    beneficiaryIds: JSON.parse(row.beneficiary_ids) as Record<string, string>,
    status: row.status,
    attempts: row.attempts,
    note: row.note,
  };
}

function toAttempt(row: AttemptRow): StoredAttempt {
  return {
    eventId: row.event_id,
    attempt: row.attempt,
    request: decodeRequest(row.request),
    params: JSON.parse(row.params) as AttemptParams,
    signature: row.signature,
    rawTransaction: row.raw_transaction,
    lastValidBlockHeight: row.last_valid_block_height,
    status: row.status,
    error: row.error,
  };
}

export class Store {
  readonly #db: Database;
  readonly #now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#db.exec(SCHEMA);
    this.#now = now;
  }

  close(): void {
    this.#db.close();
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  /**
   * Add an event. Enqueuing the same event again is a no-op; the same event
   * id with a different request or beneficiaries is refused, because the
   * event id is what makes the settlement idempotent on chain.
   */
  enqueue(
    request: SettlementRequestN,
    beneficiaryIds: Readonly<Record<string, string>>,
  ): "added" | "unchanged" {
    const encoded = encodeRequest(request);
    const ids = JSON.stringify(beneficiaryIds);
    const existing = this.#db
      .query<{ request: string; beneficiary_ids: string }, [string]>(
        "SELECT request, beneficiary_ids FROM events WHERE event_id = ?",
      )
      .get(request.eventId);
    if (existing !== null) {
      if (existing.request !== encoded || existing.beneficiary_ids !== ids) {
        throw new Error(`event ${request.eventId} is already stored with a different request`);
      }
      return "unchanged";
    }
    const at = this.#timestamp();
    this.#db
      .query(
        `INSERT INTO events (event_id, request, beneficiary_ids, status, attempts, note, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, NULL, ?, ?)`,
      )
      .run(request.eventId, encoded, ids, at, at);
    return "added";
  }

  event(eventId: string): StoredEvent | null {
    const row = this.#db
      .query<EventRow, [string]>("SELECT * FROM events WHERE event_id = ?")
      .get(eventId);
    return row === null ? null : toEvent(row);
  }

  eventsWithStatus(status: EventStatus, limit = -1): StoredEvent[] {
    return this.#db
      .query<EventRow, [EventStatus, number]>(
        "SELECT * FROM events WHERE status = ? ORDER BY created_at, event_id LIMIT ?",
      )
      .all(status, limit)
      .map(toEvent);
  }

  statusCounts(): StatusCount[] {
    return this.#db
      .query<StatusCount, []>(
        "SELECT status, COUNT(*) AS count FROM events GROUP BY status ORDER BY status",
      )
      .all();
  }

  attempts(eventId: string): StoredAttempt[] {
    return this.#db
      .query<AttemptRow, [string]>("SELECT * FROM attempts WHERE event_id = ? ORDER BY attempt")
      .all(eventId)
      .map(toAttempt);
  }

  /**
   * Record a new attempt before anything is signed, and mark the event in
   * flight, in one transaction. The attempt stores the exact request and
   * parameters it will be built with.
   */
  beginAttempt(eventId: string, request: SettlementRequestN, params: AttemptParams): number {
    return this.#db.transaction(() => {
      const event = this.event(eventId);
      if (event === null || event.status !== "pending") {
        throw new Error(`event ${eventId} is not pending`);
      }
      const attempt = event.attempts + 1;
      const at = this.#timestamp();
      this.#db
        .query(
          `INSERT INTO attempts (event_id, attempt, request, params, signature, raw_transaction,
             last_valid_block_height, status, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, NULL, NULL, NULL, 'prepared', NULL, ?, ?)`,
        )
        .run(eventId, attempt, encodeRequest(request), JSON.stringify(params), at, at);
      this.#db
        .query("UPDATE events SET status = 'in_flight', attempts = ?, note = NULL, updated_at = ? WHERE event_id = ?")
        .run(attempt, at, eventId);
      return attempt;
    })();
  }

  /** Store the signature and the signed bytes, before they are sent. */
  recordSigned(
    eventId: string,
    attempt: number,
    signature: string,
    rawTransaction: string,
    lastValidBlockHeight: number,
  ): void {
    this.#db
      .query(
        `UPDATE attempts SET signature = ?, raw_transaction = ?, last_valid_block_height = ?,
           status = 'signed', updated_at = ? WHERE event_id = ? AND attempt = ? AND status = 'prepared'`,
      )
      .run(signature, rawTransaction, lastValidBlockHeight, this.#timestamp(), eventId, attempt);
  }

  setAttemptStatus(
    eventId: string,
    attempt: number,
    status: Exclude<AttemptStatus, "landed">,
    error: string | null = null,
  ): void {
    this.#db
      .query("UPDATE attempts SET status = ?, error = ?, updated_at = ? WHERE event_id = ? AND attempt = ?")
      .run(status, error, this.#timestamp(), eventId, attempt);
  }

  setEventStatus(
    eventId: string,
    status: Exclude<EventStatus, "paid">,
    note: string | null = null,
  ): void {
    this.#db
      .query("UPDATE events SET status = ?, note = ?, updated_at = ? WHERE event_id = ?")
      .run(status, note, this.#timestamp(), eventId);
  }

  /**
   * Write the reconciled settlement and its ledger rows, and mark the event
   * paid and the creating attempt landed, in one transaction. Ledger entry
   * ids are deterministic, so writing the same settlement again changes
   * nothing.
   */
  recordPaid(
    eventId: string,
    attempt: number | null,
    record: SettlementRecord,
    directEntries: readonly LedgerEntry[],
    poolPayouts: readonly PayoutLine[],
  ): void {
    this.#db.transaction(() => {
      const at = this.#timestamp();
      this.#db
        .query("INSERT OR IGNORE INTO settlements (event_id, signature, record) VALUES (?, ?, ?)")
        .run(eventId, record.signature, encodeJson(record));
      for (const entry of directEntries) {
        this.#db
          .query(
            `INSERT OR IGNORE INTO ledger_entries (entry_id, event_id, beneficiary_id, amount_on_chain, entry)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(entry.entryId, eventId, entry.beneficiaryId, entry.amountOnChain, encodeJson(entry));
      }
      for (const payout of poolPayouts) {
        this.#db
          .query("INSERT OR IGNORE INTO pool_payouts (event_id, role, payout) VALUES (?, ?, ?)")
          .run(eventId, payout.role, encodeJson(payout));
      }
      if (attempt !== null) {
        this.#db
          .query("UPDATE attempts SET status = 'landed', error = NULL, updated_at = ? WHERE event_id = ? AND attempt = ?")
          .run(at, eventId, attempt);
      }
      this.#db
        .query("UPDATE events SET status = 'paid', note = NULL, updated_at = ? WHERE event_id = ?")
        .run(at, eventId);
    })();
  }

  settlement(eventId: string): SettlementRecord | null {
    const row = this.#db
      .query<{ record: string }, [string]>("SELECT record FROM settlements WHERE event_id = ?")
      .get(eventId);
    return row === null ? null : (JSON.parse(row.record) as SettlementRecord);
  }

  ledgerEntries(eventId?: string): LedgerEntry[] {
    const rows = eventId === undefined
      ? this.#db.query<{ entry: string }, []>("SELECT entry FROM ledger_entries ORDER BY rowid").all()
      : this.#db
        .query<{ entry: string }, [string]>("SELECT entry FROM ledger_entries WHERE event_id = ? ORDER BY rowid")
        .all(eventId);
    return rows.map((row) => JSON.parse(row.entry) as LedgerEntry);
  }

  /** Paid on-chain amounts per beneficiary, as decimal strings. */
  balances(): { beneficiaryId: string; amountOnChain: string }[] {
    const totals = new Map<string, bigint>();
    for (const row of this.#db
      .query<{ beneficiary_id: string; amount_on_chain: string }, []>(
        "SELECT beneficiary_id, amount_on_chain FROM ledger_entries",
      )
      .all()) {
      totals.set(row.beneficiary_id, (totals.get(row.beneficiary_id) ?? 0n) + BigInt(row.amount_on_chain));
    }
    return [...totals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([beneficiaryId, amount]) => ({ beneficiaryId, amountOnChain: amount.toString() }));
  }

  poolPayouts(eventId: string): PayoutLine[] {
    return this.#db
      .query<{ payout: string }, [string]>("SELECT payout FROM pool_payouts WHERE event_id = ? ORDER BY role")
      .all(eventId)
      .map((row) => JSON.parse(row.payout) as PayoutLine);
  }
}
