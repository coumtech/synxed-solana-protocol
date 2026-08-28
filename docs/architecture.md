# Architecture

## The boundary

This repository is a **settlement rail**, not the SYNXED product. The
proprietary SYNXED platform (radio SDK, ad decisioning, attribution,
licensing) is treated as a **black box** that emits one thing this protocol
cares about: a `SettlementRequest`.

```
+---------------------------+
|  SYNXED Platform          |     proprietary, NOT in this repo
|  (radio SDK, ads,         |
|   attribution, licensing) |
+-------------+-------------+
              |
              |  SettlementRequest
              |  { eventId, amount, splits[3], ... }
              v
+---------------------------+
|  This repository          |
|                           |
|  TypeScript SDK           |     validate + deterministic 3-way split
|    sdk/typescript         |
|          |                |
|          v                |
|  Settlement program       |     re-validates split, pays recipients,
|    programs/              |     records event id (idempotency PDA)
|    synxed-settlement      |
+-------------+-------------+
              |
              v
   Solana devnet: artist / studio / synxed wallets
   (transaction visible in Solana Explorer)
```

Anyone can produce a `SettlementRequest` — the demo in
`examples/gaming-payment-demo` fabricates one from a fake in-game audio-ad
impression. No proprietary event generator is needed to use or evaluate
this protocol.

## Components

| Path | Role |
| --- | --- |
| `programs/synxed-settlement` | Solana program: `Settle` instruction, split validation, idempotency record, SOL payouts |
| `sdk/typescript` | Types, split math, instruction codec, devnet submission client |
| `examples/gaming-payment-demo` | CLI simulator: fake impression -> split -> devnet transaction -> Explorer link |
| `tests/` | Bun tests for split math and the instruction byte layout |

## Design decisions

- **Deterministic and auditable.** The split is pure integer math specified
  in [protocol.md](protocol.md). The same inputs always produce the same
  payouts, in the client and on-chain. There are no hidden fees; the only
  rounding effect (dust to the last share) is documented.
- **Reject, don't repair.** Invalid splits (wrong sum, out-of-range bps,
  zero amount) throw client-side and abort the transaction on-chain.
  Nothing is silently renormalized.
- **Two settlement modes.** With a deployed program id the client sends one
  program instruction and the chain enforces the split and idempotency.
  Without one, it falls back to three system transfers computed with the
  same math, so a fresh clone can still produce a real devnet transaction.
- **Feature-gated program crate.** `cargo test` runs the split-math tests on
  any host with no Solana toolchain; the on-chain entrypoint compiles behind
  `--features onchain` for `cargo build-sbf`.
- **Devnet only.** No mainnet configuration exists in this repository.

## Trust model (current stage)

The payer wallet (the platform operator) is trusted to submit truthful
events and amounts — the program verifies the *split*, not the *event*.
Verifying event authenticity (oracles, attestation, reconciliation) is
future work and out of scope here.
