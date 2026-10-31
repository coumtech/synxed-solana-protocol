# Studio integration guide

This guide is for a game studio that wants its backend to pay revenue
shares through the settlement program, using only the public TypeScript SDK
(`@coumtech/synxed-solana-protocol`). It walks through a runnable reference
worker, [examples/studio-backend](../examples/studio-backend), which you can
run as it is on devnet or copy into your own service.

Everything here is devnet only. The program is not audited and is not
deployed on mainnet.

## 1. Who does what

| Part | Responsibility |
| --- | --- |
| Your game backend | Records billable events (for example ad impressions) and decides who gets which share |
| The worker | Turns events into settlement requests, sends them, and writes the ledger only from finalized chain evidence |
| The settlement program | Pays every share exactly and atomically, refuses a second settlement of an event id in your namespace, and lets only your namespace's authority settle in it |
| Your ledger | Records what was paid, to whom, by which transaction; pooled shares wait there for allocation |

What the chain guarantees is in [protocol.md](protocol.md); what it does not,
and what you must check yourself, is in [security-model.md](security-model.md).
The short version: the chain stops an event from being paid twice in your
namespace, but only your own records can tell whether a settlement is the one
you meant to send.

## 2. Keys

- **Payer:** a hot key the worker holds. It pays the settled amount, the rent
  for each settlement record, and the fees. Fund it with what you expect to
  settle, not more.
- **Namespace authority:** the only key that can settle in your namespace.
  Keep it separate from the payer in production (a hardware key, or a
  multisig reconciled by hand), so a stolen payer key alone cannot settle.
  The reference worker takes it as `SETTLEMENT_AUTHORITY_KEYPAIR`; without
  it, the payer is the authority. The worker signs with a local keypair, so
  a hardware key or a multisig needs a different signer.
- Keep keypair files out of the repository (`.keys/` is ignored) and out of
  logs. Rotate a key that was ever pasted into chat, CI output, or a pull
  request (see "Operating a payer key" in
  [security-model.md](security-model.md)).

## 3. Set up once

```bash
bun install
export SOLANA_PAYER_KEYPAIR=.keys/studio-payer.json
export SETTLEMENT_PROGRAM_ID=<deployed program id>
export STUDIO_NAMESPACE=studio-payouts-devnet
bun run studio init
```

`init` opens the payer's namespace under that label (the payer is its
creator, and the authority is `SETTLEMENT_AUTHORITY_KEYPAIR`'s key or the
payer), or checks the one that exists, and prints its address. Pin it:

```bash
export SETTLEMENT_NAMESPACE_ADDRESS=<address printed by init>
```

From then on `init`, `dry-run`, `run` and `resolve` check that the namespace
exists at exactly that address and never open a new one; `enqueue`, `status`
and `ledger` are local to the database and do not load the chain config.
Idempotency is per namespace: settling in
a fresh namespace would let every event id be settled again. Use one
namespace per environment (for example `studio-payouts-staging` and
`studio-payouts`).

| Variable | Meaning |
| --- | --- |
| `SOLANA_RPC_URL` | Primary RPC endpoint (default: the public devnet endpoint) |
| `SOLANA_SECOND_RPC_URL` | An independent second provider; every paid, incident, and retry decision is confirmed on it. Strongly recommended; without it the primary is trusted alone |
| `SOLANA_PAYER_KEYPAIR` | Path to the payer's JSON keypair |
| `SETTLEMENT_AUTHORITY_KEYPAIR` | Path to the namespace authority's keypair, when it is not the payer |
| `SETTLEMENT_PROGRAM_ID` | The settlement program |
| `STUDIO_NAMESPACE` | The namespace label (default `studio-payouts-devnet`) |
| `SETTLEMENT_NAMESPACE_ADDRESS` | The pinned namespace address |
| `LAMPORTS_PER_UNIT` | Lamports paid per atomic unit on devnet (default 1000, so $0.020 settles as 0.02 SOL) |
| `STUDIO_DB` | The worker's SQLite file (default `.local/studio-backend.sqlite`, ignored by git) |
| `STUDIO_MAX_ATTEMPTS` | Attempts per event before a person must look (default 5) |

## 4. From billable events to settlement requests

The worker reads an array of events as JSON, like
[events.example.json](../examples/studio-backend/events.example.json). One
object is shown here; the file itself is an array:

```json
{
  "eventId": "evt_studio_example_0001",
  "occurredAt": "2026-10-01T12:00:00.000Z",
  "amountAtomic": "20000",
  "memo": "audio ad in Skyline Runners, 1 October batch",
  "shares": [
    { "label": "artist", "recipient": "<wallet>", "bps": 3500, "beneficiaryId": "artist:aurora-lane" },
    { "label": "studio", "recipient": "<wallet>", "bps": 3500, "beneficiaryId": "studio:skyline-games" },
    { "label": "synxed", "recipient": "<wallet>", "bps": 2000, "beneficiaryId": "platform:synxed" },
    { "label": "rewards_pool", "recipient": "<wallet>", "bps": 1000 }
  ]
}
```

- **The event id is the idempotency key.** Derive it from your own records
  so that the same billable event always gets the same id (for example
  `impressions:<campaign>:<day>`), and never reuse an id for a different
  amount or split. The worker refuses to store an id again with a different
  request.
- **Settle aggregates, not single impressions.** Each settlement locks rent
  in a record that is never closed (known limitation 2 in
  [security-model.md](security-model.md)), which is comparable to the value
  of one impression. Settle one event per campaign and period instead.
- **Shares:** one to eight, basis points summing to 10000, each paid to a
  wallet. A new recipient account must receive at least the rent-exempt
  minimum, which `LAMPORTS_PER_UNIT` keeps true for the example amounts.
- **Beneficiary ids** are your stable identities for the people and
  companies paid, kept apart from wallets so that a changed wallet does not
  break your accounting. A share without one whose label is `rewards_pool`
  (the SDK's default pooled label) is a pool, recorded for later allocation
  to many listeners (see [payout-ledger.md](payout-ledger.md)); the example
  worker does not pool another label.

```bash
bun run studio enqueue examples/studio-backend/events.example.json
```

## 5. Settle

```bash
bun run studio dry-run     # builds and simulates; sends nothing, writes no state
bun run studio run         # resolves in-flight events, then settles pending ones
bun run studio status      # events by status, and the ones that need a person
bun run studio ledger      # paid amounts per beneficiary
```

Each `run` first resolves every event that is in flight, then settles up to
ten pending events (`bun run studio run 50` for more), one transaction each.
For every attempt the worker:

1. stores the attempt, with the exact request and parameters, before signing;
2. signs, then stores the signature and the signed bytes before sending;
3. sends, and decides the outcome from the chain, never from the send call
   alone (a send can fail after the transaction reached the cluster);
4. writes the ledger only after the finalized transaction that created the
   event's record matches a stored request, on both providers when a second
   one is configured.

Until an attempt's blockhash expires, the worker only resends the same
signed bytes, which cannot land twice. It sends a new attempt only once no
earlier one can land and the record is missing on both providers. Even if
your own state were wrong, the program refuses a second settlement of the
same event id in your namespace.

Run it from a scheduler (cron, a queue consumer) as often as you like. Run
only one worker per namespace and database at a time.

## 6. Reconcile and keep the ledger

A paid event has, in the worker's database:

- the reconciled `SettlementRecord` (schema version 2), with the signature,
  namespace, authority, payer, record address, and every payout line;
- one `paid` ledger entry per direct share, with a deterministic entry id;
- the pooled payout lines, waiting for `allocatePoolPayout`.

Every outcome other than paid, and what to do about it, is in the
[reconciliation runbook](reconciliation.md).

## 7. Operating it

- **Funding:** each settlement spends the settled amount, the record's rent
  (0.00085852 SOL on devnet on 28 October 2026), and the fee. A refused send
  (for example for insufficient funds) puts the event back in the queue; once
  `STUDIO_MAX_ATTEMPTS` failed attempts are recorded, the next run marks it
  `needs_attention`. `bun run studio resolve <eventId>` then decides it from
  the chain without sending a new attempt (an existing signed attempt may be
  resent unchanged, as always).
- **RPC faults:** the blockhash is read before an attempt is stored, so a
  transient failure uses no attempt: the event stays pending, the run reports
  `retry`, and the note says so. A fault after a decision (paid, incident or
  needs attention) does not change that decision.
- **Alerts:** alert on any `incident` or `needs_attention` event, and on
  events in flight for longer than a few minutes. `bun run studio status`
  lists them with the worker's note.
- **Keys:** rotate the namespace authority with
  `buildSetNamespaceAuthorityInstruction` while you still hold it; both the
  current and the new key sign, and every record stays. Nobody can recover a
  namespace whose authority key is lost (see
  [integration.md](integration.md), section 5).
- **Stablecoins:** the reference worker settles native SOL as a stand-in. A
  classic SPL Token settlement follows the same procedure with
  `buildTokenSettlementNTransaction` and `reconcileTokenSettlementN` (see
  [spl-stablecoin.md](spl-stablecoin.md)).

## 8. Using the SDK directly

The worker is a few hundred lines over these SDK calls, which you can use in
any backend:

| Step | SDK |
| --- | --- |
| Open or check the namespace | `ensureNamespace` (with `create: false` and `expectedAddress` once pinned) |
| Build an unsigned settlement | `buildSettlementNTransaction` |
| Check whether an event is settled | `fetchSettlementRecord` (only a program-owned record for the event counts) |
| Find the transaction that settled it | `findSettlementTransaction` |
| Reconcile finalized evidence | `reconcileSettlementN`, `reconcileTokenSettlementN` |
| Check an RPC endpoint's cluster | `assertLedgerCluster` |
| Allocate a pooled share | `allocatePoolPayout` |
