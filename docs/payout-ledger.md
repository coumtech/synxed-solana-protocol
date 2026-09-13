# Payout ledger and reconciliation

> **Status: Open-source reference implementation.** The public TypeScript SDK
> defines these records, extracts evidence from finalized `SettleN`
> transactions, and rejects any mismatch in event seed, amount, shares,
> recipients, memo, or inner transfers. It is an auditable reference layer,
> not SYNXED's private production database.

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
| `schemaVersion` | `1` | Explicit storage contract version for future migrations |
| `eventId` | string | Application event id; `sha256(eventId)` is the on-chain seed |
| `signature` | string | Transaction signature (base58) |
| `slot` | integer | Slot the transaction landed in |
| `cluster` | `"devnet"` \| `"mainnet-beta"` | Devnet only today |
| `programId` | string | Settlement program whose instruction was reconciled |
| `payer` | string | Signing settlement authority and funding wallet |
| `settlementRecord` | string | On-chain idempotency-record PDA |
| `mode` | `"program"` \| `"program-token"` | Only program-mode transactions are authoritative ledger inputs |
| `asset` | string | `"SOL_LAMPORTS_STANDIN"`, `"SPL_STABLECOIN"`, or `"USDC"`; token identity is also bound by `mint` |
| `mint` | string \| null | Classic SPL Token mint for token settlements; `null` for native SOL |
| `decimals` | integer \| null | Mint decimals checked by the program; `null` for native SOL |
| `amountAtomic` | string (u64) | Gross amount as requested, in the request's atomic units (micro-dollars in the demo) |
| `unitsPerAtomicUnit` | string (u64) | Asset-unit scaling applied at settlement; on-chain total = `amountAtomic × unitsPerAtomicUnit` |
| `payouts` | `PayoutLine[]` | Exactly one per configured share, in share order |
| `occurredAt` | RFC 3339 | From the originating `SettlementRequest` |
| `settledAt` | RFC 3339 | Block time of the transaction |

### `PayoutLine`

One row per recipient per settlement.

| Field | Type | Notes |
| --- | --- | --- |
| `role` | string | `artist`, `studio`, `platform`, `rewards_pool`, … (the SDK's `synxed` role maps to `platform`) |
| `recipient` | string | Wallet that received the funds on-chain |
| `destinationAccount` | string | Recipient wallet for native SOL; associated token account for SPL Token payouts |
| `bps` | integer | Share in basis points at settlement time |
| `amountOnChain` | string (u64) | Exact on-chain amount in on-chain units (lamports on devnet), floor / remainder rule applied |
| `beneficiaryId` | string \| null | Stable ledger identity; `null` when the recipient is a pool awaiting allocation |

`amountOnChain` across a settlement's `PayoutLine`s must sum to
`amountAtomic × unitsPerAtomicUnit`. Ledger builders reject rows that do
not.

### `LedgerEntry`

The unit of "who is owed what". Produced by fanning `PayoutLine`s out to
their ultimate beneficiaries.

| Field | Type | Notes |
| --- | --- | --- |
| `entryId` | string | `sha256(signature + role + beneficiary)`; idempotent |
| `beneficiaryId` | string | Stable platform identity, deliberately separate from a wallet |
| `wallet` | string \| null | Current payout wallet, if one is bound |
| `role` | string | Same vocabulary as `PayoutLine.role` |
| `pool` | string \| null | Pool wallet for accrued entries; `null` for direct payouts |
| `amountOnChain` | string (u64) | Amount credited to the beneficiary, in on-chain units |
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
| `totalOnChain` | string (u64) | Sum of included entries, in on-chain units |
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

Pool distributions are paid in the same asset as settlements (SOL or the
configured classic SPL Token mint on devnet). There is no reward token and this
proposal does not introduce one.

## Reconciliation

Because every `LedgerEntry` carries a `sourceSignature`, reconciliation is
a fold over chain data:

1. For each settlement signature, fetch the transaction and recompute the
   `PayoutLine`s from its transfers.
2. Compare against the ledger's `SettlementRecord`; any mismatch is a
   ledger defect, never a chain defect.
3. Sum `LedgerEntry.amountOnChain` per pool and compare with the pool
   wallet's on-chain inflows minus executed `ClaimBatch` totals; the
   difference is the pool's undistributed balance and must be non-negative.

The SDK's `reconcileSettlementN` and `reconcileTokenSettlementN` wait for
finality, decode the instruction,
derives its settlement-record PDA, validates the structured memo, and compares
the exact multiset of inner system transfers. Record-account rent transfers are
identified separately and never counted as payouts. `allocatePoolPayout`
requires unique beneficiary IDs, positive amounts, and exact conservation.

## Public ledger policy decisions

- Claim thresholds are configurable per pool and asset; no global hard-coded
  amount can remain correct across SOL and tokens with different decimals.
- Beneficiaries use stable platform IDs with optional wallet bindings so wallet
  rotation does not break accounting history.
- Accrued value does not expire automatically. Any future retention or return
  policy must be explicit, versioned, and auditable.
- System-transfer demo transactions are not authoritative ledger inputs because
  they do not have the program's on-chain idempotency record.
