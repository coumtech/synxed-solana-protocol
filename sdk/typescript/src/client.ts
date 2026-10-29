// Devnet settlement client.
//
// Two submission modes:
//  - "program": one instruction to the deployed settlement program, which
//    validates the split and pays every recipient atomically. Requires a
//    program id and a settlement namespace whose authority signs (see
//    docs/integration.md).
//  - "system-transfer": up to N SystemProgram transfers (zero-lamport shares
//    are skipped) computed client-side with the same split math, plus a
//    memo. Works with no deployed program, so the demo runs end-to-end on a
//    fresh clone.
//
// Native and classic SPL Token paths are separate and reject requests for the
// wrong asset mode before signing.

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  buildCreateNamespaceInstruction,
  buildSettleNInstruction,
  buildSettleTokenNInstruction,
  decodeNamespaceAccount,
  eventIdSeed,
  findLegacySettlementRecordPda,
  findNamespacePda,
  findSettlementRecordPda,
  type NamespaceAccount,
  SETTLEMENT_RECORD_DISCRIMINATOR,
  SETTLEMENT_RECORD_SIZE,
  U64_MAX,
} from "./instruction.ts";
import {
  computeSettlementN,
  splitAmountAtomic,
  splitAmountAtomicShares,
} from "./split.ts";
import {
  ProtocolError,
  type SettlementRequest,
  type SettlementRequestN,
} from "./types.ts";

// Re-exported so the `./client` entry point alone can open and address a
// namespace and size its rent (the wallet demo loads only this module and
// `./ledger`).
export {
  NAMESPACE_ACCOUNT_SIZE,
  SETTLEMENT_RECORD_SIZE,
  findNamespacePda,
  namespaceIdFromLabel,
} from "./instruction.ts";

export const DEVNET_RPC_URL = "https://api.devnet.solana.com";

export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

/**
 * Approximate rent-exempt minimum for a 0-data system account. Transfers
 * that leave a fresh recipient below this fail on current clusters, so the
 * demo scales atomic units up into lamports (see `lamportsPerAtomicUnit`).
 */
export const APPROX_RENT_EXEMPT_MIN_LAMPORTS = 890_880n;

export type SettlementMode = "program" | "program-token" | "system-transfer";

/** System-transfer mode: no program, so no namespace and no authority. */
export interface TransferModeOptions {
  programId?: undefined;
  namespace?: undefined;
  authority?: undefined;
}

/** Program mode: settle through the deployed program, in `namespace`. */
export interface ProgramModeOptions<Authority> {
  /** The deployed settlement program. */
  programId: PublicKey;
  /** The settlement namespace to settle in (see `ensureNamespace`). */
  namespace: PublicKey;
  /** The namespace's authority, when it is not the payer. It signs too. */
  authority?: Authority;
}

interface SubmitSettlementBase {
  connection: Connection;
  payer: Keypair;
  request: SettlementRequest;
  /**
   * Lamports paid per atomic unit of `request.amountAtomic`. Defaults to 1.
   * The demo uses 1000 so each recipient stays above the rent-exempt
   * minimum for a fresh account.
   */
  lamportsPerAtomicUnit?: bigint;
}

/** Without `programId`, system transfers; with it, `SettleN` in `namespace`. */
export type SubmitSettlementOptions = SubmitSettlementBase &
  (TransferModeOptions | ProgramModeOptions<Keypair>);

export interface SettlementSubmission {
  signature: string;
  explorerUrl: string;
  mode: SettlementMode;
  lamportsTotal: bigint;
  /** Lamports per recipient in `[artist, studio, synxed]` order. */
  lamportsByRole: readonly [bigint, bigint, bigint];
}

interface SubmitSettlementNBase {
  connection: Connection;
  payer: Keypair;
  request: SettlementRequestN;
  lamportsPerAtomicUnit?: bigint;
}

/** Without `programId`, system transfers; with it, `SettleN` in `namespace`. */
export type SubmitSettlementNOptions = SubmitSettlementNBase &
  (TransferModeOptions | ProgramModeOptions<Keypair>);

interface BuildSettlementNBase {
  payer: PublicKey;
  request: SettlementRequestN;
  lamportsPerAtomicUnit?: bigint;
}

/**
 * Without `programId`, system transfers; with it, `SettleN` in `namespace`,
 * signed by the payer and the authority (the payer unless given).
 */
export type BuildSettlementNOptions = BuildSettlementNBase &
  (
    | (TransferModeOptions & { createNamespaceId?: undefined })
    | (ProgramModeOptions<PublicKey> & {
        /**
         * Open the namespace in the same transaction first: its namespace
         * id, with the payer as creator and `authority` (or the payer) as
         * authority. `namespace` must be the address it derives.
         */
        createNamespaceId?: Uint8Array;
      })
  );

export interface PreparedSettlementN {
  transaction: Transaction;
  mode: SettlementMode;
  lamportsTotal: bigint;
  lamportsByShare: readonly bigint[];
}

export interface SettlementSubmissionN {
  signature: string;
  explorerUrl: string;
  mode: SettlementMode;
  lamportsTotal: bigint;
  /** Lamports per share, in `request.shares` order. */
  lamportsByShare: readonly bigint[];
}

export interface BuildTokenSettlementNOptions {
  payer: PublicKey;
  request: SettlementRequestN;
  mint: PublicKey;
  decimals: number;
  programId: PublicKey;
  /** The settlement namespace. */
  namespace: PublicKey;
  /** The namespace's authority, which must also sign. Defaults to the payer. */
  authority?: PublicKey;
  tokenBaseUnitsPerAtomicUnit?: bigint;
  /** Include idempotent ATA creation for recipient wallets. Defaults true. */
  createRecipientAccounts?: boolean;
}

export interface SubmitTokenSettlementNOptions
  extends Omit<BuildTokenSettlementNOptions, "payer" | "authority"> {
  connection: Connection;
  payer: Keypair;
  /** The namespace's authority, if it is not the payer. */
  authority?: Keypair;
}

/** A namespace account read from the chain. */
export interface FetchedNamespace extends NamespaceAccount {
  address: PublicKey;
}

export interface EnsureNamespaceOptions {
  connection: Connection;
  /**
   * Pays the rent and, unless `creator` names another key, signs as the
   * creator, which is part of the address.
   */
  payer: Keypair;
  programId: PublicKey;
  /** Any 32 bytes; `namespaceIdFromLabel` derives them from a label. */
  namespaceId: Uint8Array;
  /**
   * The key allowed to settle in the namespace. Defaults to the payer, so
   * after a payer change pass the authority the namespace still has.
   */
  authority?: PublicKey;
  /**
   * Open the namespace when it does not exist (the default). Pass false once
   * the namespace's address is pinned in your configuration: settling in a
   * fresh namespace starts idempotency afresh, so a missing namespace is then
   * an error, never something to open silently.
   */
  create?: boolean;
  /**
   * The namespace's creator, when it is not this payer (for example after
   * the payer key was replaced). Only the creator can open a namespace, so a
   * missing namespace with another creator is an error.
   */
  creator?: PublicKey;
  /** The pinned namespace address; a different derived address is an error. */
  expectedAddress?: PublicKey;
}

export interface EnsuredNamespace {
  address: PublicKey;
  authority: PublicKey;
  /**
   * True when this call's transaction opened the namespace. False when it
   * already existed or another run opened it first, and also when this
   * call's own transaction landed but confirming it failed.
   */
  created: boolean;
  signature: string | null;
}

/** A settlement record read from the chain. */
export interface SettlementRecordAccount {
  address: PublicKey;
  /** The gross amount the record stores, in on-chain units. */
  amount: bigint;
}

/** A settlement record that a retired instruction (tags 0 to 2) created. */
export type LegacySettlementRecord = SettlementRecordAccount;

export interface PreparedTokenSettlementN {
  transaction: Transaction;
  mode: "program-token";
  tokenAmountTotal: bigint;
  tokenAmountsByShare: readonly bigint[];
  sourceTokenAccount: PublicKey;
  recipientTokenAccounts: readonly PublicKey[];
}

export interface TokenSettlementSubmissionN
  extends Omit<PreparedTokenSettlementN, "transaction"> {
  signature: string;
  explorerUrl: string;
}

export function explorerTxUrl(signature: string, cluster = "devnet"): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}

export function explorerAddressUrl(
  address: string,
  cluster = "devnet",
): string {
  return `https://explorer.solana.com/address/${address}?cluster=${cluster}`;
}

/**
 * Read a namespace account. Returns null when the namespace does not exist:
 * no account at the address, or only lamports someone sent to it (the program
 * opens a namespace at a pre-funded address all the same). Throws when the
 * address holds anything else that is not a namespace of `programId`.
 */
export async function fetchNamespace(
  connection: Connection,
  programId: PublicKey,
  address: PublicKey,
): Promise<FetchedNamespace | null> {
  const account = await connection.getAccountInfo(address, "confirmed");
  if (account === null || isPlainSystemAccount(account)) {
    return null;
  }
  if (!account.owner.equals(programId)) {
    throw new ProtocolError(
      "NAMESPACE_ACCOUNT",
      `${address.toBase58()} is not owned by the settlement program`,
    );
  }
  return { address, ...decodeNamespaceAccount(account.data) };
}

/**
 * Find the namespace that `creator` (the payer unless given) opened under
 * `namespaceId`, check it is at `expectedAddress` when one is pinned, and
 * check that its current authority is the expected one. When it does not
 * exist, open it if `create` allows and the payer is its creator; otherwise
 * throw `NAMESPACE_MISSING`.
 */
export async function ensureNamespace(
  options: EnsureNamespaceOptions,
): Promise<EnsuredNamespace> {
  const authority = options.authority ?? options.payer.publicKey;
  const creator = options.creator ?? options.payer.publicKey;
  const [address] = findNamespacePda(options.programId, creator, options.namespaceId);
  if (options.expectedAddress !== undefined && !options.expectedAddress.equals(address)) {
    throw new ProtocolError(
      "NAMESPACE_ADDRESS",
      `the namespace derives to ${address.toBase58()}, not the pinned ${options.expectedAddress.toBase58()}`,
    );
  }
  const expectAuthority = (found: FetchedNamespace): PublicKey => {
    if (!found.authority.equals(authority)) {
      throw new ProtocolError(
        "NAMESPACE_AUTHORITY",
        `namespace ${address.toBase58()} has authority ${found.authority.toBase58()}, not ${authority.toBase58()}`,
      );
    }
    return found.authority;
  };
  const existing = await fetchNamespace(options.connection, options.programId, address);
  if (existing !== null) {
    return { address, authority: expectAuthority(existing), created: false, signature: null };
  }
  if (options.create === false) {
    throw new ProtocolError(
      "NAMESPACE_MISSING",
      `namespace ${address.toBase58()} does not exist, and create is false`,
    );
  }
  if (!creator.equals(options.payer.publicKey)) {
    throw new ProtocolError(
      "NAMESPACE_MISSING",
      `namespace ${address.toBase58()} does not exist, and only its creator can open it`,
    );
  }
  const transaction = new Transaction().add(
    buildCreateNamespaceInstruction(
      {
        programId: options.programId,
        payer: options.payer.publicKey,
        creator: options.payer.publicKey,
      },
      { namespaceId: options.namespaceId, authority },
    ),
  );
  try {
    const signature = await send(options.connection, options.payer, transaction);
    return { address, authority, created: true, signature };
  } catch (error) {
    // Another run may have opened it first; that is fine if it matches.
    // Otherwise the send error is the one worth reporting.
    let raced: FetchedNamespace | null;
    try {
      raced = await fetchNamespace(options.connection, options.programId, address);
    } catch {
      throw error;
    }
    if (raced === null) {
      throw error;
    }
    return { address, authority: expectAuthority(raced), created: false, signature: null };
  }
}

/**
 * The record that marks `eventSeed` as settled in `namespace`, or null when
 * the event is not settled there. Only an account this program owns that
 * holds this event's record counts: anyone can send lamports to the address,
 * so an account merely existing there proves nothing. A record means the
 * namespace's authority settled the event; reconcile its creating transaction
 * (`findSettlementTransaction`) before treating the event as paid.
 */
export async function fetchSettlementRecord(
  connection: Connection,
  programId: PublicKey,
  namespace: PublicKey,
  eventSeed: Uint8Array,
): Promise<SettlementRecordAccount | null> {
  const [address] = findSettlementRecordPda(programId, namespace, eventSeed);
  return readSettlementRecord(connection, programId, address, eventSeed, "SETTLEMENT_RECORD");
}

/**
 * The record a retired instruction (tags 0 to 2) created for `eventSeed`, or
 * null when there is none. Only an account this program owns that holds this
 * event's record counts: anyone can send lamports to the address, so an
 * account merely existing there proves nothing. Confirm a null with a second
 * RPC provider before settling an event first attempted before namespaces.
 * A record means the event was settled before namespaces, possibly by
 * someone else to wallets of their choosing (the old program let anyone
 * settle any event id); docs/integration.md, "Upgrading from the retired
 * instructions", gives the decision for each case.
 */
export async function fetchLegacySettlementRecord(
  connection: Connection,
  programId: PublicKey,
  eventSeed: Uint8Array,
): Promise<LegacySettlementRecord | null> {
  const [address] = findLegacySettlementRecordPda(programId, eventSeed);
  return readSettlementRecord(connection, programId, address, eventSeed, "LEGACY_RECORD");
}

async function readSettlementRecord(
  connection: Connection,
  programId: PublicKey,
  address: PublicKey,
  eventSeed: Uint8Array,
  code: "SETTLEMENT_RECORD" | "LEGACY_RECORD",
): Promise<SettlementRecordAccount | null> {
  const account = await connection.getAccountInfo(address, "confirmed");
  if (account === null || isPlainSystemAccount(account)) {
    return null;
  }
  const data = Uint8Array.from(account.data);
  const sameEvent = account.owner.equals(programId) &&
    data.length === SETTLEMENT_RECORD_SIZE &&
    data[0] === SETTLEMENT_RECORD_DISCRIMINATOR &&
    data.slice(1, 33).every((byte, index) => byte === eventSeed[index]);
  if (!sameEvent) {
    throw new ProtocolError(
      code,
      `${address.toBase58()} holds something other than this event's settlement record`,
    );
  }
  return {
    address,
    amount: new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(33, true),
  };
}

// Lamports sent to an address leave a system-owned account with no data.
function isPlainSystemAccount(account: { owner: PublicKey; data: Uint8Array }): boolean {
  return account.owner.equals(SystemProgram.programId) && account.data.length === 0;
}

/** Settle a three-way request through `SettleN` (or system transfers). */
export async function submitSettlement(
  options: SubmitSettlementOptions,
): Promise<SettlementSubmission> {
  const { request } = options;
  assertNativeAsset(request.asset);
  const lamportsTotal = scaledTotal(
    request.amountAtomic,
    options.lamportsPerAtomicUnit,
  );
  // Mirrors the on-chain math: floor the first shares, remainder to the
  // last, so lamports out always equal lamports in.
  const lamportsByRole = splitAmountAtomic(lamportsTotal, request.splits);
  const [artist, studio, synxed] = request.splits.map((share) =>
    parseRecipient(share.role, share.recipient),
  ) as [PublicKey, PublicKey, PublicKey];

  const transaction = new Transaction().add(
    memoInstruction(request, lamportsTotal),
  );
  let mode: SettlementMode;
  refuseProgramOptionsWithoutProgram(options);
  if (options.programId === undefined) {
    mode = "system-transfer";
    addTransfers(
      transaction,
      options.payer.publicKey,
      [artist, studio, synxed],
      lamportsByRole,
    );
  } else {
    mode = "program";
    transaction.add(
      buildSettleNInstruction(
        {
          programId: options.programId,
          payer: options.payer.publicKey,
          authority: (options.authority ?? options.payer).publicKey,
          namespace: requireNamespace(options.namespace),
          recipients: [artist, studio, synxed],
        },
        {
          eventSeed: eventIdSeed(request.eventId),
          amount: lamportsTotal,
          bps: request.splits.map((share) => share.bps),
        },
      ),
    );
  }

  const signature = await send(
    options.connection,
    options.payer,
    transaction,
    mode === "program" ? options.authority : undefined,
  );
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    mode,
    lamportsTotal,
    lamportsByRole,
  };
}

/** Settle an N-way request through `SettleN` (or system transfers). */
export async function submitSettlementN(
  options: SubmitSettlementNOptions,
): Promise<SettlementSubmissionN> {
  const base = {
    payer: options.payer.publicKey,
    request: options.request,
    ...(options.lamportsPerAtomicUnit !== undefined
      ? { lamportsPerAtomicUnit: options.lamportsPerAtomicUnit }
      : {}),
  };
  refuseProgramOptionsWithoutProgram(options);
  const prepared = buildSettlementNTransaction(
    options.programId === undefined
      ? base
      : {
          ...base,
          programId: options.programId,
          namespace: requireNamespace(options.namespace),
          ...(options.authority !== undefined
            ? { authority: options.authority.publicKey }
            : {}),
        },
  );
  const signature = await send(
    options.connection,
    options.payer,
    prepared.transaction,
    prepared.mode === "program" ? options.authority : undefined,
  );
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    mode: prepared.mode,
    lamportsTotal: prepared.lamportsTotal,
    lamportsByShare: prepared.lamportsByShare,
  };
}

/** Build an unsigned N-way transaction for a browser or hardware wallet. */
export function buildSettlementNTransaction(
  options: BuildSettlementNOptions,
): PreparedSettlementN {
  const { request } = options;
  assertNativeAsset(request.asset);
  const lamportsTotal = scaledTotal(
    request.amountAtomic,
    options.lamportsPerAtomicUnit,
  );
  // Validates share count, labels, and bps (same order as the 3-way path:
  // scale first, then the request).
  computeSettlementN(request);
  const bps = request.shares.map((share) => share.bps);
  const lamportsByShare = splitAmountAtomicShares(lamportsTotal, bps);
  const recipients = request.shares.map((share) =>
    parseRecipient(share.label, share.recipient),
  );

  const transaction = new Transaction();
  refuseProgramOptionsWithoutProgram(options);
  if (options.createNamespaceId !== undefined && options.programId !== undefined) {
    const authority = options.authority ?? options.payer;
    const [derived] = findNamespacePda(
      options.programId,
      options.payer,
      options.createNamespaceId,
    );
    if (options.namespace === undefined || !derived.equals(options.namespace)) {
      throw new ProtocolError(
        "NAMESPACE_ADDRESS",
        "namespace must be the address createNamespaceId derives for the payer",
      );
    }
    transaction.add(
      buildCreateNamespaceInstruction(
        { programId: options.programId, payer: options.payer, creator: options.payer },
        { namespaceId: options.createNamespaceId, authority },
      ),
    );
  }
  transaction.add(memoInstruction(request, lamportsTotal));
  let mode: SettlementMode;
  if (options.programId === undefined) {
    mode = "system-transfer";
    addTransfers(
      transaction,
      options.payer,
      recipients,
      lamportsByShare,
    );
  } else {
    mode = "program";
    transaction.add(
      buildSettleNInstruction(
        {
          programId: options.programId,
          payer: options.payer,
          authority: options.authority ?? options.payer,
          namespace: requireNamespace(options.namespace),
          recipients,
        },
        {
          eventSeed: eventIdSeed(request.eventId),
          amount: lamportsTotal,
          bps,
        },
      ),
    );
  }

  return {
    transaction,
    mode,
    lamportsTotal,
    lamportsByShare,
  };
}

/** Build an unsigned classic SPL Token settlement for wallet or CLI signing. */
export function buildTokenSettlementNTransaction(
  options: BuildTokenSettlementNOptions,
): PreparedTokenSettlementN {
  if (!isTokenAsset(options.request.asset)) {
    throw new ProtocolError(
      "TOKEN_ASSET",
      "SettleTokenN requires SPL_STABLECOIN or USDC; mint identity is verified separately",
    );
  }
  computeSettlementN(options.request);
  const tokenAmountTotal = scaledTokenTotal(
    options.request.amountAtomic,
    options.tokenBaseUnitsPerAtomicUnit,
  );
  const bps = options.request.shares.map((share) => share.bps);
  const tokenAmountsByShare = splitAmountAtomicShares(tokenAmountTotal, bps);
  const recipientWallets = options.request.shares.map((share) =>
    parseRecipient(share.label, share.recipient),
  );
  const sourceTokenAccount = getAssociatedTokenAddressSync(
    options.mint,
    options.payer,
    false,
    TOKEN_PROGRAM_ID,
  );
  const recipientTokenAccounts = recipientWallets.map((owner) =>
    getAssociatedTokenAddressSync(options.mint, owner, true, TOKEN_PROGRAM_ID),
  );
  const transaction = new Transaction().add(
    tokenMemoInstruction(
      options.request,
      tokenAmountTotal,
      options.mint,
      options.decimals,
    ),
  );
  if (options.createRecipientAccounts ?? true) {
    const seen = new Set<string>();
    recipientTokenAccounts.forEach((tokenAccount, index) => {
      const address = tokenAccount.toBase58();
      if (seen.has(address)) return;
      seen.add(address);
      transaction.add(
        createAssociatedTokenAccountIdempotentInstruction(
          options.payer,
          tokenAccount,
          recipientWallets[index],
          options.mint,
          TOKEN_PROGRAM_ID,
        ),
      );
    });
  }
  transaction.add(
    buildSettleTokenNInstruction(
      {
        programId: options.programId,
        payer: options.payer,
        authority: options.authority ?? options.payer,
        namespace: options.namespace,
        sourceTokenAccount,
        recipientTokenAccounts,
        mint: options.mint,
      },
      {
        eventSeed: eventIdSeed(options.request.eventId),
        amount: tokenAmountTotal,
        decimals: options.decimals,
        bps,
      },
    ),
  );
  return {
    transaction,
    mode: "program-token",
    tokenAmountTotal,
    tokenAmountsByShare,
    sourceTokenAccount,
    recipientTokenAccounts,
  };
}

export async function submitTokenSettlementN(
  options: SubmitTokenSettlementNOptions,
): Promise<TokenSettlementSubmissionN> {
  const prepared = buildTokenSettlementNTransaction({
    payer: options.payer.publicKey,
    request: options.request,
    mint: options.mint,
    decimals: options.decimals,
    programId: options.programId,
    namespace: options.namespace,
    ...(options.authority !== undefined
      ? { authority: options.authority.publicKey }
      : {}),
    ...(options.tokenBaseUnitsPerAtomicUnit !== undefined
      ? { tokenBaseUnitsPerAtomicUnit: options.tokenBaseUnitsPerAtomicUnit }
      : {}),
    ...(options.createRecipientAccounts !== undefined
      ? { createRecipientAccounts: options.createRecipientAccounts }
      : {}),
  });
  const signature = await send(
    options.connection,
    options.payer,
    prepared.transaction,
    options.authority,
  );
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    mode: prepared.mode,
    tokenAmountTotal: prepared.tokenAmountTotal,
    tokenAmountsByShare: prepared.tokenAmountsByShare,
    sourceTokenAccount: prepared.sourceTokenAccount,
    recipientTokenAccounts: prepared.recipientTokenAccounts,
  };
}

function scaledTotal(amountAtomic: bigint, scale: bigint | undefined): bigint {
  const factor = scale ?? 1n;
  if (factor <= 0n) {
    throw new ProtocolError(
      "SCALE_RANGE",
      "lamportsPerAtomicUnit must be a positive bigint",
    );
  }
  const total = amountAtomic * factor;
  // Enforced here so both modes reject oversized totals identically;
  // program mode would also catch this when encoding the instruction.
  if (total > U64_MAX) {
    throw new ProtocolError(
      "AMOUNT_U64",
      `scaled total ${total} lamports exceeds u64`,
    );
  }
  return total;
}

function assertNativeAsset(asset: SettlementRequestN["asset"]): void {
  if (asset !== "SOL_LAMPORTS_STANDIN") {
    throw new ProtocolError(
      "ASSET_MODE",
      "native settlement requires SOL_LAMPORTS_STANDIN",
    );
  }
}

function isTokenAsset(asset: SettlementRequestN["asset"]): boolean {
  return asset === "SPL_STABLECOIN" || asset === "USDC";
}

function scaledTokenTotal(amountAtomic: bigint, scale: bigint | undefined): bigint {
  const factor = scale ?? 1n;
  if (factor <= 0n) {
    throw new ProtocolError(
      "SCALE_RANGE",
      "tokenBaseUnitsPerAtomicUnit must be a positive bigint",
    );
  }
  const total = amountAtomic * factor;
  if (total > U64_MAX) {
    throw new ProtocolError(
      "AMOUNT_U64",
      `scaled total ${total} token base units exceeds u64`,
    );
  }
  return total;
}

function parseRecipient(label: string, recipient: string): PublicKey {
  try {
    return new PublicKey(recipient);
  } catch {
    throw new ProtocolError(
      "RECIPIENT_PUBKEY",
      `recipient for "${label}" is not a valid base58 pubkey`,
    );
  }
}

function addTransfers(
  transaction: Transaction,
  from: PublicKey,
  recipients: readonly PublicKey[],
  lamports: readonly bigint[],
): void {
  recipients.forEach((toPubkey, i) => {
    const amount = lamports[i];
    if (amount > 0n) {
      transaction.add(
        SystemProgram.transfer({ fromPubkey: from, toPubkey, lamports: amount }),
      );
    }
  });
}

/**
 * The types tie these options to a programId, but a spread or plain
 * JavaScript can pass them without one. Refuse that instead of settling by
 * plain transfers, which no on-chain record guards against repeating.
 */
function refuseProgramOptionsWithoutProgram(options: {
  programId?: PublicKey | undefined;
  namespace?: PublicKey | undefined;
  authority?: unknown;
  createNamespaceId?: Uint8Array | undefined;
}): void {
  if (
    options.programId === undefined &&
    (options.namespace !== undefined ||
      options.authority !== undefined ||
      options.createNamespaceId !== undefined)
  ) {
    throw new ProtocolError(
      "PROGRAM_ID_REQUIRED",
      "namespace, authority and createNamespaceId apply only with a programId",
    );
  }
}

function requireNamespace(namespace: PublicKey | undefined): PublicKey {
  if (namespace === undefined) {
    throw new ProtocolError(
      "NAMESPACE_REQUIRED",
      "program mode settles in a namespace: pass its address as namespace",
    );
  }
  return namespace;
}

/** Sign with the payer, and with the namespace authority when it differs. */
async function send(
  connection: Connection,
  payer: Keypair,
  transaction: Transaction,
  authority?: Keypair,
): Promise<string> {
  const signers =
    authority === undefined || authority.publicKey.equals(payer.publicKey)
      ? [payer]
      : [payer, authority];
  return sendAndConfirmTransaction(connection, transaction, signers, {
    commitment: "confirmed",
  });
}

function memoInstruction(
  request: Pick<
    SettlementRequestN,
    "eventId" | "kind" | "memo" | "occurredAt" | "asset"
  >,
  lamportsTotal: bigint,
): TransactionInstruction {
  const text = JSON.stringify({
    protocol: "synxed-settlement",
    event: request.eventId,
    occurredAt: request.occurredAt,
    kind: request.kind,
    asset: request.asset,
    lamports: lamportsTotal.toString(),
    memo: request.memo,
  });
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(text, "utf8"),
  });
}

function tokenMemoInstruction(
  request: Pick<
    SettlementRequestN,
    "eventId" | "kind" | "memo" | "occurredAt" | "asset"
  >,
  tokenAmount: bigint,
  mint: PublicKey,
  decimals: number,
): TransactionInstruction {
  const text = JSON.stringify({
    protocol: "synxed-settlement",
    event: request.eventId,
    occurredAt: request.occurredAt,
    kind: request.kind,
    asset: request.asset,
    tokenAmount: tokenAmount.toString(),
    mint: mint.toBase58(),
    decimals,
    memo: request.memo,
  });
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(text, "utf8"),
  });
}
