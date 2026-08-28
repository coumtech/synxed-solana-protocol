// Client-side codec for the on-chain settlement program.
//
// The byte layout must stay in lockstep with
// `programs/synxed-settlement/src/instruction.rs`:
//   tag(u8=0) | event_id([u8;32]) | amount(u64 LE) |
//   artist_bps(u16 LE) | studio_bps(u16 LE) | synxed_bps(u16 LE)

import { createHash } from "node:crypto";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { assertBpsTriple } from "./split.ts";
import { ProtocolError } from "./types.ts";

export const SETTLE_TAG = 0;
export const SETTLEMENT_SEED = "settlement";
export const EVENT_SEED_LENGTH = 32;
export const SETTLE_DATA_LENGTH = 1 + 32 + 8 + 2 + 2 + 2;

const U64_MAX = 0xffff_ffff_ffff_ffffn;

/**
 * Derive the fixed-size on-chain event id from an application event id.
 * The program keys its idempotency record on these 32 bytes.
 */
export function eventIdSeed(eventId: string): Uint8Array {
  if (eventId.length === 0) {
    throw new ProtocolError("EVENT_ID_EMPTY", "eventId must not be empty");
  }
  return new Uint8Array(createHash("sha256").update(eventId, "utf8").digest());
}

/** PDA of the settlement record that marks an event id as settled. */
export function findSettlementRecordPda(
  programId: PublicKey,
  seed: Uint8Array,
): readonly [PublicKey, number] {
  assertSeed(seed);
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(SETTLEMENT_SEED), seed],
    programId,
  );
  return [pda, bump];
}

export interface SettleParams {
  eventSeed: Uint8Array;
  amount: bigint;
  artistBps: number;
  studioBps: number;
  synxedBps: number;
}

export function encodeSettleData(params: SettleParams): Uint8Array {
  assertSeed(params.eventSeed);
  if (params.amount <= 0n || params.amount > U64_MAX) {
    throw new ProtocolError(
      "AMOUNT_U64",
      "amount must be a positive u64 (1..=2^64-1)",
    );
  }
  assertBpsTriple([params.artistBps, params.studioBps, params.synxedBps]);

  const data = new Uint8Array(SETTLE_DATA_LENGTH);
  const view = new DataView(data.buffer);
  data[0] = SETTLE_TAG;
  data.set(params.eventSeed, 1);
  view.setBigUint64(33, params.amount, true);
  view.setUint16(41, params.artistBps, true);
  view.setUint16(43, params.studioBps, true);
  view.setUint16(45, params.synxedBps, true);
  return data;
}

export interface SettleAccounts {
  programId: PublicKey;
  payer: PublicKey;
  artist: PublicKey;
  studio: PublicKey;
  synxed: PublicKey;
}

/**
 * Build the `Settle` instruction. Account order must match
 * `process_settle` in the program: payer, artist, studio, synxed,
 * settlement record PDA, system program.
 */
export function buildSettleInstruction(
  accounts: SettleAccounts,
  params: SettleParams,
): TransactionInstruction {
  const data = encodeSettleData(params);
  const [record] = findSettlementRecordPda(
    accounts.programId,
    params.eventSeed,
  );
  return new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: accounts.payer, isSigner: true, isWritable: true },
      { pubkey: accounts.artist, isSigner: false, isWritable: true },
      { pubkey: accounts.studio, isSigner: false, isWritable: true },
      { pubkey: accounts.synxed, isSigner: false, isWritable: true },
      { pubkey: record, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

function assertSeed(seed: Uint8Array): void {
  if (seed.length !== EVENT_SEED_LENGTH) {
    throw new ProtocolError(
      "SEED_LENGTH",
      `event seed must be exactly ${EVENT_SEED_LENGTH} bytes`,
    );
  }
}
