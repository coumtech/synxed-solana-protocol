# Classic SPL Token settlement on devnet

The public protocol can settle a configured classic SPL Token mint without
creating a SYNXED token. The runnable example labels a generic configured mint
as `SPL_STABLECOIN`; `USDC` is reserved for mints an integrator has explicitly
identified as USDC. The mint address is always an input and is independently
checked during finalized reconciliation.

## Security boundary

- Devnet only; this is not a mainnet payment release or token launch.
- Only the classic SPL Token program is supported. Token-2022 is rejected so
  transfer-fee and other extensions cannot silently change credited amounts.
- The program uses `TransferChecked` and validates the initialized mint, exact
  decimals, source authority, and source/destination mints.
- The token instruction shares the native settlement record PDA. Reusing an
  event ID across native or token modes is rejected on-chain.
- The SDK derives canonical associated token accounts and reconciliation fails
  closed if the mint, decimals, accounts, memo, totals, finality, or inner
  transfers differ.
- Private production eligibility, fraud checks, and listener allocation remain
  outside this repository.

## Run the example

Prerequisites are a devnet payer keypair, the deployed settlement program, and
a funded six-decimal classic SPL Token mint whose payer-associated account has
at least `20000` base units.

```bash
cp .env.example .env
# Configure SOLANA_PAYER_KEYPAIR and SETTLEMENT_PROGRAM_ID in .env.
STABLECOIN_MINT=<devnet-classic-spl-mint> bun run demo:token
```

The command:

1. verifies the RPC genesis hash is Solana devnet;
2. fetches the mint from the classic token program and requires six decimals;
3. verifies the payer's associated token balance and SOL fee/rent buffer;
4. creates recipient associated token accounts idempotently;
5. submits a 35/35/20/10 `SettleTokenN` transaction;
6. waits for finalized evidence and reconciles every checked transfer; and
7. writes public evidence under `.local/ledger/`.

For a `20000`-base-unit example, the exact transfers are `7000`, `7000`,
`4000`, and `2000`. Amounts remain integer strings or `bigint` throughout.

## Mint policy

The reference code does not hard-code a devnet mint. That avoids treating a
maintainer-controlled test mint as a canonical stablecoin. Production
integrators must maintain an allowlist that binds their accounting asset to a
specific mint, token program, decimals, cluster, and governance policy. A
future mainnet release also requires an independent security audit and an
explicit Token-2022 policy before supporting extension-bearing assets.
