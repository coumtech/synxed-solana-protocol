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
- **Only you settle your events.** Every settlement runs in a namespace, and
  only the namespace's current authority can settle in it. Nobody else can
  settle one of its event ids first.
- **One settlement per event id in a namespace.** A settlement record
  account, derived from the namespace and the event id, marks the event as
  settled; the program refuses a second settlement of it, native or token.
- **Ledger entries come only from matching chain evidence.** The SDK's
  fetching reconcile functions, `reconcileSettlementN` and
  `reconcileTokenSettlementN`, build ledger entries only from a finalized
  `SettleN` or `SettleTokenN` transaction that succeeded and whose fields and
  inner transfers match the request.

## Actors and what each is trusted with

| Actor | Trusted for | Limits |
| --- | --- | --- |
| Payer (the integrator's settlement key) | Signing and funding settlements; submitting truthful events, amounts, and recipients | The program verifies the split, not the event |
| Namespace authority (the payer by default) | Deciding which settlements happen in the namespace; rotating itself | Known limitation 1 |
| Attribution layer (off-chain, outside this repository) | Deciding which events are billable and who the beneficiaries are | Not involved on chain |
| Recipients | Nothing; they do not sign | |
| Any other Solana account holder | Nothing | Can open its own namespace and settle in it with its own funds; cannot settle in yours |
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
| Retired instructions (tags 0, 1, 2) are refused | `InvalidInstructionData` | `namespace.rs`: `refuses_the_retired_instructions` |
| The namespace authority signs every settlement and every rotation | `MissingRequiredSignature` | `namespace.rs`: `outsiders_cannot_settle_in_a_namespace_they_do_not_control`, `a_separate_authority_must_sign_alongside_the_payer`, `token_settlements_need_the_namespace_authority`, `only_the_current_authority_can_rotate` |
| The namespace account is owned by this program and has the namespace size and type byte | `IllegalOwner`, `InvalidAccountData` | `namespace.rs`: `rejects_an_account_that_is_not_a_namespace`, `rejects_program_owned_accounts_without_the_namespace_layout` |
| The signer is the namespace's current authority | `IncorrectAuthority` | `namespace.rs`: `outsiders_cannot_settle_in_a_namespace_they_do_not_control`, `token_settlements_need_the_namespace_authority`, `rotation_moves_the_right_to_settle_and_keeps_idempotency`, `only_the_current_authority_can_rotate` |
| A namespace is opened once, at `["namespace", creator, namespace_id]`, signed by its creator, with an authority other than the all-zero key (also on rotation) | `AccountAlreadyInitialized`, `InvalidSeeds`, `MissingRequiredSignature`, `InvalidArgument` | `namespace.rs`: `rejects_opening_the_same_namespace_twice`, `rejects_a_namespace_at_the_wrong_address`, `rejects_a_creator_that_did_not_sign`, `rejects_the_all_zero_key_as_authority` |
| A pre-funded namespace address is topped up; one owned by another program is refused | Opens normally; `InvalidAccountData` | `namespace.rs`: `survives_a_prefunded_namespace_address`, `rejects_a_namespace_address_owned_by_another_program` |
| A rotation needs a writable namespace and keeps every existing record | `InvalidAccountData` | `namespace.rs`: `only_the_current_authority_can_rotate`, `rotation_moves_the_right_to_settle_and_keeps_idempotency` |
| Exact account list: n + 5 accounts for native settlement, n + 8 for token settlement | `NotEnoughAccountKeys` | `settle.rs`: `rejects_extra_trailing_accounts`; `settle_n.rs`: `rejects_a_recipient_count_that_does_not_match_the_shares`; `settle_token_n.rs`: `rejects_a_wrong_token_account_count` |
| The payer signs | `MissingRequiredSignature` | `settle.rs`: `rejects_a_payer_that_did_not_sign` |
| Every native recipient, every token destination, and the record are writable | `InvalidAccountData` | `settle_n.rs`: `rejects_a_read_only_recipient_and_a_wrong_system_program`; `settle_token_n.rs`: `rejects_a_read_only_token_destination`; `settle.rs`: `rejects_a_read_only_record` |
| The system program is the real system program | `IncorrectProgramId` | `settle_n.rs`: `rejects_a_read_only_recipient_and_a_wrong_system_program` |
| The token program is classic SPL Token; Token-2022 and anything else are rejected | `IncorrectProgramId` | `settle_token_n.rs`: `rejects_token_2022_and_any_other_token_program` |
| The record is the PDA `["settlement", namespace, event_id]` for this program, so one namespace's authority cannot create another namespace's record | `InvalidSeeds` | `settle.rs`: `rejects_a_wrong_record_address`; `namespace.rs`: `an_outsider_cannot_create_another_namespaces_record` |
| A record this program owns means the event is settled in that namespace; the same event id in another namespace is unaffected | `AccountAlreadyInitialized` | `settle.rs`: `rejects_settling_the_same_event_twice`; `settle_n.rs`: `three_and_four_way_settlements_share_one_record`; `namespace.rs`: `the_same_event_id_settles_independently_in_two_namespaces` |
| A data-less account at the record address owned by another program is refused | `InvalidAccountData` | `settle.rs`: `rejects_a_record_address_owned_by_another_program` |
| A pre-funded system account at the record address is topped up to rent exemption instead of blocking the event | Settles normally | `settle.rs`: `survives_a_prefunded_record_address`, `keeps_excess_lamports_on_an_overfunded_record` |
| No payout to this event's record or to any account this program already owns (another record, or a namespace), because nothing could ever withdraw it | `InvalidArgument` (native); `IllegalOwner` (token, from the owner check) | `settle.rs`: `rejects_a_recipient_equal_to_the_record`; `settle_n.rs`: `rejects_the_record_as_any_recipient`, `rejects_another_events_record_as_a_recipient`; `namespace.rs`: `rejects_the_namespace_as_a_recipient`; `settle_token_n.rs`: `rejects_the_record_as_a_token_destination` |
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
3. **Who pays.** The namespace authority must sign, but the payer can be
   any key that signs with it. Anyone can open namespaces of their own. In
   native mode the payer may also be a recipient; in token mode the SDK
   refuses the payer's wallet because its associated token account is the
   source, while the program accepts any other token account. Duplicate
   recipients are allowed and receive the sum of their shares.
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

### 1. Whoever holds the namespace authority key can settle your events

The original program derived the settlement record from the event id alone,
so anyone who learned an unsettled event id could settle it first and block
the real settlement. Every settlement now runs in a namespace, and its record
is derived from the namespace and the event id. Only the namespace's current
authority can settle in it, so an outsider can neither claim one of your
event ids nor create one of your records
(`namespace.rs`: `outsiders_cannot_settle_in_a_namespace_they_do_not_control`,
`an_outsider_cannot_create_another_namespaces_record`,
`the_same_event_id_settles_independently_in_two_namespaces`). The original
instructions are refused (`refuses_the_retired_instructions`). Event ids no
longer need to be secret for this; the memo still publishes them.

What remains is the authority key itself. Anyone who holds it can settle
your unsettled event ids, to wallets of their choosing and with any payer
that signs alongside it, and can rotate the namespace to a key you do not
hold. Keep the authority key at least as well protected as the payer key.
A separate authority (a hardware or multisig key) means a stolen payer key
alone cannot settle in the namespace; it adds the authority's key and
signature to every transaction (96 bytes). Rotate with
`SetNamespaceAuthority` while you still hold the key; rotation keeps every
record, so settled events stay settled
(`rotation_moves_the_right_to_settle_and_keeps_idempotency`).

Before sending any settlement, persist its request together with its event
id, its attempt number, and the parameters you built it with (program id,
namespace, scale, and for tokens the mint and decimals), and keep that record
permanently. A retry under the same event id resends that stored request
unchanged. If you sign the transaction separately from sending it
(`buildSettlementNTransaction`, `buildTokenSettlementNTransaction`), also
persist its signature before sending. The `submit` functions, like a wallet's
`sendTransaction`, sign and send in one call and return the signature only
afterwards, so persist the request before calling them and the signature when
they return.

`AccountAlreadyInitialized` now means that your namespace's authority settled
the event before: usually your own earlier attempt that landed after you
treated it as failed. Decide from the transaction that created the record:

1. List the record address's transactions with `getSignaturesForAddress`,
   paging until the end, from an endpoint that keeps full transaction history
   (check `getFirstAvailableBlock`) and whose genesis hash identifies the
   expected cluster (`assertLedgerCluster`). The creating transaction is the
   one that succeeded (`err` is null) and ran this program's `SettleN` or
   `SettleTokenN` for your event: the 32 bytes after the instruction's
   one-byte tag equal the on-chain event id (`eventIdSeed`), and its namespace
   account is yours. At most one exists. Confirm it with a second provider:
   same signature, finalized and successful, with the same instruction data
   and accounts.
2. Reconcile it against the stored request for that attempt, with the stored
   parameters and without `beneficiaryIds`, which only label ledger rows
   (`reconcileSettlementN`, `reconcileTokenSettlementN`), on both providers'
   copies. If both match, the event is paid: never settle it again.
3. If it fails with a field mismatch (`NAMESPACE_MISMATCH`, `EVENT_MISMATCH`,
   `AMOUNT_MISMATCH`, `ASSET_MISMATCH`, `SHARES_MISMATCH`,
   `RECIPIENT_MISMATCH`, `TRANSFER_MISMATCH`, `MEMO_MISMATCH`,
   `MEMO_MISSING`) on both providers' copies, or no stored request matches,
   do not mark the event paid and do not settle it again: raise an incident,
   because your authority key or your own system settled something you did
   not record. Rotate the authority if the key may be exposed.
4. Anything else is unresolved: the transaction is not finalized or cannot be
   found, the two providers disagree, an endpoint fails (`CLUSTER_MISMATCH`,
   `TX_NOT_FOUND`, `TX_FAILED`, `TX_SIGNATURE`, `BLOCK_TIME_MISSING`, errors
   from the RPC call itself), or the SDK cannot read the transaction or the
   stored request (`PROGRAM_INSTRUCTION`, `INSTRUCTION_DATA`,
   `ACCOUNT_LAYOUT`, any other error, a settlement made through another
   program, which you compare by hand).
   Retry later and escalate to a person if it stays unresolved.

The SDK's fetching reconcile functions read a transaction with exactly one
top-level `SettleN` or `SettleTokenN` instruction, alongside at most the
`CreateNamespace` a wallet's first settlement carries. For a settlement made
through another program, read its stack height and resolve its account
indexes against the transaction's static keys, then
`meta.loadedAddresses.writable`, then `meta.loadedAddresses.readonly`, or
request the `jsonParsed` encoding.

Records created by the retired instructions stay on chain at their old
addresses (`["settlement", event_id]`), and the SDK no longer reads those
transactions (`tests/ledger.test.ts`: refuses a settlement made with a
retired instruction). A namespaced settlement does not see them, so after the
program is upgraded in place, an event that was settled before the upgrade
could be settled a second time. Before retrying any event first attempted
before the upgrade, check its old record address
(`findLegacySettlementRecordPda`); if an account exists there, the event is
paid. Events first attempted after the upgrade need no such check.

### 2. Records are permanent and cost rent per settlement

Every settlement creates a 41-byte record that is never closed, so its
rent-exempt balance stays locked (0.00085852 SOL on devnet on
20 October 2026). That is comparable to, or larger than, the value of a
single audio-ad impression. Settle aggregated amounts, for example one
settlement per beneficiary set per period, rather than one per impression.
Closing records would let an event be settled again, so the program does not
offer it. Opening a namespace also locks rent, for 98 bytes, once
(0.00114808 SOL on devnet on 21 October 2026).

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

### 7. Token settlements that create accounts fit five shares, six with a short event id and memo

By default `buildTokenSettlementNTransaction` creates missing recipient token
accounts in the same transaction. Each share then costs 77 bytes, and the
SDK's memo grows with the event id and `request.memo`, against Solana's
1,232-byte transaction limit. Measured with the SDK on 21 October 2026, signed
by one key that is both payer and namespace authority, with the
`SPL_STABLECOIN` asset label, a 44-character mint address, 6 decimals, and a
24-character `occurredAt` (`toISOString()`), in bytes:

| Event id and memo | 5 shares | 6 shares | 7 shares |
| --- | --- | --- | --- |
| One character, empty memo | 1,102 | 1,179 | too large |
| `evt_token_settlement`, `audio ad impression` | 1,140 | 1,217 | too large |
| `evt_` and a UUID, same memo | 1,160 | too large | too large |
| A 64-character id, same memo | 1,184 | too large | too large |

The memo is JSON that carries the event id and `request.memo`, so what
counts is their combined length. With plain ASCII text, six shares fit while
the two together stay within 54 characters, and five while they stay within
131; seven never fit. The `USDC` label is 10 bytes shorter than
`SPL_STABLECOIN`, a 43-character mint address is 1 byte shorter, and quotes,
backslashes, control characters, and non-ASCII characters take more than one
byte each. The table uses a 20,000 base-unit amount; every further digit of
the amount or of the decimals, every character of `occurredAt` beyond 24, a
separate namespace authority (96 bytes), and any extra instruction, such as
a priority fee, use the same margin. Without account creation each share
costs 35 bytes, and eight shares fit in the same cases (965 to 1,047 bytes).
web3.js refuses to serialize an oversized transaction, so nothing is sent.
For more token shares, or a long event id or memo, create the recipient token
accounts in a separate transaction first and build the settlement with
`createRecipientAccounts: false`. Native settlements fit eight shares in all
four cases (804 to 886 bytes, or 876 to 958 when the transaction also opens
the namespace).

## Operating a payer key

- The payer key signs every settlement and is necessarily online. Keep its
  balance to what the next settlements need, keep it separate from treasury
  funds and from any program upgrade authority, and store it in a secret
  manager, never in a repository (`.env` and `.keys/` are gitignored here).
- Settle in program mode, reconcile every settlement at finalized
  commitment, and alert on any reconciliation mismatch or unexplained
  `AccountAlreadyInitialized`.
- The namespace authority decides what is settled in your namespace. Protect
  it at least as well as the payer, prefer a separate hardware or multisig
  authority for production, and rotate it with `SetNamespaceAuthority` if it
  may be exposed.
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
   the namespace and authority checks, the namespaced record, and payouts to
   addresses nobody can spend from.
2. The token path: `TransferChecked`, the classic SPL Token restriction, mint
   allowlisting, and an explicit Token-2022 policy.
3. Upgrade authority: multisig, timelock, or immutability.
4. The TypeScript client's transaction construction, including transaction
   size limits, and reconciliation, including RPC trust.
5. Key management and operational runbooks for the payer and the namespace
   authority, including the duplicate-event procedure above.
6. The economics of record rent and fees at the expected settlement volume.
