// Turns a studio's billable events into settlement requests. The input is
// what a game backend already knows: an event id, when it happened, the gross
// amount, and who gets which share.

import { PublicKey } from "@solana/web3.js";
import { computeSettlementN, type SettlementRequestN } from "@coumtech/synxed-solana-protocol";

export interface StudioShare {
  label: string;
  /** The recipient's wallet (base58). */
  recipient: string;
  bps: number;
  /**
   * The stable ledger identity the payout is credited to. Leave it out for a
   * pooled share (by default `rewards_pool`), which is allocated later.
   */
  beneficiaryId?: string;
}

export interface StudioEvent {
  /** Unique per billable event, forever: it is what makes settlement idempotent. */
  eventId: string;
  occurredAt: string;
  /** Gross amount in atomic units (micro-dollars), as a decimal string. */
  amountAtomic: string;
  memo: string;
  shares: readonly StudioShare[];
}

export interface PreparedEvent {
  request: SettlementRequestN;
  beneficiaryIds: Record<string, string>;
}

const DECIMAL = /^[1-9]\d*$/;

/** Validate one event and build its request; throws on anything malformed. */
export function prepareEvent(input: unknown): PreparedEvent {
  if (typeof input !== "object" || input === null) {
    throw new Error("an event must be an object");
  }
  const event = input as Record<string, unknown>;
  const eventId = event["eventId"];
  const occurredAt = event["occurredAt"];
  const amountAtomic = event["amountAtomic"];
  const memo = event["memo"];
  const shares = event["shares"];
  if (typeof eventId !== "string" || eventId.trim() !== eventId || eventId === "") {
    throw new Error("eventId must be a non-empty string without surrounding spaces");
  }
  if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) {
    throw new Error(`${eventId}: occurredAt must be an RFC 3339 timestamp`);
  }
  if (typeof amountAtomic !== "string" || !DECIMAL.test(amountAtomic)) {
    throw new Error(`${eventId}: amountAtomic must be a positive decimal string`);
  }
  if (typeof memo !== "string") {
    throw new Error(`${eventId}: memo must be a string`);
  }
  if (!Array.isArray(shares)) {
    throw new Error(`${eventId}: shares must be an array`);
  }
  const beneficiaryIds: Record<string, string> = {};
  const requestShares = shares.map((share: unknown, index) => {
    if (typeof share !== "object" || share === null) {
      throw new Error(`${eventId}: share ${index} must be an object`);
    }
    const { label, recipient, bps, beneficiaryId } = share as Record<string, unknown>;
    if (typeof label !== "string" || typeof recipient !== "string" || typeof bps !== "number") {
      throw new Error(`${eventId}: share ${index} needs a label, a recipient and bps`);
    }
    try {
      new PublicKey(recipient);
    } catch {
      throw new Error(`${eventId}: share "${label}" has an invalid recipient`);
    }
    if (beneficiaryId !== undefined) {
      if (typeof beneficiaryId !== "string" || beneficiaryId.trim() === "") {
        throw new Error(`${eventId}: share "${label}" has an empty beneficiaryId`);
      }
      beneficiaryIds[label] = beneficiaryId;
    }
    return { label, recipient, bps };
  });
  const request: SettlementRequestN = {
    eventId,
    occurredAt,
    kind: "audio_ad_impression",
    amountAtomic: BigInt(amountAtomic),
    asset: "SOL_LAMPORTS_STANDIN",
    shares: requestShares,
    memo,
  };
  // Refuses bps that do not sum to 10000, duplicate labels, too many shares.
  computeSettlementN(request);
  return { request, beneficiaryIds };
}
