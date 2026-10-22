// Client-side codec for the on-chain settlement program.
//
// Byte layouts must stay in lockstep with
// `programs/synxed-settlement/src/instruction.rs`:
//   CreateNamespace:       tag(u8=3) | namespace_id([u8;32]) | authority([u8;32])
//   SetNamespaceAuthority: tag(u8=4) | new_authority([u8;32])
//   SettleN:      tag(u8=5) | event_id([u8;32]) | amount(u64 LE) |
//                 count(u8) | bps[count](u16 LE)
//   SettleTokenN: tag(u8=6) | event_id([u8;32]) | amount(u64 LE) |
//                 decimals(u8) | count(u8) | bps[count](u16 LE)
// Tags 0 to 2 are retired: they keyed the settlement record on the event id
// alone, and the program refuses them.

import { sha256 } from "@noble/hashes/sha256";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { assertBpsShares } from "./split.ts";
import { ProtocolError } from "./types.ts";

/** The original `Settle`, `SettleN`, and `SettleTokenN`, refused on-chain. */
export const RETIRED_TAGS = [0, 1, 2] as const;
export const CREATE_NAMESPACE_TAG = 3;
export const SET_NAMESPACE_AUTHORITY_TAG = 4;
export const SETTLE_N_TAG = 5;
export const SETTLE_TOKEN_N_TAG = 6;
export const SETTLEMENT_SEED = "settlement";
export const NAMESPACE_SEED = "namespace";
export const EVENT_SEED_LENGTH = 32;
export const NAMESPACE_ID_LENGTH = 32;
export const CREATE_NAMESPACE_DATA_LENGTH = 1 + 32 + 32;
export const SET_NAMESPACE_AUTHORITY_DATA_LENGTH = 1 + 32;
/** `SettleN` bytes before the bps list: tag + event id + amount + count. */
export const SETTLE_N_HEADER_LENGTH = 1 + 32 + 8 + 1;
export const SETTLE_TOKEN_N_HEADER_LENGTH = 1 + 32 + 8 + 1 + 1;
/**
 * Namespace account layout: discriminator, bump, creator, namespace id,
 * current authority.
 */
export const NAMESPACE_ACCOUNT_SIZE = 1 + 1 + 32 + 32 + 32;
export const NAMESPACE_DISCRIMINATOR = 2;
/** Settlement record layout: discriminator, event id, amount (u64 LE). */
export const SETTLEMENT_RECORD_SIZE = 1 + 32 + 8;
export const SETTLEMENT_RECORD_DISCRIMINATOR = 1;

export const U64_MAX = 0xffff_ffff_ffff_ffffn;

/**
 * Derive the fixed-size on-chain event id from an application event id.
 * The program keys its idempotency record on these 32 bytes and the
 * namespace.
 */
export function eventIdSeed(eventId: string): Uint8Array {
  if (eventId.length === 0) {
    throw new ProtocolError("EVENT_ID_EMPTY", "eventId must not be empty");
  }
  return sha256(new TextEncoder().encode(eventId));
}

/**
 * Derive a 32-byte namespace id from a readable label, such as
 * "studio-payouts". Any 32 bytes work as a namespace id; this is a
 * convenience so a label can name one.
 */
export function namespaceIdFromLabel(label: string): Uint8Array {
  if (label.length === 0) {
    throw new ProtocolError("NAMESPACE_ID", "namespace label must not be empty");
  }
  return sha256(new TextEncoder().encode(label));
}

/**
 * Address of the namespace `creator` opened under `namespaceId`. The creator
 * is part of the address, so nobody else can open it, and it stays fixed when
 * the authority is rotated.
 */
export function findNamespacePda(
  programId: PublicKey,
  creator: PublicKey,
  namespaceId: Uint8Array,
): readonly [PublicKey, number] {
  assertNamespaceId(namespaceId);
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(NAMESPACE_SEED), creator.toBytes(), namespaceId],
    programId,
  );
  return [pda, bump];
}

/** PDA of the record that marks an event id as settled in `namespace`. */
export function findSettlementRecordPda(
  programId: PublicKey,
  namespace: PublicKey,
  seed: Uint8Array,
): readonly [PublicKey, number] {
  assertSeed(seed);
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(SETTLEMENT_SEED), namespace.toBytes(), seed],
    programId,
  );
  return [pda, bump];
}

/**
 * Address of the record a retired instruction (tags 0 to 2) created for an
 * event id: `["settlement", event_id]`. Those records stay on chain after the
 * program moves to namespaces, but a namespaced settlement uses a different
 * address, so it does not see them. Before retrying an event first attempted
 * before namespaces, check that no account exists here: if one does, the
 * event was already settled and must not be settled again.
 */
export function findLegacySettlementRecordPda(
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

/** A namespace account's contents, as stored on-chain. */
export interface NamespaceAccount {
  bump: number;
  creator: PublicKey;
  namespaceId: Uint8Array;
  authority: PublicKey;
}

/**
 * Decode a namespace account's data. Check separately that the account is
 * owned by the settlement program: only then is the content authoritative.
 */
export function decodeNamespaceAccount(data: Uint8Array): NamespaceAccount {
  if (data.length !== NAMESPACE_ACCOUNT_SIZE || data[0] !== NAMESPACE_DISCRIMINATOR) {
    throw new ProtocolError(
      "NAMESPACE_ACCOUNT",
      "account data is not a settlement namespace",
    );
  }
  return {
    bump: data[1],
    creator: new PublicKey(data.slice(2, 34)),
    namespaceId: data.slice(34, 66),
    authority: new PublicKey(data.slice(66, 98)),
  };
}

export interface CreateNamespaceParams {
  namespaceId: Uint8Array;
  /** The only key that can settle in, or rotate, the namespace. */
  authority: PublicKey;
}

export function encodeCreateNamespaceData(
  params: CreateNamespaceParams,
): Uint8Array {
  assertNamespaceId(params.namespaceId);
  assertAuthority(params.authority);
  const data = new Uint8Array(CREATE_NAMESPACE_DATA_LENGTH);
  data[0] = CREATE_NAMESPACE_TAG;
  data.set(params.namespaceId, 1);
  data.set(params.authority.toBytes(), 33);
  return data;
}

export function encodeSetNamespaceAuthorityData(newAuthority: PublicKey): Uint8Array {
  assertAuthority(newAuthority);
  const data = new Uint8Array(SET_NAMESPACE_AUTHORITY_DATA_LENGTH);
  data[0] = SET_NAMESPACE_AUTHORITY_TAG;
  data.set(newAuthority.toBytes(), 1);
  return data;
}

export interface SettleNParams {
  eventSeed: Uint8Array;
  amount: bigint;
  /** One entry per share, in recipient order. */
  bps: readonly number[];
}

export interface SettleTokenNParams extends SettleNParams {
  decimals: number;
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

export function encodeSettleTokenNData(
  params: SettleTokenNParams,
): Uint8Array {
  assertSeed(params.eventSeed);
  assertAmountU64(params.amount);
  assertBpsShares(params.bps);
  if (!Number.isInteger(params.decimals) || params.decimals < 0 || params.decimals > 255) {
    throw new ProtocolError(
      "TOKEN_DECIMALS",
      "token decimals must be an integer in 0..=255",
    );
  }
  const data = new Uint8Array(
    SETTLE_TOKEN_N_HEADER_LENGTH + 2 * params.bps.length,
  );
  const view = new DataView(data.buffer);
  data[0] = SETTLE_TOKEN_N_TAG;
  data.set(params.eventSeed, 1);
  view.setBigUint64(33, params.amount, true);
  data[41] = params.decimals;
  data[42] = params.bps.length;
  params.bps.forEach((share, index) => {
    view.setUint16(SETTLE_TOKEN_N_HEADER_LENGTH + 2 * index, share, true);
  });
  return data;
}

export interface CreateNamespaceAccounts {
  programId: PublicKey;
  /** Funds the namespace account's rent. */
  payer: PublicKey;
  /** Signs, and is part of the namespace address. Often the payer. */
  creator: PublicKey;
}

/**
 * Build `CreateNamespace`. Account order must match the program: payer,
 * creator, namespace PDA, system program.
 */
export function buildCreateNamespaceInstruction(
  accounts: CreateNamespaceAccounts,
  params: CreateNamespaceParams,
): TransactionInstruction {
  const data = encodeCreateNamespaceData(params);
  const [namespace] = findNamespacePda(
    accounts.programId,
    accounts.creator,
    params.namespaceId,
  );
  return new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: accounts.payer, isSigner: true, isWritable: true },
      { pubkey: accounts.creator, isSigner: true, isWritable: false },
      { pubkey: namespace, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export interface SetNamespaceAuthorityAccounts {
  programId: PublicKey;
  /** The namespace's current authority, which signs. */
  authority: PublicKey;
  namespace: PublicKey;
}

/**
 * Build `SetNamespaceAuthority`. Account order must match the program:
 * current authority, namespace, new authority. Both authorities sign, so a
 * namespace can never be handed to a key nobody can sign for.
 */
export function buildSetNamespaceAuthorityInstruction(
  accounts: SetNamespaceAuthorityAccounts,
  newAuthority: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: accounts.authority, isSigner: true, isWritable: false },
      { pubkey: accounts.namespace, isSigner: false, isWritable: true },
      { pubkey: newAuthority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(encodeSetNamespaceAuthorityData(newAuthority)),
  });
}

export interface SettleNAccounts {
  programId: PublicKey;
  payer: PublicKey;
  /** The namespace's current authority, which signs. Often the payer. */
  authority: PublicKey;
  namespace: PublicKey;
  /** One writable recipient per share, in the same order as `bps`. */
  recipients: readonly PublicKey[];
}

export interface SettleTokenNAccounts {
  programId: PublicKey;
  /** Pays rent and owns the source token account. */
  payer: PublicKey;
  /** The namespace's current authority, which signs. Often the payer. */
  authority: PublicKey;
  namespace: PublicKey;
  sourceTokenAccount: PublicKey;
  recipientTokenAccounts: readonly PublicKey[];
  mint: PublicKey;
  tokenProgramId?: PublicKey;
}

/**
 * Build `SettleN`. Account order must match the program: payer, namespace
 * authority, namespace, one recipient per share, settlement record PDA,
 * system program.
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
    accounts.namespace,
    params.eventSeed,
  );
  assertNoProgramAccountRecipient(
    accounts.recipients.map((key, i) => [`shares[${i}]`, key] as const),
    record,
    accounts.namespace,
  );
  return new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: accounts.payer, isSigner: true, isWritable: true },
      { pubkey: accounts.authority, isSigner: true, isWritable: false },
      { pubkey: accounts.namespace, isSigner: false, isWritable: false },
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

/**
 * Build `SettleTokenN`. Account order must match the program: payer,
 * namespace authority, namespace, source token account, one destination per
 * share, mint, settlement record PDA, system program, token program.
 */
export function buildSettleTokenNInstruction(
  accounts: SettleTokenNAccounts,
  params: SettleTokenNParams,
): TransactionInstruction {
  if (accounts.recipientTokenAccounts.length !== params.bps.length) {
    throw new ProtocolError(
      "RECIPIENT_COUNT",
      `expected ${params.bps.length} token recipients, got ${accounts.recipientTokenAccounts.length}`,
    );
  }
  const tokenProgramId = accounts.tokenProgramId ?? TOKEN_PROGRAM_ID;
  if (!tokenProgramId.equals(TOKEN_PROGRAM_ID)) {
    throw new ProtocolError(
      "TOKEN_PROGRAM",
      "SettleTokenN currently supports only the classic SPL Token program",
    );
  }
  const data = encodeSettleTokenNData(params);
  const [record] = findSettlementRecordPda(
    accounts.programId,
    accounts.namespace,
    params.eventSeed,
  );
  assertNoProgramAccountRecipient(
    accounts.recipientTokenAccounts.map((key, index) =>
      [`shares[${index}]`, key] as const,
    ),
    record,
    accounts.namespace,
  );
  if (
    accounts.recipientTokenAccounts.some((recipient) =>
      recipient.equals(accounts.sourceTokenAccount),
    )
  ) {
    throw new ProtocolError(
      "TOKEN_SOURCE_RECIPIENT",
      "source token account cannot also be a settlement recipient",
    );
  }
  return new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: accounts.payer, isSigner: true, isWritable: true },
      { pubkey: accounts.authority, isSigner: true, isWritable: false },
      { pubkey: accounts.namespace, isSigner: false, isWritable: false },
      { pubkey: accounts.sourceTokenAccount, isSigner: false, isWritable: true },
      ...accounts.recipientTokenAccounts.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      })),
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: record, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

// The program refuses any recipient it owns, because nothing could withdraw a
// payout from it. The client can name two of them: this event's record and
// the namespace.
function assertNoProgramAccountRecipient(
  recipients: ReadonlyArray<readonly [string, PublicKey]>,
  record: PublicKey,
  namespace: PublicKey,
): void {
  for (const [label, key] of recipients) {
    if (key.equals(record)) {
      throw new ProtocolError(
        "RECIPIENT_IS_RECORD",
        `${label} recipient must not be the settlement record account`,
      );
    }
    if (key.equals(namespace)) {
      throw new ProtocolError(
        "RECIPIENT_IS_NAMESPACE",
        `${label} recipient must not be the settlement namespace account`,
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

function assertNamespaceId(namespaceId: Uint8Array): void {
  if (namespaceId.length !== NAMESPACE_ID_LENGTH) {
    throw new ProtocolError(
      "NAMESPACE_ID",
      `namespace id must be exactly ${NAMESPACE_ID_LENGTH} bytes`,
    );
  }
}

// The all-zero key is the system program's id. Nobody can sign for it, so the
// program refuses it as an authority.
function assertAuthority(authority: PublicKey): void {
  if (authority.equals(PublicKey.default)) {
    throw new ProtocolError(
      "NAMESPACE_AUTHORITY",
      "namespace authority must not be the all-zero key",
    );
  }
}
