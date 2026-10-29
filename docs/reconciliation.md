# Reconciliation runbook

How to decide, for any settlement, whether the event is paid, may still be
paid, must be sent again, or needs a person. It is the operating procedure
behind known limitation 1 of [security-model.md](security-model.md), which
explains why each step is needed, and it is what the reference worker in
[examples/studio-backend](../examples/studio-backend) does
(`SettlementWorker.resolve`). The ledger it writes is described in
[payout-ledger.md](payout-ledger.md).

## What you must have stored

Reconciliation compares chain evidence with your own records, so it is only
as good as they are. Before sending any settlement, store:

- the event id, and the exact request (amount, asset, shares, memo,
  occurrence time);
- the attempt number, and the parameters it was built with: program id,
  namespace, the scale (`lamportsPerAtomicUnit`), payer and authority, and
  for tokens the mint and decimals;
- the beneficiary ids that label its ledger rows;
- the signature and the signed bytes, with the blockhash's last valid block
  height, before the transaction is sent.

Keep every attempt, including failed ones, for good. A retry sends the same
stored request again under the same event id.

## The procedure

Use two independent RPC providers, both checked with `assertLedgerCluster`.
"Confirm" below means asking the second provider the same question and
getting the same answer.

**1. Could any attempt still land?** For each signed attempt, ask for its
signature status with `searchTransactionHistory`.

- Not seen, and the current block height is at or below the attempt's last
  valid block height: it may still land. Resend the same signed bytes (the
  same transaction cannot land twice) and wait.
- Seen but not yet confirmed: wait.
- Finalized with an error: that attempt did not create the record (a
  transaction is atomic). It is failed.
- Confirmed or finalized without an error: it landed; step 2 finds it.

Never send a new attempt while an earlier one could still land.

**2. Does the event's record exist?** Call `fetchSettlementRecord` with your
namespace and the event's seed (`eventIdSeed`). Only an account the program
owns, of the record's size and type, holding this event id, counts; lamports
someone sent to the address do not.

- No record, and step 1 found nothing that could still land: confirm the
  null on the second provider. Then the event is unpaid: send it again,
  with the same stored request, under the same event id. If the providers
  disagree, it is unresolved.
- A record: go to step 3.

**3. Which transaction created it?** Call `findSettlementTransaction`. It
pages the record's finalized history and returns the one successful
settlement of this event in your namespace. Confirm it on the second
provider: same signature, finalized and successful.

- `RECORD_HISTORY` (none found, more than one, or more history than you
  allowed): unresolved. An RPC node may have pruned old history; ask an
  archival provider.
- `topLevel: false`: another program (a multisig, for example) invoked the
  settlement. The SDK's reconcile functions read only top-level settlements:
  compare that transaction with your stored requests by hand.

**4. Does it match a request you stored?** Reconcile the transaction against
each distinct stored request for the event, with that attempt's parameters
and without beneficiary ids (`reconcileSettlementN`, or
`reconcileTokenSettlementN` for tokens), on both providers.

- A request matches on both: **paid**. Reconcile once more with the
  beneficiary ids and write the settlement record, its direct ledger
  entries, and its pooled payout lines in one database transaction.
- Every request fails with a field mismatch on both providers, or none is
  stored: **incident**. Your namespace's authority settled something you did
  not record. Do not mark the event paid and do not settle it again; find out
  who used the key, and rotate the authority if it may be exposed.
- Anything else: **unresolved**. Retry later, and escalate to a person if it
  stays that way.

## Outcomes at a glance

| Outcome | Meaning | Action |
| --- | --- | --- |
| Paid | Finalized evidence matches a stored request on both providers | Write the ledger rows; nothing else to do |
| Waiting | An attempt may still land | Resend the same bytes; check again shortly |
| Retry | No attempt can land, and no record exists on either provider | Send the same stored request again under the same event id |
| Incident | The record matches no stored request | Stop; investigate the authority key; never settle the event again |
| Unresolved | Evidence is missing, unreadable, or the providers disagree | Retry later; escalate if it persists |

In the reference worker these are the outcomes of `resolve`. The event's
status becomes `paid` or `incident`, returns to `pending` for a retry, or
stays `in_flight` while waiting or unresolved, with a note saying why.

## Error codes

| Code | From | Meaning for the decision |
| --- | --- | --- |
| `NAMESPACE_MISMATCH`, `EVENT_MISMATCH`, `AMOUNT_MISMATCH`, `ASSET_MISMATCH`, `SHARES_MISMATCH`, `RECIPIENT_MISMATCH`, `TRANSFER_MISMATCH`, `MEMO_MISMATCH`, `MEMO_MISSING` | reconcile | The evidence contradicts this request (a field mismatch) |
| `CLUSTER_MISMATCH`, `TX_NOT_FOUND`, `TX_FAILED`, `TX_SIGNATURE`, `BLOCK_TIME_MISSING` | reconcile | The endpoint or the transaction cannot be trusted or read: unresolved |
| `PROGRAM_INSTRUCTION`, `INSTRUCTION_DATA`, `ACCOUNT_LAYOUT` | reconcile | The SDK cannot read this transaction (for example a settlement inside another program): unresolved, compare by hand |
| `RECORD_HISTORY` | `findSettlementTransaction` | The creating transaction could not be identified: unresolved |
| `SETTLEMENT_RECORD` | `fetchSettlementRecord` | Something other than this event's record is at the address, which the program cannot produce: treat the endpoint as untrusted |

A duplicate error from sending (`AccountAlreadyInitialized` from the
settlement instruction) is not an outcome by itself: it means the record
exists, so continue at step 3.

## Rebuilding and auditing the ledger

Every ledger row traces to a signature, so the ledger can be checked against
the chain at any time:

1. For each stored settlement, reconcile its signature again against its
   stored request; the rows it produces must equal the stored ones (entry
   ids are deterministic).
2. For each pool wallet, compare the sum of its payout lines with its
   on-chain inflows from settlements, minus the distributions you executed;
   the difference must not be negative (see
   [payout-ledger.md](payout-ledger.md)).
3. For a sample of event ids your backend recorded, `fetchSettlementRecord`
   must return a record exactly when your ledger says the event is paid.

Settlements made with the retired instructions, before namespaces, cannot
be reconciled again by this SDK; see section 6 of
[integration.md](integration.md) for how to decide those.
