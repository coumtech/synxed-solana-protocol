# Security model

This document states what the settlement program and the TypeScript client
protect, what they deliberately leave to the integrator, and the known
limitations of the current reference deployment. It covers the code in this
repository at the commit you are reading. Nothing here has been independently
audited, and the reference deployment is devnet only.

Report vulnerabilities privately, as described in [SECURITY.md](../SECURITY.md).

## What is protected

- **Payer funds move only as the split says.** One instruction validates the
  split and pays every listed recipient, or the whole transaction reverts.
- **One settlement per event id.** A settlement record account marks each
  event id as settled; the program refuses a second settlement of it.
- **Ledger entries come only from matching chain evidence.** The SDK's
  reconciliation writes a ledger entry only after the transaction is
  finalized and every instruction field and inner transfer matches the
  request.

## Actors and what each is trusted with

| Actor | Trusted for | Not trusted for |
| --- | --- | --- |
| Payer (the integrator's settlement key) | Signing and funding settlements; submitting truthful events, amounts, and recipients | Nothing else: the program verifies the split, not the event |
| Attribution layer (off-chain, outside this repository) | Deciding which events are billable and who the beneficiaries are | Not involved on chain |
| Recipients | Nothing; they do not sign | |
| Any other Solana account holder | Nothing | Can call the program with their own funds (see known limitation 1) |
| RPC provider | Availability and truthful chain data for submission and reconciliation | See known limitation 5 |
| Program upgrade authority | Everything: it can replace the program | See known limitation 3 |
| Browser wallet (wallet demo) | Holding keys and signing | The demo never receives key material |

## What the program enforces

Every rule below is checked on chain by `programs/synxed-settlement`. The
last column names the test in `programs/synxed-settlement/svm-tests/tests`
that runs the compiled program against it; CI runs the suite on every pull
request.

| Rule | Failure | Compiled-program test |
| --- | --- | --- |
| 1 to 8 shares | `InvalidInstructionData` | `settle_n.rs`: `rejects_nine_shares_and_zero_shares` |
| Each share at most 10000 bps and the shares sum to exactly 10000 | `InvalidArgument` | `settle.rs`: `rejects_an_invalid_split_before_paying_anyone`; `settle_n.rs`: `rejects_an_invalid_n_way_split` |
| Amount greater than zero | `InvalidArgument` | `settle_n.rs`: `rejects_a_zero_amount_before_paying_anyone` |
| Integer split: floor per share, remainder to the last share, total always equals the amount | Not reachable by construction | `settle.rs` and `settle_n.rs` settlement tests check every payout; host tests in `src/split.rs` cover the arithmetic over a range of amounts up to `u64::MAX`, which uses 128-bit intermediates in a release profile that keeps overflow checks |
| Exact account list: n + 3 accounts for native settlement, n + 6 for token settlement | `NotEnoughAccountKeys` | `settle.rs`: `rejects_extra_trailing_accounts`; `settle_n.rs`: `rejects_a_recipient_count_that_does_not_match_the_shares` |
| The payer signs | `MissingRequiredSignature` | `settle.rs`: `rejects_a_payer_that_did_not_sign` |
| Every recipient and the record are writable | `InvalidAccountData` | `settle_n.rs`: `rejects_a_read_only_recipient_and_a_wrong_system_program`; `settle.rs`: `rejects_a_read_only_record` |
| The system program is the real system program | `IncorrectProgramId` | `settle_n.rs`: `rejects_a_read_only_recipient_and_a_wrong_system_program` |
| The token program is classic SPL Token; Token-2022 and anything else are rejected | `IncorrectProgramId` | `settle_token_n.rs`: `rejects_token_2022_and_any_other_token_program` |
| The record is the PDA `["settlement", event_id]` for this program | `InvalidSeeds` | `settle.rs`: `rejects_a_wrong_record_address` |
| A record this program owns, or any account with data at the record address, means the event is settled | `AccountAlreadyInitialized` | `settle.rs`: `rejects_settling_the_same_event_twice`; `settle_n.rs`: `shares_idempotency_with_the_three_way_instruction` |
| A data-less account at the record address owned by another program is refused | `InvalidAccountData` | `settle.rs`: `rejects_a_record_address_owned_by_another_program` |
| A pre-funded system account at the record address is topped up to rent exemption instead of blocking the event | Settles normally | `settle.rs`: `survives_a_prefunded_record_address`, `keeps_excess_lamports_on_an_overfunded_record` |
| No payout to a settlement record, of this event or any other, because nothing could ever withdraw it | `InvalidArgument` | `settle.rs`: `rejects_a_recipient_equal_to_the_record`; `settle_n.rs`: `rejects_the_record_as_any_recipient`, `rejects_another_events_record_as_a_recipient` |
| Token settlement: the source, the mint, and every destination are owned by the token program | `IllegalOwner` | `settle_token_n.rs`: `rejects_token_accounts_not_owned_by_the_token_program` |
| Token settlement: the mint is initialized and has the stated decimals | `UninitializedAccount`, `InvalidAccountData` | `settle_token_n.rs`: `rejects_an_uninitialized_mint`, `rejects_wrong_mint_decimals_and_source_as_recipient` |
| Token settlement: the source holds the mint and its owner is the payer | `InvalidAccountData` | `settle_token_n.rs`: `rejects_a_source_that_holds_another_mint`, `rejects_wrong_destination_mint_and_source_authority` |
| Token settlement: every destination holds the mint and is not the source | `InvalidAccountData`, `InvalidArgument` | `settle_token_n.rs`: `rejects_wrong_destination_mint_and_source_authority`, `rejects_wrong_mint_decimals_and_source_as_recipient` |
| Token settlement uses `TransferChecked`, so the token program re-checks mint and decimals on every transfer | Reverts the whole settlement | `settle_token_n.rs`: `settles_four_way_token_split_and_writes_shared_record` |

The [protocol specification](protocol.md) gives the byte layouts and the
complete error table.

## What the program does not check

These are the integrator's responsibility. The SDK helps with some of them,
as noted.

1. **Event authenticity and amounts.** The program proves that a split was
   paid, not that an impression happened. The attribution layer decides what
   is billable before anything is signed.
2. **Recipient correctness.** The program pays whichever writable accounts
   the instruction lists. A wrong address is a lost payout. Resolve
   recipients from your own beneficiary registry; reconciliation then checks
   the chain against the request you built.
3. **Who may settle.** The program is permissionless: any signer can be the
   payer. Known limitation 1 is a consequence.
4. **Recipient account types in native mode.** Any writable account the
   program does not own can receive lamports, including token accounts and
   other programs' accounts, whose owners may not be able to spend them as
   SOL. Pay system-owned wallet addresses.
5. **Who owns each token destination.** The program checks each
   destination's mint, not its owner. The SDK derives associated token
   accounts for the intended wallets, and token reconciliation checks the
   exact accounts.
6. **Freeze authority.** If the mint's freeze authority freezes the source or
   a destination token account, the token settlement fails and reverts as a
   whole. Nothing is paid partially.

## Known limitations

### 1. Anyone can claim an unsettled event id

The record address depends only on the event id, not on who pays. Any account
holder who learns a 32-byte event id before it settles can settle it first,
with the smallest valid amount, to wallets of their choosing. The legitimate
settlement then fails with `AccountAlreadyInitialized` and pays nobody.
`any_payer_can_claim_an_unsettled_event_id_first` in
`programs/synxed-settlement/svm-tests/tests/event_namespace.rs` reproduces
this against the compiled program.

The event id travels in the instruction data of the pending transaction, so
anyone who sees the transaction before it lands can learn it: the RPC
provider, the block leader, or anyone the transaction is forwarded to. A
transaction that expired without landing has also exposed its event id.

Impact: no funds are taken from the payer, and the claimant pays for the
record. The real risk is an integrator that treats `AccountAlreadyInitialized`
as "already paid": the event would be marked settled while its beneficiaries
received nothing.

Mitigations available now:

- **Never treat a duplicate as success without evidence.** On
  `AccountAlreadyInitialized`, find the transaction that created the record
  (`getSignaturesForAddress` on the record address returns it) and reconcile
  it against your request. If it does not match, the event id was claimed by
  someone else: settle again under a new event id, keep the mapping from your
  internal event to every on-chain event id you tried, and treat the
  incident as an alert.
- **Use event ids nobody can guess.** Derive the application event id from a
  secret, for example an HMAC of your internal event id, or use a random
  128-bit id. This stops guessing and enumeration. It does not stop an
  observer of the pending transaction.
- **Prefer a private or trusted submission path** (your own RPC node or a
  provider you trust) to narrow who sees transactions before they land.

Planned fix, before any mainnet deployment: bind each record to an integrator
namespace whose authority must sign, for example a record derived from
`["settlement", namespace, event_id]`, so that only the namespace's own
transactions can claim its event ids and rotating the authority key does not
reset idempotency.

### 2. Records are permanent and cost rent per settlement

Every settlement creates a 41-byte record that is never closed, so its
rent-exempt balance stays locked (0.00085852 SOL on devnet on
20 October 2026). That is comparable to, or larger than, the value of a
single audio-ad impression. Settle aggregated amounts, for example one
settlement per beneficiary set per period, rather than one per impression.
Closing records would let an event be settled again, so the program does not
offer it.

### 3. The program is upgradeable by a single key

The reference deployment's upgrade authority is the maintainers' devnet payer
key, a single hot key. Whoever holds it can replace the program. Verified
builds let anyone confirm that the deployed bytes match `main`
([verified-build.md](verified-build.md)), and CI repeats the comparison daily,
but that detects a change after the fact; it does not prevent one. Deploy
your own copy of the program if you need to control upgrades. A mainnet
deployment needs a multisig or timelocked authority, or an immutable program.

### 4. The system-transfer fallback has no on-chain guarantees

Without a program id the client sends plain system transfers plus a memo. The
amounts come from the same split function, but nothing re-validates them on
chain and there is no settlement record, so there is no idempotency. The
fallback exists so a fresh clone can produce a real devnet transaction; use
program mode for anything else.

### 5. Reconciliation trusts the RPC endpoint

Reconciliation checks the endpoint's genesis hash against the expected
cluster, waits for finalized commitment, and compares every field and inner
transfer. It does not verify transaction signatures or prove that a
transaction is in a block, so a dishonest RPC endpoint could return
fabricated data. Reconcile against an endpoint you operate or trust, and
cross-check with a second provider when the amounts matter.

## Operating a payer key

- The payer key signs every settlement and is necessarily online. Keep its
  balance to what the next settlements need, keep it separate from treasury
  funds and from any program upgrade authority, and store it in a secret
  manager, never in a repository (`.env` and `.keys/` are gitignored here).
- Settle in program mode, reconcile every settlement at finalized
  commitment, and alert on any reconciliation mismatch or unexplained
  `AccountAlreadyInitialized`.
- Rotate the key if it was ever pasted into chat, logs, CI output, or a pull
  request.

## Repository and supply chain controls

- `main` is protected: pull requests, required `ci` and `program` checks, and
  an adversarial review before every merge ([CONTRIBUTING.md](../CONTRIBUTING.md)).
- GitHub Actions are pinned to full commit SHAs; Dependabot proposes updates.
- Secret scanning with push protection and private vulnerability reporting
  are enabled.
- JavaScript dependencies install from the committed lockfile
  (`bun install --frozen-lockfile`) in CI and in the hosted demo build.
- Program builds are reproducible in a pinned container, and the deployment
  is compared with `main` after every push and daily.

## Before mainnet: audit scope

An independent audit should cover at least:

1. Instruction decoding and every account check in the processor, including
   the namespaced record that fixes known limitation 1.
2. The token path: `TransferChecked`, the classic SPL Token restriction, and
   an explicit Token-2022 policy.
3. Upgrade authority: multisig, timelock, or immutability.
4. The TypeScript client's transaction construction and reconciliation,
   including RPC trust.
5. Key management and operational runbooks for the payer.
6. The economics of record rent and fees at the expected settlement volume.
