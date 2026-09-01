# Payout ledger — proposal

> **Status: proposal, not implemented.** This document specifies the
> off-chain ledger that sits between settlement transactions and the
> people who are owed money. It is published for review ahead of the next
> release; nothing here is enforced by the current program or SDK.

## Why a ledger

The settlement program answers one question per event: *how much did each
recipient wallet receive, and can this event ever be paid twice?* It does
not answer the questions a studio's finance team or an artist's statement
needs: *what did I earn this month, from which games, and has it been paid
out?* Nor can it pay individual listeners — a listener's share of one
impression is a fraction of a cent, far below the rent minimum a fresh
Solana wallet needs to hold a balance.

The ledger is the public schema for those answers. It is deliberately
**derivable**: every ledger entry traces back to an on-chain settlement
signature, so any party can rebuild the ledger from chain data plus the
platform's settlement requests and check that they agree.

## Entities

### `SettlementRecord`

One row per settled event. Mirrors the on-chain settlement exactly.

| Field | Type | Notes |
| --- | --- | --- |
| `eventId` | string | Application event id; `sha256(eventId)` is the on-chain seed |
| `signature` | string | Transaction signature (base58) |
| `slot` | integer | Slot the transaction landed in |
| `cluster` | `"devnet"` \| `"mainnet-beta"` | Devnet only today |
| `mode` | `"program"` \| `"system-transfer"` | Which settlement mode produced it |
| `asset` | string | `"SOL_LAMPORTS_STANDIN"` today; SPL mint address later |
| `amountAtomic` | string (u64) | Gross amount settled, in the asset's atomic units |
| `payouts` | `PayoutLine[]` | Exactly one per configured share, in share order |
| `occurredAt` | RFC 3339 | From the originating `SettlementRequest` |
| `settledAt` | RFC 3339 | Block time of the transaction |

### `PayoutLine`

One row per recipient per settlement.

| Field | Type | Notes |
| --- | --- | --- |
| `role` | string | `artist`, `studio`, `platform`, `rewards_pool`, … |
| `recipient` | string | Wallet that received the funds on-chain |
| `bps` | integer | Share in basis points at settlement time |
| `amountAtomic` | string (u64) | Exact on-chain amount (floor / remainder rule applied) |
| `beneficiary` | string \| null | Ledger-level owner when `recipient` is a pool or custodian |

`amountAtomic` across a settlement's `PayoutLine`s must sum to the
settlement's `amountAtomic`. Ledger builders reject rows that do not.

### `LedgerEntry`

The unit of "who is owed what". Produced by fanning `PayoutLine`s out to
their ultimate beneficiaries.

| Field | Type | Notes |
| --- | --- | --- |
| `entryId` | string | `sha256(signature + role + beneficiary)`; idempotent |
| `beneficiary` | string | Wallet or platform account id |
| `role` | string | Same vocabulary as `PayoutLine.role` |
| `amountAtomic` | string (u64) | Amount credited to the beneficiary |
| `sourceSignature` | string | On-chain settlement this entry derives from |
| `state` | `"accrued"` \| `"claimable"` \| `"paid"` | See lifecycle |
| `paidSignature` | string \| null | Transaction that paid the beneficiary, once `paid` |

For direct recipients (artist, studio, platform) the entry is `paid` the
moment the settlement lands: the on-chain transfer *is* the payout, and
`paidSignature == sourceSignature`.

### `ClaimBatch`

How pooled shares reach many small beneficiaries.

| Field | Type | Notes |
| --- | --- | --- |
| `batchId` | string | Unique per batch |
| `pool` | string | Pool wallet the batch draws from |
| `entries` | string[] | `entryId`s included; each must be `claimable` |
| `totalAtomic` | string (u64) | Sum of included entries |
| `signature` | string \| null | Distribution transaction once executed |

## Lifecycle

```
settlement lands on-chain
  -> SettlementRecord written (1 per event)
  -> PayoutLine per share
       direct share   -> LedgerEntry{state: paid}        (transfer already happened)
       pooled share   -> LedgerEntry{state: accrued} per beneficiary
                          -> beneficiary balance >= claim threshold
                          -> LedgerEntry{state: claimable}
                          -> ClaimBatch executes one on-chain distribution
                          -> LedgerEntry{state: paid, paidSignature}
```

## Pooled shares (listener rewards)

A pooled share is a normal on-chain recipient — one wallet, one transfer
per settlement — so the program stays simple and cheap. What makes it a
*pool* is ledger-level: the platform's attribution layer decides which
listeners earned a slice of that share (eligibility, fraud screening, and
weighting are entirely off-chain and outside this repository), and the
ledger records one `accrued` entry per listener. Entries become `claimable`
once a listener's balance clears the claim threshold (proposed default: the
rent-exempt minimum for a system account plus one distribution fee), and a
`ClaimBatch` pays many listeners in one transaction.

Pool distributions are paid in the same asset as settlements (SOL on
devnet, an SPL stablecoin later). There is no reward token and this
proposal does not introduce one.

## Reconciliation

Because every `LedgerEntry` carries a `sourceSignature`, reconciliation is
a fold over chain data:

1. For each settlement signature, fetch the transaction and recompute the
   `PayoutLine`s from its transfers.
2. Compare against the ledger's `SettlementRecord`; any mismatch is a
   ledger defect, never a chain defect.
3. Sum `LedgerEntry.amountAtomic` per pool and compare with the pool
   wallet's on-chain inflows minus executed `ClaimBatch` totals; the
   difference is the pool's undistributed balance and must be non-negative.

## Open questions for review

- Claim threshold: fixed per asset, or configurable per pool?
- Should `beneficiary` for listeners be a wallet, or a platform account id
  that is later bound to a wallet at claim time?
- Retention: how long must `accrued` entries stay claimable before they
  return to the pool (if ever)?
- Whether `SettlementRecord.mode == "system-transfer"` rows belong in a
  production ledger at all, given that mode has no on-chain idempotency.
