# Protocol specification

## Overview

The SYNXED settlement protocol settles a single revenue event (for example
an in-game audio-ad impression) into a deterministic payout across
configured shares (three by default, up to eight):

```
gross amount -> [artist, studio, synxed]
gross amount -> [artist, studio, synxed, rewards_pool, ...]
```

Each settlement runs inside the integrator's settlement namespace, so only
that integrator can settle its event ids (see Settlement namespaces).

Shares are expressed in **basis points** (bps). `10000` bps = 100%.

## Split math

Given `amount` (a positive integer of atomic units) and `n` shares
`[bps_0, ..., bps_n-1]` with `1 <= n <= 8`:

1. Every share must be an integer in `0..=10000`.
2. The shares must sum to exactly `10000`. Anything else is rejected,
   never renormalized.
3. `amount` must be greater than zero.
4. The first `n - 1` payouts are floor divisions:
   `payout_i = floor(amount * bps_i / 10000)`.
5. The last payout is the remainder: `amount - sum(payout_0..payout_n-2)`.

Property (conservation): the payouts always sum to `amount` exactly. No
atomic unit is created or destroyed by rounding; any rounding dust lands in
the last share (the platform share in the three-way form, whatever is
configured last in `SettleN`), and that behavior is deliberate and
documented rather than hidden.

The same algorithm is implemented twice and kept in lockstep:

- Rust: `programs/synxed-settlement/src/split.rs` (`split_shares`, with
  `split_three` as the three-way wrapper)
- TypeScript: `sdk/typescript/src/split.ts` (`splitAmountAtomicShares`,
  with `splitAmountAtomic` as the three-way wrapper)

`tests/instruction-n.test.ts`, `tests/token-settlement.test.ts`, and
`tests/namespace.test.ts` pin the shared byte layouts against golden vectors
also asserted in the Rust codec tests, and both languages carry conservation
and rejection tests.

## Default configuration

| Parameter | Value | Meaning |
| --- | --- | --- |
| `amount` | `20000` | $0.020 at 6 decimals (micro-dollars) |
| `artist_bps` | `3500` | 35% -> $0.007 |
| `studio_bps` | `4000` | 40% -> $0.008 |
| `synxed_bps` | `2500` | 25% -> $0.005 |

All four are configurable per settlement; the percentages above are
placeholders, not contractual rates.

## Settlement namespaces

Every settlement happens inside a namespace. A namespace belongs to one
integrator: its current authority is the only key that can settle in it, and
every settlement record is derived from the namespace's address and the event
id. Nobody outside a namespace can create one of its records, so nobody can
settle one of its event ids first and block the real settlement.

A namespace is a program account at the PDA

```
seeds = ["namespace", creator, namespace_id]
```

where `creator` is the key that signed `CreateNamespace` and `namespace_id`
is any 32 bytes the creator chooses (`namespaceIdFromLabel` in the SDK hashes
a readable label). The creator is part of the address, so nobody else can
open the same namespace first. Its data (98 bytes):

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | discriminator (`2`) |
| 1 | 1 | PDA bump |
| 2 | 32 | creator |
| 34 | 32 | `namespace_id` |
| 66 | 32 | current authority |

### `CreateNamespace` (tag 3)

Instruction data (65 bytes): tag `3`, `namespace_id` (`[u8; 32]`), initial
`authority` (32-byte public key).

| # | Account | Signer | Writable | Purpose |
| --- | --- | --- | --- | --- |
| 0 | payer | yes | yes | funds the namespace account's rent |
| 1 | creator | yes | no | part of the namespace address; often the payer |
| 2 | namespace | no | yes | PDA `["namespace", creator, namespace_id]` |
| 3 | system program | no | no | account creation |

A creator that did not sign returns `MissingRequiredSignature`; the all-zero
key as authority (nobody can sign for it) returns `InvalidArgument`; a wrong
namespace address returns `InvalidSeeds`; opening an existing namespace
returns `AccountAlreadyInitialized`. The account is created the same
pre-funding-tolerant way as a settlement record (see Idempotency).

### `SetNamespaceAuthority` (tag 4)

Instruction data (33 bytes): tag `4`, `new_authority` (32-byte public key).

| # | Account | Signer | Writable | Purpose |
| --- | --- | --- | --- | --- |
| 0 | current authority | yes | no | must match the namespace |
| 1 | namespace | no | yes | the namespace to update |

The namespace's address and its records do not change, so rotating the key
does not reset idempotency: an event settled before the rotation stays
settled. A read-only namespace returns `InvalidAccountData`, and the all-zero
key as the new authority returns `InvalidArgument`. The authority checks are
those below.

### Authority checks

Every settlement and every rotation checks, in this order: the authority
account signed (`MissingRequiredSignature`), the namespace account is owned
by this program (`IllegalOwner`), its data has the namespace size and
discriminator (`InvalidAccountData`, so a settlement record or any other
account is refused), and its stored authority is the signing key
(`IncorrectAuthority`).

## On-chain instruction: `SettleN` (tag 5)

Settles one to eight shares in native lamports. Instruction data
(little-endian, `42 + 2n` bytes):

| Offset | Size | Field | Type |
| --- | --- | --- | --- |
| 0 | 1 | tag (`5`) | `u8` |
| 1 | 32 | `event_id` | `[u8; 32]` |
| 33 | 8 | `amount` (lamports) | `u64` LE |
| 41 | 1 | `n` (share count, `1..=8`) | `u8` |
| 42 | 2n | `bps_0 .. bps_n-1` | `u16` LE each |

Accounts, in order (exactly `n + 5`):

| # | Account | Signer | Writable | Purpose |
| --- | --- | --- | --- | --- |
| 0 | payer | yes | yes | funds the payouts and the record account |
| 1 | namespace authority | yes | no | the namespace's current authority; often the payer |
| 2 | namespace | no | no | the namespace the event is settled in |
| 3..n+2 | recipient `i` | no | yes | receives share `i` |
| n+3 | settlement record | no | yes | PDA `["settlement", namespace, event_id]` |
| n+4 | system program | no | no | transfers and account creation |

The program validates the split with the rules above and fails the whole
transaction on any violation. Split violations, and a recipient that is this
event's record or any account this program owns (another record, or a
namespace: such funds could never be recovered), return `InvalidArgument`; a
missing payer signature returns `MissingRequiredSignature`; a non-writable
payer, recipient, or record account returns `InvalidAccountData`; a wrong
record address `InvalidSeeds`; a wrong system program account
`IncorrectProgramId`; and an event already settled in this namespace
`AccountAlreadyInitialized`. A data length that does not match `n`, `n = 0`,
or `n > 8` returns `InvalidInstructionData`, and an account list whose length
is not `n + 5` returns `NotEnoughAccountKeys`. Payouts are native SOL
transfers from the payer; zero-lamport shares are skipped. The payer may
itself be a recipient; the record's `amount` field always stores the gross
amount, not the payer's net outflow.

## On-chain instruction: `SettleTokenN` (tag 6)

Settles one to eight shares in base units of a configured classic SPL Token
mint, with the same split math and the same settlement record as `SettleN`,
so an event settles exactly once in a namespace across both instructions.

Instruction data (little-endian, `43 + 2n` bytes):

| Offset | Size | Field | Type |
| --- | --- | --- | --- |
| 0 | 1 | tag (`6`) | `u8` |
| 1 | 32 | `event_id` | `[u8; 32]` |
| 33 | 8 | `amount` (token base units) | `u64` LE |
| 41 | 1 | mint `decimals` | `u8` |
| 42 | 1 | `n` (share count, `1..=8`) | `u8` |
| 43 | 2n | `bps_0 .. bps_n-1` | `u16` LE each |

Accounts, in order (exactly `n + 8`):

| # | Account | Signer | Writable | Purpose |
| --- | --- | --- | --- | --- |
| 0 | payer / token authority | yes | yes | funds record rent and authorizes token transfers |
| 1 | namespace authority | yes | no | the namespace's current authority; often the payer |
| 2 | namespace | no | no | the namespace the event is settled in |
| 3 | source token account | no | yes | classic SPL Token account owned by the payer |
| 4..n+3 | destination token account `i` | no | yes | receives share `i` |
| n+4 | mint | no | no | initialized classic SPL Token mint |
| n+5 | settlement record | no | yes | PDA `["settlement", namespace, event_id]` |
| n+6 | system program | no | no | creates the settlement record |
| n+7 | classic SPL Token program | no | no | executes checked token transfers |

The program checks the mint owner and initialized state, exact decimals,
source authority and mint, every destination mint, and the exact classic token
program ID. Transfers use `TransferChecked`. The source token account cannot
also be a destination because a self-transfer would not prove that a payout
occurred. Token-2022 is intentionally rejected: extensions such as transfer
fees can make the credited amount differ from the requested amount and require
a separate accounting contract.

## Retired instructions

Tags `0`, `1`, and `2` were the original `Settle`, `SettleN`, and
`SettleTokenN`. They derived the settlement record from the event id alone
(`["settlement", event_id]`), so anyone who learned an unsettled event id
could settle it first, to wallets of their choosing, and the real settlement
then failed with `AccountAlreadyInitialized`. The program now refuses those
tags with `InvalidInstructionData`, logging that they are retired. Records
they created stay on chain at their old addresses and are not reused: a
namespaced record has a different address. So the program cannot tell that
an event settled before the upgrade is settled: before retrying an event first
attempted before namespaces, check its old record address
(`findLegacySettlementRecordPda` in the SDK); if an account exists there, the
event is settled and must not be settled again.

## Idempotency

The settlement record is a PDA derived as:

```
seeds = ["settlement", namespace, event_id]
```

Clients derive the 32-byte `event_id` as `sha256(application_event_id)`
(`eventIdSeed` in the SDK). The record account stores a 1-byte
discriminator, the event id, and the settled amount (41 bytes). If the
record is already owned by the program (or carries data), the program
rejects the instruction with `AccountAlreadyInitialized`, so the same event
cannot be settled twice in a namespace. The same event id in another
namespace is a different record and does not affect yours.

The record is created as transfer + allocate + assign rather than a single
`create_account`. `create_account` fails when the target address already
holds lamports, which would let anyone permanently block a record or
namespace address by parking a small deposit (the rent floor for an empty account, 0.00065024 SOL
on devnet on 20 October 2026) on its PDA before settlement. With the three-step
creation, a pre-funded PDA is simply topped up to rent exemption (the payer
pays only the shortfall), then allocated and assigned under the program's
signer seeds. Because only the system program can allocate or assign a
system-owned account and both require the PDA's signature, no third party
can put a record-shaped account at that address ahead of the program. Any
account at the address that already carries data is rejected with
`AccountAlreadyInitialized`; a data-less account owned by anything other
than the system program is rejected with `InvalidAccountData`. Namespaces are
created the same way.

## Client fallback mode

When no program id is configured, the TypeScript client settles with one
`SystemProgram.transfer` instruction per nonzero share in a single
transaction (up to eight), computed with the identical split function, plus
a memo instruction recording the event id. Same amounts, same conservation guarantee, weaker atomicity semantics
(no on-chain re-validation, no idempotency record). It exists so the demo
produces a real devnet transaction without requiring anyone to deploy the
program first.

## Assets

The implementation supports two devnet settlement paths:

- **Native SOL stand-in:** request amounts are modeled as USDC-style
  six-decimal units and multiplied by a configurable lamport scale.
- **Configured classic SPL Token mint:** amounts are settled in token base
  units with the mint address and decimals included in the instruction and
  structured memo. The reference example requires six decimals, but the wire
  instruction supports any mint-decimal value that matches the on-chain mint.

This repository does not mint, endorse, or launch a token. Integrators supply
the devnet mint they intend to test. Mainnet assets remain out of scope.
