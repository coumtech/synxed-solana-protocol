# Protocol specification

## Overview

The SYNXED settlement protocol settles a single revenue event (for example
an in-game audio-ad impression) into a deterministic payout across
configured shares — three by default, up to eight with `SettleN`:

```
gross amount -> [artist, studio, synxed]
gross amount -> [artist, studio, synxed, rewards_pool, ...]   (SettleN)
```

Shares are expressed in **basis points** (bps). `10000` bps = 100%.

## Split math

Given `amount` (a positive integer of atomic units) and `n` shares
`[bps_0, ..., bps_n-1]` with `1 <= n <= 8`:

1. Every share must be an integer in `0..=10000`.
2. The shares must sum to exactly `10000`. Anything else is rejected —
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

`tests/instruction.test.ts` and `tests/instruction-n.test.ts` pin the shared
byte layouts against golden vectors also asserted in the Rust codec tests,
and both languages carry conservation and rejection tests.

## Default configuration

| Parameter | Value | Meaning |
| --- | --- | --- |
| `amount` | `20000` | $0.020 at 6 decimals (micro-dollars) |
| `artist_bps` | `3500` | 35% -> $0.007 |
| `studio_bps` | `4000` | 40% -> $0.008 |
| `synxed_bps` | `2500` | 25% -> $0.005 |

All four are configurable per settlement; the percentages above are
placeholders, not contractual rates.

## On-chain instruction: `Settle`

Instruction data (little-endian, 47 bytes):

| Offset | Size | Field | Type |
| --- | --- | --- | --- |
| 0 | 1 | tag (`0`) | `u8` |
| 1 | 32 | `event_id` | `[u8; 32]` |
| 33 | 8 | `amount` (lamports) | `u64` LE |
| 41 | 2 | `artist_bps` | `u16` LE |
| 43 | 2 | `studio_bps` | `u16` LE |
| 45 | 2 | `synxed_bps` | `u16` LE |

Accounts, in order:

| # | Account | Signer | Writable | Purpose |
| --- | --- | --- | --- | --- |
| 0 | payer | yes | yes | funds the payouts and the record account |
| 1 | artist | no | yes | receives the artist share |
| 2 | studio | no | yes | receives the studio share |
| 3 | synxed | no | yes | receives the platform share |
| 4 | settlement record | no | yes | PDA, marks the event as settled |
| 5 | system program | no | no | transfers and account creation |

The program validates the split with the same rules as above and fails the
whole transaction on any violation. Split violations, and a payout
recipient that is a settlement record (this event's or any other's — such
funds could never be recovered), return `InvalidArgument`; a missing
payer signature returns `MissingRequiredSignature`; a non-writable payer,
payout, or record account returns `InvalidAccountData`; a wrong record
address `InvalidSeeds`; a wrong system program account
`IncorrectProgramId`; and an already-settled event
`AccountAlreadyInitialized`. Payouts are native SOL transfers from the
payer; zero-lamport shares are skipped.

## On-chain instruction: `SettleN`

The N-way form of `Settle`. Same validation, record, and payout semantics;
the share count is carried in the data and the recipients in the account
list.

Instruction data (little-endian, `42 + 2n` bytes):

| Offset | Size | Field | Type |
| --- | --- | --- | --- |
| 0 | 1 | tag (`1`) | `u8` |
| 1 | 32 | `event_id` | `[u8; 32]` |
| 33 | 8 | `amount` (lamports) | `u64` LE |
| 41 | 1 | `n` (share count, `1..=8`) | `u8` |
| 42 | 2n | `bps_0 .. bps_n-1` | `u16` LE each |

Accounts, in order — exactly `n + 3`:

| # | Account | Signer | Writable | Purpose |
| --- | --- | --- | --- | --- |
| 0 | payer | yes | yes | funds the payouts and the record account |
| 1..n | recipient `i` | no | yes | receives share `i` |
| n+1 | settlement record | no | yes | PDA, marks the event as settled |
| n+2 | system program | no | no | transfers and account creation |

A data length that does not match `n`, `n = 0`, or `n > 8` is rejected
with `InvalidInstructionData`; an account list whose length is not
`n + 3` is rejected with `NotEnoughAccountKeys` (this strictness applies to
`Settle` as well). Both instructions share the same record PDA, so an event
settled through one cannot be settled again through the other.

The three-way `Settle` instruction is equivalent to `SettleN` with
`n = 3` and remains supported on the wire unchanged. One behavioral
tightening applies to both: the account list must be exact, so a client
that appended unused accounts (for example sysvars) will now be rejected
with `NotEnoughAccountKeys`. The payer may itself be a recipient; the
record's `amount` field always stores the gross amount, not the payer's net
outflow.

## Idempotency

The settlement record is a PDA derived as:

```
seeds = ["settlement", event_id]
```

Clients derive the 32-byte `event_id` as `sha256(application_event_id)`
(`eventIdSeed` in the SDK). The record account stores a 1-byte
discriminator, the event id, and the settled amount (41 bytes). If the
record is already owned by the program (or carries data), the program
rejects the instruction with `AccountAlreadyInitialized`, so the same event
cannot be settled twice.

The record is created as transfer + allocate + assign rather than a single
`create_account`. `create_account` fails when the target address already
holds lamports, which would let anyone permanently block an `event_id` by
parking a small deposit (the rent floor for an empty account, about 0.0009
SOL) on its PDA before settlement. With the three-step
creation, a pre-funded PDA is simply topped up to rent exemption (the payer
pays only the shortfall), then allocated and assigned under the program's
signer seeds. Because only the system program can allocate or assign a
system-owned account and both require the PDA's signature, no third party
can put a record-shaped account at that address ahead of the program. Any
account at the record address that already carries data is rejected with
`AccountAlreadyInitialized`; a data-less account owned by anything other
than the system program is rejected with `InvalidAccountData`.

## Client fallback mode

When no program id is configured, the TypeScript client settles with one
`SystemProgram.transfer` instruction per nonzero share in a single
transaction (up to eight), computed with the identical split function, plus
a memo instruction recording the event id. Same amounts, same conservation guarantee, weaker atomicity semantics
(no on-chain re-validation, no idempotency record). It exists so the demo
produces a real devnet transaction without requiring anyone to deploy the
program first.

## Assets

The current implementation settles **native SOL on devnet** as a stand-in
asset. Amounts are modeled as USDC-style 6-decimal atomic units and scaled
into lamports by a configurable factor. No token is minted by this
repository, and an SPL stablecoin path is future work.
