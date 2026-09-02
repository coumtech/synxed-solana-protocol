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
// Both modes settle native SOL on devnet as a stand-in asset.

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  buildSettleInstruction,
  buildSettleNInstruction,
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

export type SettlementMode = "program" | "system-transfer";

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

export interface SettlementSubmissionN {
  signature: string;
  explorerUrl: string;
  mode: SettlementMode;
  lamportsTotal: bigint;
  /** Lamports per share, in `request.shares` order. */
  lamportsByShare: readonly bigint[];
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
    memoInstruction(request.eventId, request.kind, request.memo, lamportsTotal),
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
  const { request } = options;
  // Validates share count, labels, and bps before anything else.
  computeSettlementN(request);
  const lamportsTotal = scaledTotal(
    request.amountAtomic,
    options.lamportsPerAtomicUnit,
  );
  const bps = request.shares.map((share) => share.bps);
  const lamportsByShare = splitAmountAtomicShares(lamportsTotal, bps);
  const recipients = request.shares.map((share) =>
    parseRecipient(share.label, share.recipient),
  );

  const transaction = new Transaction().add(
    memoInstruction(request.eventId, request.kind, request.memo, lamportsTotal),
  );
  let mode: SettlementMode;
  if (options.programId === undefined) {
    mode = "system-transfer";
    addTransfers(
      transaction,
      options.payer.publicKey,
      recipients,
      lamportsByShare,
    );
  } else {
    mode = "program";
    transaction.add(
      buildSettleNInstruction(
        {
          programId: options.programId,
          payer: options.payer.publicKey,
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

  const signature = await send(options.connection, options.payer, transaction);
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    mode,
    lamportsTotal,
    lamportsByShare,
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
  eventId: string,
  kind: string,
  memo: string,
  lamportsTotal: bigint,
): TransactionInstruction {
  const text = JSON.stringify({
    protocol: "synxed-settlement",
    event: eventId,
    kind,
    lamports: lamportsTotal.toString(),
    memo,
  });
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(text, "utf8"),
  });
}
