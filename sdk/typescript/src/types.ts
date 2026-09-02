export const BPS_DENOMINATOR = 10_000;

/** Upper bound on shares per settlement. Mirrors the program's MAX_SHARES. */
export const MAX_SHARES = 8;

export const DEFAULT_ARTIST_BPS = 3_500;
export const DEFAULT_STUDIO_BPS = 4_000;
export const DEFAULT_SYNXED_BPS = 2_500;

/** $0.020 at 6 decimal places (USDC atomic units). */
export const DEFAULT_AMOUNT_ATOMIC = 20_000n;

export const SETTLEMENT_ROLES = ["artist", "studio", "synxed"] as const;
export type SettlementRole = (typeof SETTLEMENT_ROLES)[number];

export type SettlementKind = "audio_ad_impression";

export type SettlementAsset = "SOL_LAMPORTS_STANDIN" | "USDC";

export interface SplitShare {
  role: SettlementRole;
  /** Base58 Solana pubkey. Empty string is allowed only in dry-run fixtures. */
  recipient: string;
  /** Integer basis points. 10000 = 100%. */
  bps: number;
}

/** A three-way settlement (artist / studio / synxed), the original form. */
export interface SettlementRequest {
  /** Opaque id from the originating platform. Used for idempotency on-chain. */
  eventId: string;
  occurredAt: string;
  kind: SettlementKind;
  /** Gross amount in atomic units (USDC 6-decimals, or SOL lamports in the demo). */
  amountAtomic: bigint;
  /**
   * Demo settlements on devnet use native SOL as a stand-in.
   * An SPL stablecoin path is planned; this repo does not mint a token.
   */
  asset: SettlementAsset;
  splits: readonly [SplitShare, SplitShare, SplitShare];
  memo: string;
}

export interface ComputedPayout {
  role: SettlementRole;
  recipient: string;
  bps: number;
  amountAtomic: bigint;
}

export interface SplitResult {
  request: SettlementRequest;
  payouts: readonly [ComputedPayout, ComputedPayout, ComputedPayout];
  totalAtomic: bigint;
}

/**
 * One share of an N-way settlement. `label` is informational and travels
 * into the ledger (for example "artist", "studio", "synxed", "rewards_pool");
 * the program only sees recipients and basis points.
 */
export interface ShareInput {
  label: string;
  /** Base58 Solana pubkey. Empty string is allowed only in dry-run fixtures. */
  recipient: string;
  /** Integer basis points. 10000 = 100%. */
  bps: number;
}

/** An N-way settlement (1..=MAX_SHARES shares) settled via `SettleN`. */
export interface SettlementRequestN {
  eventId: string;
  occurredAt: string;
  kind: SettlementKind;
  amountAtomic: bigint;
  asset: SettlementAsset;
  shares: readonly ShareInput[];
  memo: string;
}

export interface ComputedPayoutN {
  label: string;
  recipient: string;
  bps: number;
  amountAtomic: bigint;
}

export interface SplitResultN {
  request: SettlementRequestN;
  payouts: readonly ComputedPayoutN[];
  totalAtomic: bigint;
}

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export type ProtocolErrorCode =
  | "BPS_SUM"
  | "BPS_RANGE"
  | "BPS_INTEGER"
  | "ZERO_AMOUNT"
  | "ROLE_MISMATCH"
  | "SHARE_COUNT"
  | "LABEL_EMPTY"
  | "RECIPIENT_COUNT"
  | "EVENT_ID_EMPTY"
  | "SEED_LENGTH"
  | "AMOUNT_U64"
  | "SCALE_RANGE"
  | "RECIPIENT_PUBKEY"
  | "RECIPIENT_IS_RECORD";
