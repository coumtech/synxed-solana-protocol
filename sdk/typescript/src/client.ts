// Devnet settlement client.
//
// Two submission modes:
//  - "program": one instruction to the deployed settlement program, which
//    validates the split and pays all three recipients atomically. Requires
//    a program id (see docs/integration.md for deployment).
//  - "system-transfer": three SystemProgram transfers computed client-side
//    with the same split math, plus a memo. Works with no deployed program,
//    so the demo runs end-to-end on a fresh clone.
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
import { buildSettleInstruction, eventIdSeed } from "./instruction.ts";
import { splitAmountAtomic } from "./split.ts";
import { ProtocolError, type SettlementRequest } from "./types.ts";

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

export function explorerTxUrl(signature: string, cluster = "devnet"): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}

export function explorerAddressUrl(
  address: string,
  cluster = "devnet",
): string {
  return `https://explorer.solana.com/address/${address}?cluster=${cluster}`;
}

export async function submitSettlement(
  options: SubmitSettlementOptions,
): Promise<SettlementSubmission> {
  const scale = options.lamportsPerAtomicUnit ?? 1n;
  if (scale <= 0n) {
    throw new ProtocolError(
      "SCALE_RANGE",
      "lamportsPerAtomicUnit must be a positive bigint",
    );
  }
  const { request } = options;
  const lamportsTotal = request.amountAtomic * scale;
  // Mirrors the on-chain math: floor the first two shares, remainder to the
  // last, so lamports out always equal lamports in.
  const lamportsByRole = splitAmountAtomic(lamportsTotal, request.splits);
  const recipients = request.splits.map((share) => {
    try {
      return new PublicKey(share.recipient);
    } catch {
      throw new ProtocolError(
        "RECIPIENT_PUBKEY",
        `recipient for role "${share.role}" is not a valid base58 pubkey`,
      );
    }
  });
  const [artist, studio, synxed] = recipients as [
    PublicKey,
    PublicKey,
    PublicKey,
  ];

  const transaction = new Transaction();
  transaction.add(memoInstruction(request, lamportsTotal));

  let mode: SettlementMode;
  if (options.programId === undefined) {
    mode = "system-transfer";
    const targets: readonly [PublicKey, PublicKey, PublicKey] = [
      artist,
      studio,
      synxed,
    ];
    for (let i = 0; i < targets.length; i += 1) {
      const lamports = lamportsByRole[i] ?? 0n;
      if (lamports > 0n) {
        transaction.add(
          SystemProgram.transfer({
            fromPubkey: options.payer.publicKey,
            toPubkey: targets[i] as PublicKey,
            lamports,
          }),
        );
      }
    }
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

  const signature = await sendAndConfirmTransaction(
    options.connection,
    transaction,
    [options.payer],
    { commitment: "confirmed" },
  );
  return {
    signature,
    explorerUrl: explorerTxUrl(signature),
    mode,
    lamportsTotal,
    lamportsByRole,
  };
}

function memoInstruction(
  request: SettlementRequest,
  lamportsTotal: bigint,
): TransactionInstruction {
  const memo = JSON.stringify({
    protocol: "synxed-settlement",
    event: request.eventId,
    kind: request.kind,
    lamports: lamportsTotal.toString(),
  });
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(memo, "utf8"),
  });
}
