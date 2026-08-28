# Protocol specification

## Overview

The SYNXED settlement protocol settles a single revenue event (for example
an in-game audio-ad impression) into a deterministic 3-way payout:

```
gross amount -> [artist, studio, synxed]
```

Shares are expressed in **basis points** (bps). `10000` bps = 100%.

## Split math

Given `amount` (a positive integer of atomic units) and shares
`[artist_bps, studio_bps, synxed_bps]`:

1. Every share must be an integer in `0..=10000`.
2. The three shares must sum to exactly `10000`. Anything else is rejected —
   never renormalized.
3. `amount` must be greater than zero.
4. The first two payouts are floor divisions:
   `payout_i = floor(amount * bps_i / 10000)`.
5. The last payout is the remainder: `amount - payout_0 - payout_1`.

Property (conservation): the three payouts always sum to `amount` exactly.
No atomic unit is created or destroyed by rounding; any rounding dust lands
in the last (platform) share, and that behavior is deliberate and documented
rather than hidden.

The same algorithm is implemented twice and kept in lockstep:

- Rust: `programs/synxed-settlement/src/split.rs` (`split_three`)
- TypeScript: `sdk/typescript/src/split.ts` (`splitAmountAtomic`)

`tests/instruction.test.ts` pins the shared byte layout, and both languages
carry conservation and rejection tests.

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
whole transaction on any violation (`InvalidArgument`). Payouts are native
SOL transfers from the payer.

## Idempotency

The settlement record is a PDA derived as:

```
seeds = ["settlement", event_id]
```

Clients derive the 32-byte `event_id` as `sha256(application_event_id)`
(`eventIdSeed` in the SDK). The record account stores a 1-byte
discriminator, the event id, and the settled amount (41 bytes). If the
record already exists, the program rejects the instruction with
`AccountAlreadyInitialized`, so the same event cannot be settled twice.

Known limitation (documented, acceptable for a devnet prototype): a third
party can grief a specific `event_id` by pre-funding its record PDA before
settlement, since the program refuses to touch a record account that
already holds lamports. A production version would create the record via
transfer/allocate/assign to tolerate pre-funded accounts.

## Client fallback mode

When no program id is configured, the TypeScript client settles with three
`SystemProgram.transfer` instructions in a single transaction, computed with
the identical split function, plus a memo instruction recording the event
id. Same amounts, same conservation guarantee, weaker atomicity semantics
(no on-chain re-validation, no idempotency record). It exists so the demo
produces a real devnet transaction without requiring anyone to deploy the
program first.

## Assets

The current implementation settles **native SOL on devnet** as a stand-in
asset. Amounts are modeled as USDC-style 6-decimal atomic units and scaled
into lamports by a configurable factor. No token is minted by this
repository, and an SPL stablecoin path is future work.
