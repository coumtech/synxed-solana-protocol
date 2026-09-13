// Devnet settlement client.
//
// Two submission modes:
//  - "program": one instruction to the deployed settlement program, which
//    validates the split and pays every recipient atomically. Requires a
//    program id (see docs/integration.md for deployment).
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
  buildSettleInstruction,
  buildSettleNInstruction,
  buildSettleTokenNInstruction,
  eventIdSeed,
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

export interface SubmitSettlementOptions {
  connection: Connection;
  payer: Keypair;
  request: SettlementRequest;
  /**
   * Lamports paid per atomic unit of `request.amountAtomic`. Defaults to 1.
   * The demo uses 1000 so each recipient stays above the rent-exempt
   * minimum for a fresh account.
   */
  lamportsPerAtomicUnit?: bigint;
  /** If set, settle through the deployed program instead of raw transfers. */
  programId?: PublicKey;
}

export interface SettlementSubmission {
  signature: string;
  explorerUrl: string;
  mode: SettlementMode;
  lamportsTotal: bigint;
  /** Lamports per recipient in `[artist, studio, synxed]` order. */
  lamportsByRole: readonly [bigint, bigint, bigint];
}

export interface SubmitSettlementNOptions {
  connection: Connection;
  payer: Keypair;
  request: SettlementRequestN;
  lamportsPerAtomicUnit?: bigint;
  programId?: PublicKey;
}

export interface BuildSettlementNOptions {
  payer: PublicKey;
  request: SettlementRequestN;
  lamportsPerAtomicUnit?: bigint;
  programId?: PublicKey;
}

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
  tokenBaseUnitsPerAtomicUnit?: bigint;
  /** Include idempotent ATA creation for recipient wallets. Defaults true. */
  createRecipientAccounts?: boolean;
}

export interface SubmitTokenSettlementNOptions
  extends Omit<BuildTokenSettlementNOptions, "payer"> {
  connection: Connection;
  payer: Keypair;
}

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

/** Settle a three-way request through `Settle` (or system transfers). */
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
      buildSettleInstruction(
        {
          programId: options.programId,
          payer: options.payer.publicKey,
          artist,
          studio,
          synxed,
        },
        {
          eventSeed: eventIdSeed(request.eventId),
          amount: lamportsTotal,
          artistBps: request.splits[0].bps,
          studioBps: request.splits[1].bps,
          synxedBps: request.splits[2].bps,
        },
      ),
    );
  }

  const signature = await send(options.connection, options.payer, transaction);
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
  const prepared = buildSettlementNTransaction({
    payer: options.payer.publicKey,
    request: options.request,
    ...(options.lamportsPerAtomicUnit !== undefined
      ? { lamportsPerAtomicUnit: options.lamportsPerAtomicUnit }
      : {}),
    ...(options.programId !== undefined ? { programId: options.programId } : {}),
  });
  const signature = await send(
    options.connection,
    options.payer,
    prepared.transaction,
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

  const transaction = new Transaction().add(
    memoInstruction(request, lamportsTotal),
  );
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
    ...(options.tokenBaseUnitsPerAtomicUnit !== undefined
      ? { tokenBaseUnitsPerAtomicUnit: options.tokenBaseUnitsPerAtomicUnit }
      : {}),
    ...(options.createRecipientAccounts !== undefined
      ? { createRecipientAccounts: options.createRecipientAccounts }
      : {}),
  });
  const signature = await send(options.connection, options.payer, prepared.transaction);
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

async function send(
  connection: Connection,
  payer: Keypair,
  transaction: Transaction,
): Promise<string> {
  return sendAndConfirmTransaction(connection, transaction, [payer], {
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
