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
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  SETTLE_N_HEADER_LENGTH,
  SETTLE_N_TAG,
  SETTLE_TOKEN_N_HEADER_LENGTH,
  SETTLE_TOKEN_N_TAG,
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

export interface ObservedTokenTransfer extends ObservedTransfer {
  mint: string;
  decimals: number;
}

/** Chain-only evidence extracted from a finalized SettleN transaction. */
export interface ProgramSettlementObservation {
  signature: string;
  slot: number;
  blockTime: number;
  programId: string;
  payer: string;
  record: string;
  eventSeedHex: string;
  amountOnChain: bigint;
  bps: readonly number[];
  recipients: readonly string[];
  transfers: readonly ObservedTransfer[];
  memo: Readonly<Record<string, unknown>>;
}

export interface ProgramTokenSettlementObservation {
  signature: string;
  slot: number;
  blockTime: number;
  programId: string;
  payer: string;
  sourceTokenAccount: string;
  recipientTokenAccounts: readonly string[];
  mint: string;
  record: string;
  eventSeedHex: string;
  amountOnChain: bigint;
  decimals: number;
  bps: readonly number[];
  transfers: readonly ObservedTokenTransfer[];
  memo: Readonly<Record<string, unknown>>;
}

export interface PayoutLine {
  role: string;
  recipient: string;
  bps: number;
  amountOnChain: string;
  beneficiaryId: string | null;
  /** Token account for SPL payouts; recipient wallet for native payouts. */
  destinationAccount: string;
}

export interface SettlementRecord {
  schemaVersion: 1;
  eventId: string;
  signature: string;
  slot: number;
  cluster: LedgerCluster;
  programId: string;
  payer: string;
  settlementRecord: string;
  mode: "program" | "program-token";
  asset: string;
  mint: string | null;
  decimals: number | null;
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

export interface ReconcileObservedTokenSettlementNOptions {
  observation: ProgramTokenSettlementObservation;
  request: SettlementRequestN;
  tokenBaseUnitsPerAtomicUnit: bigint;
  mint: PublicKey;
  decimals: number;
  cluster?: LedgerCluster;
  beneficiaryIds?: Readonly<Record<string, string>>;
  pooledLabels?: readonly string[];
}

export interface ReconcileTokenSettlementNOptions
  extends Omit<ReconcileObservedTokenSettlementNOptions, "observation"> {
  connection: Connection;
  signature: string;
  programId: PublicKey;
  finalityTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** Fail before signing when an RPC endpoint is not the expected cluster. */
export async function assertLedgerCluster(
  connection: Pick<Connection, "getGenesisHash">,
  cluster: LedgerCluster = "devnet",
): Promise<void> {
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== GENESIS_HASHES[cluster]) {
    throw new LedgerError(
      "CLUSTER_MISMATCH",
      `RPC genesis hash does not identify ${cluster}`,
    );
  }
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
  await assertLedgerCluster(options.connection, cluster);
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
    programId: programId.toBase58(),
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
    destinationAccount: share.recipient,
  }));
  const record: SettlementRecord = {
    schemaVersion: 1,
    eventId: request.eventId,
    signature: observation.signature,
    slot: observation.slot,
    cluster: options.cluster ?? "devnet",
    programId: observation.programId,
    payer: observation.payer,
    settlementRecord: observation.record,
    mode: "program",
    asset: request.asset,
    mint: null,
    decimals: null,
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

/** Fetch and reconcile a finalized classic SPL Token SettleTokenN transaction. */
export async function reconcileTokenSettlementN(
  options: ReconcileTokenSettlementNOptions,
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
  await assertLedgerCluster(options.connection, cluster);
  const deadline = Date.now() + timeoutMs;
  let transaction: ParsedTransactionWithMeta | null = null;
  do {
    transaction = await options.connection.getParsedTransaction(options.signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (transaction !== null) break;
    await delay(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  if (transaction === null) {
    throw new LedgerError(
      "TX_NOT_FOUND",
      `finalized transaction ${options.signature} was not found`,
    );
  }
  return reconcileObservedTokenSettlementN({
    observation: observeProgramTokenSettlement(
      transaction,
      options.signature,
      options.programId,
    ),
    request: options.request,
    tokenBaseUnitsPerAtomicUnit: options.tokenBaseUnitsPerAtomicUnit,
    mint: options.mint,
    decimals: options.decimals,
    cluster,
    ...(options.beneficiaryIds !== undefined
      ? { beneficiaryIds: options.beneficiaryIds }
      : {}),
    ...(options.pooledLabels !== undefined
      ? { pooledLabels: options.pooledLabels }
      : {}),
  });
}

export function observeProgramTokenSettlement(
  transaction: ParsedTransactionWithMeta,
  signature: string,
  programId: PublicKey,
): ProgramTokenSettlementObservation {
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
    throw new LedgerError("BLOCK_TIME_MISSING", `transaction ${signature} has no block time`);
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
  const decoded = decodeSettleTokenNData(programInstruction.data);
  const expectedAccountCount = decoded.bps.length + 6;
  if (programInstruction.accounts.length !== expectedAccountCount) {
    throw new LedgerError(
      "ACCOUNT_LAYOUT",
      `SettleTokenN expected ${expectedAccountCount} accounts, got ${programInstruction.accounts.length}`,
    );
  }
  const count = decoded.bps.length;
  const payer = programInstruction.accounts[0].toBase58();
  const sourceTokenAccount = programInstruction.accounts[1].toBase58();
  const recipientTokenAccounts = programInstruction.accounts
    .slice(2, 2 + count)
    .map((key) => key.toBase58());
  const mint = programInstruction.accounts[2 + count];
  const record = programInstruction.accounts[3 + count];
  const systemProgram = programInstruction.accounts[4 + count];
  const tokenProgram = programInstruction.accounts[5 + count];
  const [derivedRecord] = findSettlementRecordPda(programId, decoded.eventSeed);
  if (
    !record.equals(derivedRecord) ||
    !systemProgram.equals(SystemProgram.programId) ||
    !tokenProgram.equals(TOKEN_PROGRAM_ID)
  ) {
    throw new LedgerError(
      "ACCOUNT_LAYOUT",
      "mint, settlement record, system program, or token program does not match SettleTokenN",
    );
  }
  const inner = transaction.meta.innerInstructions?.find(
    (group) => group.index === matches[0].index,
  );
  if (inner === undefined) {
    throw new LedgerError(
      "TRANSFER_MISMATCH",
      "token settlement instruction has no recorded inner instructions",
    );
  }
  const transfers = inner.instructions.flatMap((instruction) => {
    const transfer = parseTokenTransfer(instruction);
    return transfer === null ? [] : [transfer];
  });
  return {
    signature,
    slot: transaction.slot,
    blockTime: transaction.blockTime,
    programId: programId.toBase58(),
    payer,
    sourceTokenAccount,
    recipientTokenAccounts,
    mint: mint.toBase58(),
    record: record.toBase58(),
    eventSeedHex: toHex(decoded.eventSeed),
    amountOnChain: decoded.amount,
    decimals: decoded.decimals,
    bps: decoded.bps,
    transfers,
    memo: extractMemo(transaction),
  };
}

export function reconcileObservedTokenSettlementN(
  options: ReconcileObservedTokenSettlementNOptions,
): SettlementReconciliation {
  const {
    observation,
    request,
    tokenBaseUnitsPerAtomicUnit,
    mint,
    decimals,
    beneficiaryIds = {},
    pooledLabels = ["rewards_pool"],
  } = options;
  computeSettlementN(request);
  if (request.asset !== "SPL_STABLECOIN" && request.asset !== "USDC") {
    throw new LedgerError(
      "ASSET_MISMATCH",
      "token evidence requires an SPL_STABLECOIN or USDC request",
    );
  }
  if (tokenBaseUnitsPerAtomicUnit <= 0n) {
    throw new LedgerError(
      "SCALE_RANGE",
      "tokenBaseUnitsPerAtomicUnit must be positive",
    );
  }
  const expectedTotal = request.amountAtomic * tokenBaseUnitsPerAtomicUnit;
  if (observation.eventSeedHex !== toHex(eventIdSeed(request.eventId))) {
    throw new LedgerError("EVENT_MISMATCH", "event id does not match the on-chain seed");
  }
  if (observation.amountOnChain !== expectedTotal) {
    throw new LedgerError("AMOUNT_MISMATCH", "token amount does not match chain evidence");
  }
  if (observation.mint !== mint.toBase58() || observation.decimals !== decimals) {
    throw new LedgerError("ASSET_MISMATCH", "token mint or decimals do not match");
  }
  const expectedBps = request.shares.map((share) => share.bps);
  if (!sameNumbers(observation.bps, expectedBps)) {
    throw new LedgerError("SHARES_MISMATCH", "share bps do not match chain evidence");
  }
  let payer: PublicKey;
  let recipientWallets: PublicKey[];
  try {
    payer = new PublicKey(observation.payer);
    recipientWallets = request.shares.map((share) => new PublicKey(share.recipient));
  } catch {
    throw new LedgerError("RECIPIENT_MISMATCH", "payer or recipient wallet is invalid");
  }
  const expectedSource = getAssociatedTokenAddressSync(
    mint,
    payer,
    false,
    TOKEN_PROGRAM_ID,
  ).toBase58();
  if (observation.sourceTokenAccount !== expectedSource) {
    throw new LedgerError(
      "RECIPIENT_MISMATCH",
      "source token account is not the payer's associated token account",
    );
  }
  const expectedTokenAccounts = recipientWallets.map((owner) =>
    getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID).toBase58(),
  );
  if (!sameStrings(observation.recipientTokenAccounts, expectedTokenAccounts)) {
    throw new LedgerError(
      "RECIPIENT_MISMATCH",
      "recipient token accounts do not match the configured wallet ATAs",
    );
  }
  assertTokenMemo(observation.memo, request, expectedTotal, mint, decimals);
  const amounts = splitAmountAtomicShares(expectedTotal, expectedBps);
  const expectedTransfers = expectedTokenAccounts.flatMap((destination, index) => {
    const amount = amounts[index];
    return amount === 0n
      ? []
      : [
          tokenTransferKey(
            observation.sourceTokenAccount,
            destination,
            mint.toBase58(),
            amount,
            decimals,
          ),
        ];
  });
  const observedTransfers = observation.transfers.map((transfer) =>
    tokenTransferKey(
      transfer.source,
      transfer.destination,
      transfer.mint,
      transfer.amountOnChain,
      transfer.decimals,
    ),
  );
  if (!sameStrings(sorted(expectedTransfers), sorted(observedTransfers))) {
    throw new LedgerError(
      "TRANSFER_MISMATCH",
      "inner token transfers do not exactly match the configured payouts",
    );
  }
  for (const [label, beneficiaryId] of Object.entries(beneficiaryIds)) {
    if (beneficiaryId.trim() === "") {
      throw new LedgerError(
        "RECIPIENT_MISMATCH",
        `beneficiary id for "${label}" must not be empty`,
      );
    }
  }
  const pooled = new Set(pooledLabels);
  const payouts: PayoutLine[] = request.shares.map((share, index) => ({
    role: canonicalRole(share.label),
    recipient: share.recipient,
    destinationAccount: expectedTokenAccounts[index],
    bps: share.bps,
    amountOnChain: amounts[index].toString(),
    beneficiaryId: pooled.has(share.label)
      ? null
      : (beneficiaryIds[share.label] ?? `wallet:${share.recipient}`),
  }));
  const record: SettlementRecord = {
    schemaVersion: 1,
    eventId: request.eventId,
    signature: observation.signature,
    slot: observation.slot,
    cluster: options.cluster ?? "devnet",
    programId: observation.programId,
    payer: observation.payer,
    settlementRecord: observation.record,
    mode: "program-token",
    asset: request.asset,
    mint: mint.toBase58(),
    decimals,
    amountAtomic: request.amountAtomic.toString(),
    unitsPerAtomicUnit: tokenBaseUnitsPerAtomicUnit.toString(),
    payouts,
    occurredAt: request.occurredAt,
    settledAt: new Date(observation.blockTime * 1_000).toISOString(),
  };
  const directEntries = payouts.flatMap((payout) =>
    payout.beneficiaryId === null
      ? []
      : [
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
        ],
  );
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

function decodeSettleTokenNData(data: string): {
  eventSeed: Uint8Array;
  amount: bigint;
  decimals: number;
  bps: readonly number[];
} {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(data);
  } catch {
    throw new LedgerError(
      "INSTRUCTION_DATA",
      "SettleTokenN data is not valid base58",
    );
  }
  if (
    bytes.length < SETTLE_TOKEN_N_HEADER_LENGTH ||
    bytes[0] !== SETTLE_TOKEN_N_TAG
  ) {
    throw new LedgerError("INSTRUCTION_DATA", "instruction is not SettleTokenN");
  }
  const count = bytes[42];
  if (
    count === 0 ||
    count > MAX_SHARES ||
    bytes.length !== SETTLE_TOKEN_N_HEADER_LENGTH + 2 * count
  ) {
    throw new LedgerError(
      "INSTRUCTION_DATA",
      "SettleTokenN share count or length is invalid",
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    eventSeed: bytes.slice(1, 33),
    amount: view.getBigUint64(33, true),
    decimals: bytes[41],
    bps: Array.from({ length: count }, (_, index) =>
      view.getUint16(SETTLE_TOKEN_N_HEADER_LENGTH + 2 * index, true),
    ),
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

function parseTokenTransfer(
  instruction: ParsedInstruction | PartiallyDecodedInstruction,
): ObservedTokenTransfer | null {
  if (isPartiallyDecoded(instruction)) {
    if (instruction.programId.equals(TOKEN_PROGRAM_ID)) {
      throw new LedgerError(
        "TRANSFER_MISMATCH",
        "classic SPL Token inner instruction is not parsed",
      );
    }
    return null;
  }
  if (instruction.program !== "spl-token") return null;
  const parsed: unknown = instruction.parsed;
  if (!isRecord(parsed) || parsed["type"] !== "transferChecked") {
    throw new LedgerError(
      "TRANSFER_MISMATCH",
      "unexpected classic SPL Token inner instruction",
    );
  }
  const info = parsed["info"];
  if (!isRecord(info) || !isRecord(info["tokenAmount"])) {
    throw new LedgerError("TRANSFER_MISMATCH", "token transfer info is malformed");
  }
  const source = info["source"];
  const destination = info["destination"];
  const mint = info["mint"];
  const amount = info["tokenAmount"]["amount"];
  const decimals = info["tokenAmount"]["decimals"];
  if (
    typeof source !== "string" ||
    typeof destination !== "string" ||
    typeof mint !== "string" ||
    typeof amount !== "string" ||
    !/^\d+$/.test(amount) ||
    typeof decimals !== "number" ||
    !Number.isInteger(decimals)
  ) {
    throw new LedgerError("TRANSFER_MISMATCH", "token transfer fields are malformed");
  }
  return {
    source,
    destination,
    mint,
    amountOnChain: BigInt(amount),
    decimals,
  };
}

function assertTokenMemo(
  memo: Readonly<Record<string, unknown>>,
  request: SettlementRequestN,
  expectedTotal: bigint,
  mint: PublicKey,
  decimals: number,
): void {
  if (
    memo["protocol"] !== "synxed-settlement" ||
    memo["event"] !== request.eventId ||
    memo["occurredAt"] !== request.occurredAt ||
    memo["kind"] !== request.kind ||
    memo["asset"] !== request.asset ||
    memo["tokenAmount"] !== expectedTotal.toString() ||
    memo["mint"] !== mint.toBase58() ||
    memo["decimals"] !== decimals ||
    memo["memo"] !== request.memo
  ) {
    throw new LedgerError(
      "MEMO_MISMATCH",
      "token memo does not exactly match the settlement request",
    );
  }
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

function tokenTransferKey(
  source: string,
  destination: string,
  mint: string,
  amount: bigint,
  decimals: number,
): string {
  return `${source}\u0000${destination}\u0000${mint}\u0000${amount}\u0000${decimals}`;
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
