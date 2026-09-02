// Client-side codec for the on-chain settlement program.
//
// Byte layouts must stay in lockstep with
// `programs/synxed-settlement/src/instruction.rs`:
//   Settle:  tag(u8=0) | event_id([u8;32]) | amount(u64 LE) |
//            artist_bps(u16 LE) | studio_bps(u16 LE) | synxed_bps(u16 LE)
//   SettleN: tag(u8=1) | event_id([u8;32]) | amount(u64 LE) |
//            count(u8) | bps[count](u16 LE)

import { createHash } from "node:crypto";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { assertBpsShares, assertBpsTriple } from "./split.ts";
import { ProtocolError } from "./types.ts";

export const SETTLE_TAG = 0;
export const SETTLE_N_TAG = 1;
export const SETTLEMENT_SEED = "settlement";
export const EVENT_SEED_LENGTH = 32;
export const SETTLE_DATA_LENGTH = 1 + 32 + 8 + 2 + 2 + 2;
/** `SettleN` bytes before the bps list: tag + event id + amount + count. */
export const SETTLE_N_HEADER_LENGTH = 1 + 32 + 8 + 1;

export const U64_MAX = 0xffff_ffff_ffff_ffffn;

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
  assertAmountU64(params.amount);
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

export interface SettleNParams {
  eventSeed: Uint8Array;
  amount: bigint;
  /** One entry per share, in recipient order. */
  bps: readonly number[];
}

export function encodeSettleNData(params: SettleNParams): Uint8Array {
  assertSeed(params.eventSeed);
  assertAmountU64(params.amount);
  assertBpsShares(params.bps);

  const data = new Uint8Array(SETTLE_N_HEADER_LENGTH + 2 * params.bps.length);
  const view = new DataView(data.buffer);
  data[0] = SETTLE_N_TAG;
  data.set(params.eventSeed, 1);
  view.setBigUint64(33, params.amount, true);
  data[41] = params.bps.length;
  params.bps.forEach((share, i) => {
    view.setUint16(SETTLE_N_HEADER_LENGTH + 2 * i, share, true);
  });
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
 * Build the `Settle` instruction. Account order must match the program:
 * payer, artist, studio, synxed, settlement record PDA, system program.
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
  const recipients: ReadonlyArray<readonly [string, PublicKey]> = [
    ["artist", accounts.artist],
    ["studio", accounts.studio],
    ["synxed", accounts.synxed],
  ];
  assertNoneIsRecord(recipients, record);
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

export interface SettleNAccounts {
  programId: PublicKey;
  payer: PublicKey;
  /** One writable recipient per share, in the same order as `bps`. */
  recipients: readonly PublicKey[];
}

/**
 * Build the `SettleN` instruction. Account order must match the program:
 * payer, one recipient per share, settlement record PDA, system program.
 */
export function buildSettleNInstruction(
  accounts: SettleNAccounts,
  params: SettleNParams,
): TransactionInstruction {
  if (accounts.recipients.length !== params.bps.length) {
    throw new ProtocolError(
      "RECIPIENT_COUNT",
      `expected ${params.bps.length} recipients, got ${accounts.recipients.length}`,
    );
  }
  const data = encodeSettleNData(params);
  const [record] = findSettlementRecordPda(
    accounts.programId,
    params.eventSeed,
  );
  assertNoneIsRecord(
    accounts.recipients.map((key, i) => [`shares[${i}]`, key] as const),
    record,
  );
  return new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: accounts.payer, isSigner: true, isWritable: true },
      ...accounts.recipients.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      })),
      { pubkey: record, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

function assertNoneIsRecord(
  recipients: ReadonlyArray<readonly [string, PublicKey]>,
  record: PublicKey,
): void {
  for (const [label, key] of recipients) {
    if (key.equals(record)) {
      throw new ProtocolError(
        "RECIPIENT_IS_RECORD",
        `${label} recipient must not be the settlement record account`,
      );
    }
  }
}

function assertAmountU64(amount: bigint): void {
  if (amount <= 0n || amount > U64_MAX) {
    throw new ProtocolError(
      "AMOUNT_U64",
      "amount must be a positive u64 (1..=2^64-1)",
    );
  }
}

function assertSeed(seed: Uint8Array): void {
  if (seed.length !== EVENT_SEED_LENGTH) {
    throw new ProtocolError(
      "SEED_LENGTH",
      `event seed must be exactly ${EVENT_SEED_LENGTH} bytes`,
    );
  }
}
