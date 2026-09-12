import { sha256 } from "@noble/hashes/sha256";
import {
  Connection,
  PublicKey,
  SystemProgram,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  SETTLE_N_HEADER_LENGTH,
  SETTLE_N_TAG,
  eventIdSeed,
  findSettlementRecordPda,
} from "./instruction.ts";
import { computeSettlementN, splitAmountAtomicShares } from "./split.ts";
import { MAX_SHARES, type SettlementRequestN } from "./types.ts";

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

const GENESIS_HASHES: Readonly<Record<LedgerCluster, string>> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  "mainnet-beta": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
};

export type LedgerCluster = "devnet" | "mainnet-beta";
export type LedgerEntryState = "accrued" | "claimable" | "paid";

export type LedgerErrorCode =
  | "TX_NOT_FOUND"
  | "TX_FAILED"
  | "TX_SIGNATURE"
  | "CLUSTER_MISMATCH"
  | "BLOCK_TIME_MISSING"
  | "PROGRAM_INSTRUCTION"
  | "INSTRUCTION_DATA"
  | "ACCOUNT_LAYOUT"
  | "MEMO_MISSING"
  | "MEMO_MISMATCH"
  | "ASSET_MISMATCH"
  | "EVENT_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "SHARES_MISMATCH"
  | "RECIPIENT_MISMATCH"
  | "TRANSFER_MISMATCH"
  | "SCALE_RANGE"
  | "POOL_ALLOCATION";

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

export interface ObservedTransfer {
  source: string;
  destination: string;
  amountOnChain: bigint;
}

/** Chain-only evidence extracted from a finalized SettleN transaction. */
export interface ProgramSettlementObservation {
  signature: string;
  slot: number;
  blockTime: number;
  payer: string;
  record: string;
  eventSeedHex: string;
  amountOnChain: bigint;
  bps: readonly number[];
  recipients: readonly string[];
  transfers: readonly ObservedTransfer[];
  memo: Readonly<Record<string, unknown>>;
}

export interface PayoutLine {
  role: string;
  recipient: string;
  bps: number;
  amountOnChain: string;
  beneficiaryId: string | null;
}

export interface SettlementRecord {
  eventId: string;
  signature: string;
  slot: number;
  cluster: LedgerCluster;
  mode: "program";
  asset: string;
  amountAtomic: string;
  unitsPerAtomicUnit: string;
  payouts: readonly PayoutLine[];
  occurredAt: string;
  settledAt: string;
}

export interface LedgerEntry {
  entryId: string;
  beneficiaryId: string;
  wallet: string | null;
  role: string;
  pool: string | null;
  amountOnChain: string;
  sourceSignature: string;
  state: LedgerEntryState;
  paidSignature: string | null;
}

export interface ClaimBatch {
  batchId: string;
  pool: string;
  entryIds: readonly string[];
  totalOnChain: string;
  signature: string | null;
}

export interface SettlementReconciliation {
  record: SettlementRecord;
  /** Direct payouts are already paid. Pool shares require off-chain allocation. */
  directEntries: readonly LedgerEntry[];
  poolPayouts: readonly PayoutLine[];
}

export interface ReconcileObservedSettlementNOptions {
  observation: ProgramSettlementObservation;
  request: SettlementRequestN;
  unitsPerAtomicUnit: bigint;
  cluster?: LedgerCluster;
  /** Stable platform IDs by share label. Wallet-derived IDs are the fallback. */
  beneficiaryIds?: Readonly<Record<string, string>>;
  /** Labels whose payout is held for later beneficiary allocation. */
  pooledLabels?: readonly string[];
  /** Explicit compatibility for transactions created before full memo evidence. */
  allowLegacyMemo?: boolean;
}

export interface ReconcileSettlementNOptions
  extends Omit<ReconcileObservedSettlementNOptions, "observation"> {
  connection: Connection;
  signature: string;
  programId: PublicKey;
  finalityTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** Fetch and reconcile a finalized program-mode SettleN transaction. */
export async function reconcileSettlementN(
  options: ReconcileSettlementNOptions,
): Promise<SettlementReconciliation> {
  const timeoutMs = options.finalityTimeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const cluster = options.cluster ?? "devnet";
  if (timeoutMs <= 0 || pollIntervalMs <= 0) {
    throw new LedgerError(
      "TX_NOT_FOUND",
      "finality timeout and poll interval must be positive",
    );
  }
  const genesisHash = await options.connection.getGenesisHash();
  if (genesisHash !== GENESIS_HASHES[cluster]) {
    throw new LedgerError(
      "CLUSTER_MISMATCH",
      `RPC genesis hash does not identify ${cluster}`,
    );
  }
  const deadline = Date.now() + timeoutMs;
  let transaction: ParsedTransactionWithMeta | null = null;
  do {
    transaction = await options.connection.getParsedTransaction(
      options.signature,
      { commitment: "finalized", maxSupportedTransactionVersion: 0 },
    );
    if (transaction !== null) {
      break;
    }
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  if (transaction === null) {
    throw new LedgerError(
      "TX_NOT_FOUND",
      `finalized transaction ${options.signature} was not found`,
    );
  }
  const observation = observeProgramSettlement(
    transaction,
    options.signature,
    options.programId,
  );
  return reconcileObservedSettlementN({
    observation,
    request: options.request,
    unitsPerAtomicUnit: options.unitsPerAtomicUnit,
    cluster,
    ...(options.beneficiaryIds !== undefined
      ? { beneficiaryIds: options.beneficiaryIds }
      : {}),
    ...(options.pooledLabels !== undefined
      ? { pooledLabels: options.pooledLabels }
      : {}),
    ...(options.allowLegacyMemo !== undefined
      ? { allowLegacyMemo: options.allowLegacyMemo }
      : {}),
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Extract fail-closed evidence from the RPC's parsed transaction shape. */
export function observeProgramSettlement(
  transaction: ParsedTransactionWithMeta,
  signature: string,
  programId: PublicKey,
): ProgramSettlementObservation {
  if (transaction.meta === null || transaction.meta.err !== null) {
    throw new LedgerError("TX_FAILED", `transaction ${signature} did not succeed`);
  }
  if (!transaction.transaction.signatures.includes(signature)) {
    throw new LedgerError(
      "TX_SIGNATURE",
      `RPC response does not contain requested signature ${signature}`,
    );
  }
  if (transaction.blockTime === undefined || transaction.blockTime === null) {
    throw new LedgerError(
      "BLOCK_TIME_MISSING",
      `transaction ${signature} has no block time`,
    );
  }

  const matches = transaction.transaction.message.instructions
    .map((instruction, index) => ({ instruction, index }))
    .filter(({ instruction }) => instruction.programId.equals(programId));
  if (matches.length !== 1 || !isPartiallyDecoded(matches[0].instruction)) {
    throw new LedgerError(
      "PROGRAM_INSTRUCTION",
      `expected exactly one raw instruction for program ${programId.toBase58()}`,
    );
  }
  const programInstruction = matches[0].instruction;
  const decoded = decodeSettleNData(programInstruction.data);
  const expectedAccountCount = decoded.bps.length + 3;
  if (programInstruction.accounts.length !== expectedAccountCount) {
    throw new LedgerError(
      "ACCOUNT_LAYOUT",
      `SettleN expected ${expectedAccountCount} accounts, got ${programInstruction.accounts.length}`,
    );
  }
  const payer = programInstruction.accounts[0].toBase58();
  const recipients = programInstruction.accounts
    .slice(1, 1 + decoded.bps.length)
    .map((key) => key.toBase58());
  const recordKey = programInstruction.accounts[1 + decoded.bps.length];
  const systemProgram = programInstruction.accounts[2 + decoded.bps.length];
  const [derivedRecord] = findSettlementRecordPda(programId, decoded.eventSeed);
  if (!recordKey.equals(derivedRecord) || !systemProgram.equals(SystemProgram.programId)) {
    throw new LedgerError(
      "ACCOUNT_LAYOUT",
      "settlement record or system-program account does not match SettleN",
    );
  }

  const memo = extractMemo(transaction);
  const inner = transaction.meta.innerInstructions?.find(
    (group) => group.index === matches[0].index,
  );
  if (inner === undefined) {
    throw new LedgerError(
      "TRANSFER_MISMATCH",
      "settlement instruction has no recorded inner instructions",
    );
  }
  const transfers = inner.instructions.flatMap((instruction) => {
    const transfer = parseSystemTransfer(instruction);
    return transfer === null ? [] : [transfer];
  });

  return {
    signature,
    slot: transaction.slot,
    blockTime: transaction.blockTime,
    payer,
    record: recordKey.toBase58(),
    eventSeedHex: toHex(decoded.eventSeed),
    amountOnChain: decoded.amount,
    bps: decoded.bps,
    recipients,
    transfers,
    memo,
  };
}

/** Compare caller context with chain evidence and build derivable ledger rows. */
export function reconcileObservedSettlementN(
  options: ReconcileObservedSettlementNOptions,
): SettlementReconciliation {
  const {
    observation,
    request,
    unitsPerAtomicUnit,
    beneficiaryIds = {},
    pooledLabels = ["rewards_pool"],
    allowLegacyMemo = false,
  } = options;
  computeSettlementN(request);
  if (unitsPerAtomicUnit <= 0n) {
    throw new LedgerError(
      "SCALE_RANGE",
      "unitsPerAtomicUnit must be a positive bigint",
    );
  }
  if (observation.eventSeedHex !== toHex(eventIdSeed(request.eventId))) {
    throw new LedgerError("EVENT_MISMATCH", "event id does not match the on-chain seed");
  }
  const expectedTotal = request.amountAtomic * unitsPerAtomicUnit;
  if (observation.amountOnChain !== expectedTotal) {
    throw new LedgerError(
      "AMOUNT_MISMATCH",
      `expected ${expectedTotal} on-chain units, observed ${observation.amountOnChain}`,
    );
  }
  if (request.asset !== "SOL_LAMPORTS_STANDIN") {
    throw new LedgerError(
      "ASSET_MISMATCH",
      "native SettleN evidence can only reconcile SOL_LAMPORTS_STANDIN",
    );
  }
  const expectedBps = request.shares.map((share) => share.bps);
  if (!sameNumbers(observation.bps, expectedBps)) {
    throw new LedgerError("SHARES_MISMATCH", "share bps do not match chain evidence");
  }
  const expectedRecipients = request.shares.map((share) => share.recipient);
  if (!sameStrings(observation.recipients, expectedRecipients)) {
    throw new LedgerError(
      "RECIPIENT_MISMATCH",
      "share recipients do not match chain evidence",
    );
  }
  assertMemo(observation.memo, request, expectedTotal, allowLegacyMemo);

  const amounts = splitAmountAtomicShares(expectedTotal, expectedBps);
  const expectedTransfers = request.shares.flatMap((share, index) => {
    const amount = amounts[index];
    return amount === 0n
      ? []
      : [transferKey(observation.payer, share.recipient, amount)];
  });
  const observedTransfers = observation.transfers
    .filter((transfer) => transfer.destination !== observation.record)
    .map((transfer) =>
      transferKey(transfer.source, transfer.destination, transfer.amountOnChain),
    );
  if (!sameStrings(sorted(expectedTransfers), sorted(observedTransfers))) {
    throw new LedgerError(
      "TRANSFER_MISMATCH",
      "inner system transfers do not exactly match the configured payouts",
    );
  }

  const pooled = new Set(pooledLabels);
  for (const [label, beneficiaryId] of Object.entries(beneficiaryIds)) {
    if (beneficiaryId.trim() === "") {
      throw new LedgerError(
        "RECIPIENT_MISMATCH",
        `beneficiary id for "${label}" must not be empty`,
      );
    }
  }
  const payouts: PayoutLine[] = request.shares.map((share, index) => ({
    role: canonicalRole(share.label),
    recipient: share.recipient,
    bps: share.bps,
    amountOnChain: amounts[index].toString(),
    beneficiaryId: pooled.has(share.label)
      ? null
      : (beneficiaryIds[share.label] ?? `wallet:${share.recipient}`),
  }));
  const record: SettlementRecord = {
    eventId: request.eventId,
    signature: observation.signature,
    slot: observation.slot,
    cluster: options.cluster ?? "devnet",
    mode: "program",
    asset: request.asset,
    amountAtomic: request.amountAtomic.toString(),
    unitsPerAtomicUnit: unitsPerAtomicUnit.toString(),
    payouts,
    occurredAt: request.occurredAt,
    settledAt: new Date(observation.blockTime * 1_000).toISOString(),
  };
  const directEntries = payouts.flatMap((payout) => {
    if (payout.beneficiaryId === null) {
      return [];
    }
    return [
      {
        entryId: ledgerEntryId(
          observation.signature,
          payout.role,
          payout.beneficiaryId,
        ),
        beneficiaryId: payout.beneficiaryId,
        wallet: payout.recipient,
        role: payout.role,
        pool: null,
        amountOnChain: payout.amountOnChain,
        sourceSignature: observation.signature,
        state: "paid" as const,
        paidSignature: observation.signature,
      },
    ];
  });
  return {
    record,
    directEntries,
    poolPayouts: payouts.filter((payout) => payout.beneficiaryId === null),
  };
}

export interface PoolAllocation {
  beneficiaryId: string;
  wallet?: string;
  amountOnChain: bigint;
}

/** Turn one pooled payout into conserved, idempotent accrued ledger entries. */
export function allocatePoolPayout(
  payout: PayoutLine,
  sourceSignature: string,
  allocations: readonly PoolAllocation[],
): readonly LedgerEntry[] {
  if (payout.beneficiaryId !== null || allocations.length === 0) {
    throw new LedgerError(
      "POOL_ALLOCATION",
      "pool allocation requires a pooled payout and at least one beneficiary",
    );
  }
  const ids = new Set<string>();
  let total = 0n;
  for (const allocation of allocations) {
    if (
      allocation.beneficiaryId.trim() === "" ||
      allocation.amountOnChain <= 0n ||
      ids.has(allocation.beneficiaryId)
    ) {
      throw new LedgerError(
        "POOL_ALLOCATION",
        "beneficiary IDs must be unique and amounts must be positive",
      );
    }
    ids.add(allocation.beneficiaryId);
    total += allocation.amountOnChain;
  }
  if (total !== BigInt(payout.amountOnChain)) {
    throw new LedgerError(
      "POOL_ALLOCATION",
      `pool allocations total ${total}, expected ${payout.amountOnChain}`,
    );
  }
  return allocations.map((allocation) => ({
    entryId: ledgerEntryId(
      sourceSignature,
      payout.role,
      allocation.beneficiaryId,
    ),
    beneficiaryId: allocation.beneficiaryId,
    wallet: allocation.wallet ?? null,
    role: payout.role,
    pool: payout.recipient,
    amountOnChain: allocation.amountOnChain.toString(),
    sourceSignature,
    state: "accrued",
    paidSignature: null,
  }));
}

export function ledgerEntryId(
  signature: string,
  role: string,
  beneficiaryId: string,
): string {
  return toHex(
    sha256(new TextEncoder().encode(`${signature}\u0000${role}\u0000${beneficiaryId}`)),
  );
}

function decodeSettleNData(data: string): {
  eventSeed: Uint8Array;
  amount: bigint;
  bps: readonly number[];
} {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(data);
  } catch {
    throw new LedgerError("INSTRUCTION_DATA", "SettleN data is not valid base58");
  }
  if (bytes.length < SETTLE_N_HEADER_LENGTH || bytes[0] !== SETTLE_N_TAG) {
    throw new LedgerError("INSTRUCTION_DATA", "instruction is not SettleN");
  }
  const count = bytes[41];
  if (
    count === 0 ||
    count > MAX_SHARES ||
    bytes.length !== SETTLE_N_HEADER_LENGTH + 2 * count
  ) {
    throw new LedgerError("INSTRUCTION_DATA", "SettleN share count or length is invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bps = Array.from({ length: count }, (_, index) =>
    view.getUint16(SETTLE_N_HEADER_LENGTH + 2 * index, true),
  );
  return {
    eventSeed: bytes.slice(1, 33),
    amount: view.getBigUint64(33, true),
    bps,
  };
}

function extractMemo(
  transaction: ParsedTransactionWithMeta,
): Readonly<Record<string, unknown>> {
  const memos = transaction.transaction.message.instructions.filter(
    (instruction) => instruction.programId.equals(MEMO_PROGRAM_ID),
  );
  if (memos.length !== 1 || !isParsedInstruction(memos[0])) {
    throw new LedgerError("MEMO_MISSING", "expected exactly one parsed memo instruction");
  }
  const parsed: unknown = memos[0].parsed;
  if (typeof parsed !== "string") {
    throw new LedgerError("MEMO_MISSING", "settlement memo is not text");
  }
  try {
    const value: unknown = JSON.parse(parsed);
    if (!isRecord(value)) {
      throw new Error("memo must be an object");
    }
    return value;
  } catch {
    throw new LedgerError("MEMO_MISSING", "settlement memo is not valid JSON");
  }
}

function assertMemo(
  memo: Readonly<Record<string, unknown>>,
  request: SettlementRequestN,
  expectedTotal: bigint,
  allowLegacyMemo: boolean,
): void {
  if (
    memo["protocol"] !== "synxed-settlement" ||
    memo["event"] !== request.eventId ||
    memo["kind"] !== request.kind ||
    memo["lamports"] !== expectedTotal.toString() ||
    memo["memo"] !== request.memo
  ) {
    throw new LedgerError(
      "MEMO_MISMATCH",
      "memo protocol, event, kind, or amount does not match the request",
    );
  }
  if (
    (!allowLegacyMemo || memo["occurredAt"] !== undefined) &&
    memo["occurredAt"] !== request.occurredAt
  ) {
    throw new LedgerError("MEMO_MISMATCH", "memo occurredAt does not match the request");
  }
  if (
    (!allowLegacyMemo || memo["asset"] !== undefined) &&
    memo["asset"] !== request.asset
  ) {
    throw new LedgerError("MEMO_MISMATCH", "memo asset does not match the request");
  }
}

function parseSystemTransfer(
  instruction: ParsedInstruction | PartiallyDecodedInstruction,
): ObservedTransfer | null {
  if (!isParsedInstruction(instruction) || instruction.program !== "system") {
    return null;
  }
  const parsed: unknown = instruction.parsed;
  if (!isRecord(parsed) || parsed["type"] !== "transfer") {
    return null;
  }
  const info = parsed["info"];
  if (!isRecord(info)) {
    throw new LedgerError("TRANSFER_MISMATCH", "system transfer info is malformed");
  }
  const source = info["source"];
  const destination = info["destination"];
  const lamports = info["lamports"];
  if (
    typeof source !== "string" ||
    typeof destination !== "string" ||
    typeof lamports !== "number" ||
    !Number.isSafeInteger(lamports) ||
    lamports < 0
  ) {
    throw new LedgerError("TRANSFER_MISMATCH", "system transfer fields are malformed");
  }
  return { source, destination, amountOnChain: BigInt(lamports) };
}

function isPartiallyDecoded(
  instruction: ParsedInstruction | PartiallyDecodedInstruction,
): instruction is PartiallyDecodedInstruction {
  return "accounts" in instruction && "data" in instruction;
}

function isParsedInstruction(
  instruction: ParsedInstruction | PartiallyDecodedInstruction,
): instruction is ParsedInstruction {
  return "parsed" in instruction;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function canonicalRole(label: string): string {
  return label === "synxed" ? "platform" : label;
}

function transferKey(source: string, destination: string, amount: bigint): string {
  return `${source}\u0000${destination}\u0000${amount}`;
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
