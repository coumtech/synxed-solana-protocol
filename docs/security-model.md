# Security model

This document states what the settlement program and the TypeScript client
protect, what they deliberately leave to the integrator, and the known
limitations of the current reference deployment. It covers the code in this
repository at the commit you are reading. Nothing here has been independently
audited, and the reference deployment is devnet only.

Report vulnerabilities privately, as described in [SECURITY.md](../SECURITY.md).

## What is protected

- **Payer funds move only as the split says.** In program mode one
  instruction validates the split and pays every listed recipient, or the
  whole transaction reverts.
- **One settlement per event id.** A settlement record account marks each
  event id as settled; the program refuses a second settlement of it,
  whichever of its three instructions is used.
- **Ledger entries come only from matching chain evidence.** The SDK's
  fetching reconcile functions, `reconcileSettlementN` and
  `reconcileTokenSettlementN`, build ledger entries only from a finalized
  `SettleN` or `SettleTokenN` transaction that succeeded and whose fields and
  inner transfers match the request.

## Actors and what each is trusted with

| Actor | Trusted for | Limits |
| --- | --- | --- |
| Payer (the integrator's settlement key) | Signing and funding settlements; submitting truthful events, amounts, and recipients | The program verifies the split, not the event |
| Attribution layer (off-chain, outside this repository) | Deciding which events are billable and who the beneficiaries are | Not involved on chain |
| Recipients | Nothing; they do not sign | |
| Any other Solana account holder | Nothing | Can call the program with their own funds (known limitation 1) |
| RPC provider | Availability and truthful chain data for submission and reconciliation | Known limitation 5 |
| Program upgrade authority | Everything: it can replace the program | Known limitation 3 |
| Browser wallet (wallet demo) | Holding keys and signing | The demo never receives key material. It writes each reconciled result to local storage (`synxed:settlement-evidence:v1:<signature>`) and never reads it back; the user and any script on the page can edit that copy, so reconcile again before relying on it |

## What the program enforces

Every rule in the table below is checked on chain by
`programs/synxed-settlement`. The last column names the test in
`programs/synxed-settlement/svm-tests/tests` that runs the compiled program
against it; CI runs the suite on every pull request.

| Rule | Failure | Compiled-program test |
| --- | --- | --- |
| 1 to 8 shares | `InvalidInstructionData` | `settle_n.rs`: `rejects_nine_shares_and_zero_shares`; `settle_token_n.rs`: `rejects_invalid_token_share_counts_splits_and_amounts` |
| The shares sum to exactly 10000 bps, which also caps each share (both under and over are rejected) | `InvalidArgument` | `settle.rs`: `rejects_an_invalid_split_before_paying_anyone`; `settle_n.rs`: `rejects_an_invalid_n_way_split`; `settle_token_n.rs`: `rejects_invalid_token_share_counts_splits_and_amounts` |
| Amount greater than zero | `InvalidArgument` | `settle_n.rs`: `rejects_a_zero_amount`; `settle_token_n.rs`: `rejects_invalid_token_share_counts_splits_and_amounts` |
| Integer split: floor per share, remainder to the last share, total always equals the amount; the per-share product is computed in 128 bits, and the release profile keeps overflow checks on | Not reachable by construction | The settlement tests check every payout; `settle_token_n.rs`: `splits_the_largest_token_amount_exactly` settles `u64::MAX`; host tests in `src/split.rs` cover the arithmetic |
| Exact account list: n + 3 accounts for native settlement, n + 6 for token settlement | `NotEnoughAccountKeys` | `settle.rs`: `rejects_extra_trailing_accounts`; `settle_n.rs`: `rejects_a_recipient_count_that_does_not_match_the_shares`; `settle_token_n.rs`: `rejects_a_wrong_token_account_count` |
| The payer signs | `MissingRequiredSignature` | `settle.rs`: `rejects_a_payer_that_did_not_sign` |
| Every native recipient, every token destination, and the record are writable | `InvalidAccountData` | `settle_n.rs`: `rejects_a_read_only_recipient_and_a_wrong_system_program`; `settle_token_n.rs`: `rejects_a_read_only_token_destination`; `settle.rs`: `rejects_a_read_only_record` |
| The system program is the real system program | `IncorrectProgramId` | `settle_n.rs`: `rejects_a_read_only_recipient_and_a_wrong_system_program` |
| The token program is classic SPL Token; Token-2022 and anything else are rejected | `IncorrectProgramId` | `settle_token_n.rs`: `rejects_token_2022_and_any_other_token_program` |
| The record is the PDA `["settlement", event_id]` for this program | `InvalidSeeds` | `settle.rs`: `rejects_a_wrong_record_address` |
| A record this program owns means the event is settled | `AccountAlreadyInitialized` | `settle.rs`: `rejects_settling_the_same_event_twice`; `settle_n.rs`: `shares_idempotency_with_the_three_way_instruction` |
| A data-less account at the record address owned by another program is refused | `InvalidAccountData` | `settle.rs`: `rejects_a_record_address_owned_by_another_program` |
| A pre-funded system account at the record address is topped up to rent exemption instead of blocking the event | Settles normally | `settle.rs`: `survives_a_prefunded_record_address`, `keeps_excess_lamports_on_an_overfunded_record` |
| No payout to this event's record or to any record this program already owns, because nothing could ever withdraw it | `InvalidArgument` (native); `IllegalOwner` (token, from the owner check) | `settle.rs`: `rejects_a_recipient_equal_to_the_record`; `settle_n.rs`: `rejects_the_record_as_any_recipient`, `rejects_another_events_record_as_a_recipient`; `settle_token_n.rs`: `rejects_the_record_as_a_token_destination` |
| Token settlement: the source, the mint, and every destination are owned by the token program | `IllegalOwner` | `settle_token_n.rs`: `rejects_token_accounts_not_owned_by_the_token_program` (each of the three) |
| Token settlement: the mint is initialized and has the stated decimals | `UninitializedAccount` (from the mint decoder), `InvalidAccountData` | `settle_token_n.rs`: `rejects_an_uninitialized_mint`, `rejects_wrong_mint_decimals_and_source_as_recipient` |
| Token settlement: the source holds the mint and its owner is the payer | `InvalidAccountData` | `settle_token_n.rs`: `rejects_a_source_that_holds_another_mint`, `rejects_wrong_destination_mint_and_source_authority` |
| Token settlement: every destination holds the mint and is not the source | `InvalidAccountData`, `InvalidArgument` | `settle_token_n.rs`: `rejects_wrong_destination_mint_and_source_authority`, `rejects_wrong_mint_decimals_and_source_as_recipient` |
| Token transfers use `TransferChecked`, one per nonzero share | Not reached in practice: the program's own mint and decimals checks run first | `settle_token_n.rs`: `uses_transfer_checked_for_every_nonzero_token_payout` (inspects the executed instructions) |

The program also requires the payer and the token source to be writable
(`InvalidAccountData`); those two checks have no dedicated test. Its explicit
`is_initialized` check on the mint and its comparison of token destinations
with the record are unreachable, because the mint decoder and the owner check
reject those cases first.

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
   payer. In native mode the payer may also be a recipient; in token mode the
   SDK refuses the payer's wallet because its associated token account is the
   source, while the program accepts any other token account. Duplicate
   recipients are allowed and receive the sum of their shares. Known
   limitation 1 is a consequence.
4. **Addresses nobody can spend from.** In native mode any writable account
   the program does not already own can receive lamports, including token
   accounts, other programs' accounts, and the record address of an event
   that has not settled yet. Lamports sent to that address can never be
   withdrawn, and become part of its record when the event settles
   (`known_limitations.rs`: `a_payout_to_an_unsettled_events_record_address_is_locked_forever`).
   Pay system-owned wallets whose keys someone holds.
5. **Which mint.** Token settlement accepts any initialized classic SPL Token
   mint with the stated decimals, including one the payer created a moment
   ago. Only token reconciliation pins the mint you expect; keep an allowlist
   of the mints you settle.
6. **Who owns each token destination.** The program checks each
   destination's mint, not its owner. The SDK derives associated token
   accounts for the intended wallets, and token reconciliation checks the
   exact accounts.
7. **The memo.** The program never reads the memo instruction. It is
   payer-authored text with no on-chain meaning, and the SDK's memo carries
   the application event id in clear. Trust a memo only after reconciliation
   has compared it with the instruction.
8. **Freeze authority.** If the mint's freeze authority freezes the source or
   a destination that is owed a nonzero share, the token settlement fails and
   reverts as a whole. Zero-token shares are skipped
   (`settle_token_n.rs`: `a_frozen_destination_fails_the_settlement_only_when_owed_a_share`,
   `a_frozen_source_fails_the_settlement`).

## Known limitations

### 1. Anyone can claim an unsettled event id

The record address depends only on the event id, not on who pays, and all
three instructions share it. Any account holder who learns a 32-byte event id
before it settles can settle it first, to wallets of their choosing,
including their own. The legitimate settlement then fails with
`AccountAlreadyInitialized` and pays nobody. A native claim blocks a planned
token settlement of the same event id, and the reverse.

The record stores only the event id and the amount, so a claimant can make it
byte-identical to a genuine record by copying the amount and paying itself;
the claim costs only the record's rent and a fee. Nothing can be inferred
from record data. `known_limitations.rs` reproduces both against the compiled
program (`any_payer_can_claim_an_unsettled_event_id_first`,
`a_claimed_record_matches_a_genuine_record_byte_for_byte`). The program also
does not check how it was invoked, so a claim can come through another
program's instruction instead of a top-level one.

The event id travels in the instruction data of the pending transaction, so
anyone who sees the transaction before it lands can learn it: the RPC
provider, the block leader, or anyone the transaction is forwarded to. A
transaction that expired without landing has also exposed its event id.

Impact: the claimant pays for the claim; the legitimate payer loses only the
failed transaction's fee. The real risk is an integrator that treats
`AccountAlreadyInitialized` as "already paid": the event would be marked
settled while its beneficiaries received nothing. The opposite mistake is as
bad: settling again when the event was in fact paid by you pays it twice.

Before sending any settlement, persist its request together with its event
id and attempt number, and keep that record permanently. The procedure below
compares chain evidence with it. If you sign the transaction yourself
(`buildSettlementNTransaction`, `buildTokenSettlementNTransaction`), also
persist its signature before sending. The `submit` functions sign and send in
one call and return the signature only once it is confirmed, so persist the
request before calling them and the signature when they return.

On `AccountAlreadyInitialized`, decide only from the transaction that created
the record. Three definitions first. The *payer* of a settlement is the first
account of its settlement instruction, which must sign; it can differ from the
transaction's fee payer. A settlement is *for your event* when the 32 bytes
after its one-byte instruction tag (zero-based offsets 1 to 32) equal the
on-chain event id, which the SDK derives as `sha256` of your application event
id (`eventIdSeed`). Reconciliation *reports a mismatch* when it fails with
`EVENT_MISMATCH`, `AMOUNT_MISMATCH`, `ASSET_MISMATCH`, `SHARES_MISMATCH`,
`RECIPIENT_MISMATCH`, `TRANSFER_MISMATCH`, `MEMO_MISMATCH`, or
`MEMO_MISSING`. Every other reconciliation error, `CLUSTER_MISMATCH`
included, means the SDK could not compare the transaction: compare it by hand
as described after step 5, and until then the case is unresolved (step 5).

1. List the record address's transactions with `getSignaturesForAddress`,
   paging until the end, from an endpoint that keeps full transaction history
   (check `getFirstAvailableBlock`). The call returns every transaction that
   referenced the address, newest first, including failed attempts (your own
   retry among them) and plain transfers. A history that ends before the
   record existed is case 5.
2. The creating transaction is the one successful transaction (`err` is null)
   that ran this program's `Settle`, `SettleN`, or `SettleTokenN` for your
   event, either as a top-level instruction or as an inner instruction invoked
   by another program (look in `meta.innerInstructions`). At most one exists,
   because any later settlement of the event fails. Confirm it with a second
   RPC provider before acting on step 3 or 4: it must return the same
   signature, finalized and successful, with the same instruction data and
   payer. If it returns a different transaction, none, or an error, the case
   is unresolved (step 5).
3. If its payer is any key you control or have ever controlled (keep the list
   across key rotations, key pools, fee payers, and treasury keys, and include
   any program-derived address that signs for you, such as a multisig vault),
   reconcile the transaction against the stored request for that attempt. If
   it matches, the event is paid: never settle it again. If no stored request
   matches, or reconciliation reports a mismatch, do not mark the event paid
   and do not settle it again: raise an incident alert, because it means a
   bug or a compromised key.
4. If its payer is a key you have never controlled, reconcile it against your
   stored request anyway. If it matches, someone else paid your recipients
   exactly and the event is paid; raise an alert all the same, because an
   exact copy means someone is reading your pending transactions. If
   reconciliation reports a mismatch, the event id was claimed. Move the event
   to a new id only by compare-and-set: replace the claimed id only if it is
   still the current id for your internal event. Derive every replacement id
   deterministically from values you store, for example the HMAC under your
   secret of your internal event id and the claimed id's stored attempt number
   plus one, where an id stored without an attempt number (random or from an
   older scheme) counts as attempt 0. Never use a fresh random id as a
   replacement: concurrent runs must pick the same id, so that the program
   rejects the second. A run that finds a newer current id stops and resumes
   with it. Then settle under the new id and raise an alert.
5. Anything else is unresolved: the creating transaction is not finalized
   yet, cannot be found, or the RPC fails, including a lookup or finality
   error from reconciliation. Retry the lookup later, never settle under a new
   event id while it is unresolved, and escalate to a person if it stays
   unresolved.

The SDK's fetching reconcile functions read a transaction with exactly one
top-level `SettleN` or `SettleTokenN` instruction. Compare by hand a
three-way `Settle`, a transaction with several instructions for this program,
or a settlement made through another program. `Settle` and `SettleN` can only
match a native request; `SettleTokenN` must match your mint, decimals, and
recipient token accounts. For a settlement made through another program, read
its stack height and resolve its account indexes against the transaction's
static keys, then `meta.loadedAddresses.writable`, then
`meta.loadedAddresses.readonly`, or request the `jsonParsed` encoding.

Also use event ids nobody can guess. Derive the application event id from a
secret, for example the HMAC of your internal event id and attempt number
above, or use a random 128-bit id for the first attempt only. The memo
of every settlement publishes its application event id, so a guessable scheme
is exposed by the first settlement. This stops guessing and enumeration; it
does not stop an observer of the pending transaction, so prefer a private or
trusted submission path (your own RPC node or a provider you trust).

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
chain and there is no settlement record, so there is no idempotency: a retry
with a fresh blockhash pays again. The fallback exists so a fresh clone can
produce a real devnet transaction; use program mode for anything else.

### 5. Reconciliation trusts the RPC endpoint

Reconciliation checks the endpoint's genesis hash against the expected
cluster, waits for finalized commitment, requires the transaction to have
succeeded, and compares every field and inner transfer. It does not verify
transaction signatures or prove that a transaction is in a block, and for
versioned transactions it relies on the endpoint to resolve accounts loaded
from address lookup tables. A dishonest RPC endpoint could return fabricated
data. Reconcile against an endpoint you operate or trust, and cross-check
with a second provider when the amounts matter.

### 6. One failing recipient fails the whole settlement

Atomicity cuts both ways: if any single share cannot be paid, nobody is paid.
In native mode a share smaller than the rent-exempt minimum sent to a
brand-new account fails with `InsufficientFundsForRent` (that minimum was
0.00065024 SOL on devnet on 20 October 2026). In token mode a destination that
is missing, closed, or frozen fails the settlement. Check recipients before
settling, keep shares above the rent-exempt minimum, and drop or replace a
recipient that keeps failing.

### 7. Token settlements that create accounts fit six shares with a short memo, seven only with a near-empty one

By default `buildTokenSettlementNTransaction` creates missing recipient token
accounts in the same transaction. Each share then costs 77 bytes, and the
SDK's memo grows with the event id and `request.memo`, against Solana's
1,232-byte transaction limit. Measured with the SDK on 21 October 2026, signed
by one key, with the `SPL_STABLECOIN` asset label and a 44-character mint
address, in bytes:

| Event id and memo | 6 shares | 7 shares | 8 shares |
| --- | --- | --- | --- |
| One character, empty memo | 1,145 | 1,222 | too large |
| `evt_token_settlement`, `audio ad impression` | 1,183 | too large | too large |
| `evt_` and a UUID, same memo | 1,203 | too large | too large |
| A 64-character id, same memo | 1,227 | too large | too large |

The memo is JSON that carries the event id and `request.memo`, so what
counts is their combined length. With plain ASCII text, six shares fit while
the two together stay within 88 characters, and seven only while they stay
within 11 (1,232 bytes, the limit, with an 11-character id and an empty
memo). A 64-character id with a 30-character memo is already too large for
six shares (1,238 bytes). The `USDC` label is 10 bytes shorter than
`SPL_STABLECOIN`, a 43-character mint address is 1 byte shorter, and quotes,
backslashes, and non-ASCII characters take more than one byte each. The table
uses a 20,000 base-unit amount; every further digit of the amount, a longer
`occurredAt` string, and any extra instruction, such as a priority fee, use
the same margin. Without account
creation each share costs 35 bytes, and eight shares fit in the same cases
(931 to 1,013 bytes). web3.js refuses to serialize an oversized transaction,
so nothing is sent. For seven or eight token shares, or a long event id or
memo, create the recipient token accounts in a separate transaction first and
build the settlement with `createRecipientAccounts: false`.

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

- Changes land through pull requests with required `ci` and `program`
  checks and one approving code-owner review. Administrators can bypass
  branch protection; the adversarial review
  before every merge is a process rule ([CONTRIBUTING.md](../CONTRIBUTING.md)),
  not a GitHub setting.
- GitHub Actions are pinned to full commit SHAs; Dependabot proposes updates.
- Secret scanning with push protection and private vulnerability reporting
  are enabled.
- JavaScript dependencies install from the committed lockfile
  (`bun install --frozen-lockfile`) in CI and in the hosted demo build.
- Program builds are reproducible in a pinned container, and the deployment
  is compared with `main` after every push to `main` and daily.

## Before mainnet: audit scope

An independent audit should cover at least:

1. Instruction decoding and every account check in the processor, including
   the namespaced record that fixes known limitation 1 and payouts to
   addresses nobody can spend from.
2. The token path: `TransferChecked`, the classic SPL Token restriction, mint
   allowlisting, and an explicit Token-2022 policy.
3. Upgrade authority: multisig, timelock, or immutability.
4. The TypeScript client's transaction construction, including transaction
   size limits, and reconciliation, including RPC trust.
5. Key management and operational runbooks for the payer, including the
   duplicate-event procedure above.
6. The economics of record rent and fees at the expected settlement volume.
