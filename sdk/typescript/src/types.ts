export const BPS_DENOMINATOR = 10_000;

export const DEFAULT_ARTIST_BPS = 3_500;
export const DEFAULT_STUDIO_BPS = 4_000;
export const DEFAULT_SYNXED_BPS = 2_500;

/** $0.020 at 6 decimal places (USDC atomic units). */
export const DEFAULT_AMOUNT_ATOMIC = 20_000n;

export const SETTLEMENT_ROLES = ["artist", "studio", "synxed"] as const;
export type SettlementRole = (typeof SETTLEMENT_ROLES)[number];

export type SettlementKind = "audio_ad_impression";

export interface SplitShare {
  role: SettlementRole;
  /** Base58 Solana pubkey. Empty string is allowed only in dry-run fixtures. */
  recipient: string;
  /** Integer basis points. 10000 = 100%. */
  bps: number;
}

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
  asset: "SOL_LAMPORTS_STANDIN" | "USDC";
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
  | "DUPLICATE_ROLE"
  | "EVENT_ID_EMPTY"
  | "SEED_LENGTH"
  | "AMOUNT_U64"
  | "SCALE_RANGE"
  | "RECIPIENT_PUBKEY";
