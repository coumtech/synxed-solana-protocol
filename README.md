# SYNXED Solana Settlement Protocol

An open source, Solana native **revenue settlement protocol** for gaming
and audio: a billable event (for example an in-game audio-ad impression)
becomes a deterministic 3-way revenue split settled on-chain, with the
transaction visible in Solana Explorer.

```
App / game  ->  Revenue event  ->  Split (35/40/25, configurable)
            ->  Solana settlement  ->  artist / studio / platform wallets
```

**What this is:** the public settlement rail — a Solana program, a strict
TypeScript SDK, a runnable demo, and the protocol documentation.

**What this is not:** the SYNXED product. The proprietary platform (radio
SDK, ad decisioning, attribution, licensing) is a black box that emits
`SettlementRequest`s; none of it lives here, and none of it is needed to
run or evaluate this repository. See
[docs/architecture.md](docs/architecture.md).

> Not financial advice. Not a token launch. Not an RWA or royalty
> tokenization product. Devnet only.

## How a settlement works

An ad impression worth $0.020 with the default (placeholder, configurable)
split:

| Role | Share | Amount |
| --- | --- | --- |
| Artist | 35% | $0.007 |
| Studio | 40% | $0.008 |
| SYNXED | 25% | $0.005 |

Splits are basis points that must sum to exactly 10000; payouts are integer
math that always sums to the gross amount (rounding dust goes to the last
share, documented in [docs/protocol.md](docs/protocol.md)). Invalid splits
are rejected — in the client and on-chain — never renormalized.

Splits are not limited to three parties. The `SettleN` instruction settles
one to eight configured shares under the same rules, which is how a
listener rewards pool becomes a fourth recipient (artist 35% / studio 35% /
SYNXED 20% / rewards pool 10%): `bun run demo:nway`.

## Quickstart (~10 minutes)

Prerequisites: [Bun](https://bun.sh) ≥ 1.1. Rust is optional (only for the
program's own tests), the Solana CLI is not required.

```bash
git clone https://github.com/coumtech/synxed-solana-protocol.git
cd synxed-solana-protocol
bun install
```

**1. Run the tests**

```bash
bun test            # split math, instruction layout, client guards (TypeScript)
bun run typecheck   # strict TS, no `any`
cargo test --manifest-path programs/synxed-settlement/Cargo.toml   # optional
```

**2. Dry-run the demo** (no wallet, no network writes)

```bash
bun run demo          # three-way: artist / studio / SYNXED
bun run demo:nway     # four-way: adds a listener rewards pool share
```

Prints a simulated audio-ad impression and its deterministic split.

**3. Settle on devnet**

```bash
bun run demo:keygen     # writes a local devnet keypair to .keys/payer.json
cp .env.example .env    # then set SOLANA_PAYER_KEYPAIR=.keys/payer.json
bun run demo
```

The demo funds the payer via devnet airdrop (or use
https://faucet.solana.com), submits the settlement, and prints a
`https://explorer.solana.com/tx/...?cluster=devnet` link showing the three
payouts.

The devnet demo settles **native SOL as a stand-in asset** — no token is
minted by this repo. Amounts are micro-dollars scaled into lamports
(`LAMPORTS_PER_UNIT`, default 1000, so $0.020 settles as 0.02 SOL).

### Settlement modes

- **Fallback (default):** one system transfer per nonzero share, computed
  with the split math, plus a memo — works with nothing deployed.
- **Program mode:** set `SETTLEMENT_PROGRAM_ID` in `.env` and settlement
  becomes a single instruction that re-validates the split on-chain,
  enforces per-event idempotency, and pays every wallet atomically. A
  reference deployment exists on devnet — no build tools required:

  ```
  SETTLEMENT_PROGRAM_ID=HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT
  ```

  The reference deployment is upgradeable by the maintainers; deploy your
  own copy of `programs/synxed-settlement` if you need to trust the exact
  bytecode ([docs/integration.md](docs/integration.md)).

## Repository layout

```
programs/synxed-settlement    Solana program (Rust)
sdk/typescript                TypeScript SDK: types, split, codec, client
examples/gaming-payment-demo  CLI demo: fake impression -> devnet settlement
tests/                        Bun test suite (SDK)
programs/synxed-settlement/svm-tests
                              In-process SVM tests of the compiled program
docs/                         architecture, protocol spec, integration guide,
                              payout ledger proposal, demo script
```

## Scope and roadmap

**Current scope (implemented here):**

- Deterministic, auditable split primitive (Rust + TypeScript): three-way
  by default, one to eight shares via `SettleN`, both sharing one
  per-event idempotency record
- Devnet settlement program with per-event idempotency
- Strict TypeScript client and a reproducible CLI demo
- Tests for the happy path and every invalid-split case, plus in-process
  SVM tests of the compiled program (idempotency, pre-funded record
  defense, account validation) run in CI on every pull request

**Planned next:**

- Payout ledger: schema proposal drafted in
  [docs/payout-ledger.md](docs/payout-ledger.md); public example types and
  reference implementation to follow
- Wallet-connect flow in the demo
- SPL/devnet stablecoin settlement path

**Explicitly future (not in this repository):**

- Mainnet deployment, audits, and live artist/developer payouts
- Anything belonging to the proprietary SYNXED platform

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md) — branch protection, workflow, code
  standards
- [SECURITY.md](SECURITY.md) — private vulnerability reporting; never
  commit keypairs or `.env`
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

[Apache 2.0](LICENSE) © Coum Technologies Ltd.
