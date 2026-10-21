# Integration guide

How a game studio (or any app) settles revenue events with this protocol
using only the public code in this repository.

## 1. Construct a `SettlementRequest`

Your app decides when an event is billable. This protocol only needs the
result.

> **The SDK is not published to npm.** Do not `npm install` the name below.
> The package name resolves only inside this repository's Bun workspace
> (the demo consumes it exactly this way; see
> `examples/gaming-payment-demo/package.json`). To use the SDK elsewhere,
> vendor `sdk/typescript/src`.

```ts
import {
  computeSettlement,
  type SettlementRequest,
} from "@coumtech/synxed-solana-protocol"; // sdk/typescript/src/index.ts

const request: SettlementRequest = {
  eventId: "evt_8f2c...",            // your unique id; drives idempotency
  occurredAt: new Date().toISOString(),
  kind: "audio_ad_impression",
  amountAtomic: 20_000n,             // $0.020 at 6 decimals
  asset: "SOL_LAMPORTS_STANDIN",
  splits: [
    { role: "artist", recipient: "<base58>", bps: 3_500 },
    { role: "studio", recipient: "<base58>", bps: 4_000 },
    { role: "synxed", recipient: "<base58>", bps: 2_500 },
  ],
  memo: "audio ad impression",
};
```

> The SDK is consumed from source (Bun and modern bundlers run TypeScript
> directly), either as the workspace package above or by vendoring
> `sdk/typescript/src`.

## 2. Compute (and display) the split

```ts
const result = computeSettlement(request);
// result.payouts -> [{ role: "artist", amountAtomic: 7000n, ... }, ...]
```

`computeSettlement` throws a typed `ProtocolError` on any invalid split:
wrong sum, fractional or out-of-range bps, zero amount, roles out of order.
Handle the error; do not retry with adjusted numbers unless a human
approved the new configuration.

## 3. Submit on devnet

```ts
import { Connection, Keypair } from "@solana/web3.js";
import {
  DEVNET_RPC_URL,
  submitSettlement,
} from "@coumtech/synxed-solana-protocol";

const submission = await submitSettlement({
  connection: new Connection(DEVNET_RPC_URL, "confirmed"),
  payer,                        // Keypair funding the payouts
  request,
  lamportsPerAtomicUnit: 1_000n, // devnet stand-in scaling, see below
  // programId and namespace: optional, see "Program mode" and section 5
});
console.log(submission.explorerUrl);
```

- **Scaling:** amounts are modeled as 6-decimal micro-dollars but settled in
  SOL lamports on devnet. `lamportsPerAtomicUnit` (default `1`) converts
  between the two. Keep each recipient's share above the rent-exempt
  minimum for an empty account (0.00065024 SOL on devnet on 20 October 2026;
  query `getMinimumBalanceForRentExemption(0)`) or transfers to brand-new
  accounts will fail. The gaming demo prints a warning when a share is below
  the SDK's more conservative `APPROX_RENT_EXEMPT_MIN_LAMPORTS` (890,880
  lamports).
- **Fallback mode (default):** one `SystemProgram` transfer per nonzero share plus a memo.
  No deployment needed.
- **Program mode:** pass `programId` and your `namespace` (section 5) and the
  client sends a single `SettleN` instruction, signed by the payer and the
  namespace authority; the program checks the authority, re-validates the
  split on-chain, writes the idempotency record, and pays every recipient
  atomically.

## 4. Deploying the program (optional, for program mode)

A reference deployment is live on devnet and can be used directly:

```
SETTLEMENT_PROGRAM_ID=HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT
```

The reference deployment is upgradeable by the maintainers (standard
upgradeable-loader deployment). Deploy your own copy if you need to trust
the exact bytecode.

To deploy your own copy you need the
[Solana CLI tools](https://docs.solana.com/cli/install) with
`cargo build-sbf` (plus `rustup`, which `cargo build-sbf` uses to link its
toolchain):

```bash
cargo build-sbf --manifest-path programs/synxed-settlement/Cargo.toml --features onchain
solana program deploy programs/synxed-settlement/target/deploy/synxed_settlement.so --url devnet
```

Put the printed program id in `.env` as `SETTLEMENT_PROGRAM_ID`. Deploy
keys are yours; never commit them.

## 5. Your settlement namespace (program mode)

Program mode settles inside a namespace that you open once. Its authority,
the payer by default, is the only key that can settle in it, and every
settlement record is derived from the namespace and the event id, so nobody
else can settle one of your event ids first.

```ts
import {
  ensureNamespace,
  namespaceIdFromLabel,
  submitSettlement,
} from "@coumtech/synxed-solana-protocol";

const { address: namespace } = await ensureNamespace({
  connection,
  payer,                                     // pays the rent, signs as creator
  programId,
  namespaceId: namespaceIdFromLabel("studio-payouts"),
  // authority: defaults to payer.publicKey
});

await submitSettlement({ connection, payer, request,
  lamportsPerAtomicUnit: 1_000n, programId, namespace });
```

- **Address:** the namespace is a program account at
  `["namespace", creator, namespace_id]`, so it is fixed by your key and the
  id you chose. `ensureNamespace` opens it on first use (rent for 98 bytes,
  about 0.00157 SOL on devnet, paid once) and afterwards only checks that it
  exists and that its authority is the one you expect. Keep the address in
  your configuration.
- **Environments:** use one namespace per environment (for example
  `studio-payouts-staging` and `studio-payouts`), so the same event id can be
  settled independently in each.
- **A separate authority:** pass `authority` to `ensureNamespace`, then the
  authority's `Keypair` as `authority` to the submit functions; both the
  payer and the authority sign. A wallet that builds its own transaction
  passes the authority's public key to `buildSettlementNTransaction`.
- **Rotating the key:** the current authority signs
  `buildSetNamespaceAuthorityInstruction`. The namespace address and its
  records stay the same, so events settled before the rotation stay settled.
- **Wallets:** `fetchNamespace` reports whether the namespace exists;
  passing `createNamespaceId` to `buildSettlementNTransaction` opens it in the
  same transaction as the first settlement, so the user approves once.

## 6. Operational notes

- Use one `eventId` per billable event. In program mode the chain rejects a
  second settlement of the same id in your namespace
  (`AccountAlreadyInitialized`).
- Only your namespace authority can create that record, so a duplicate error
  means your own key settled the event before, for example in a retry that
  landed. Reconcile that transaction against your stored request before
  marking the event paid; see known limitation 1 in
  [security-model.md](security-model.md).
- Recipients are plain system accounts (wallet pubkeys). They do not need
  to sign.
- Fund the payer with devnet SOL: the demo attempts an RPC airdrop, and
  https://faucet.solana.com works when the RPC faucet is rate-limited.
- Everything here is devnet-only. Do not point the client at mainnet.

## N-way splits and pooled shares

For more than three parties, for example a listener rewards pool, build a
`SettlementRequestN` and use the N-way functions. Labels are yours; the
program only sees recipients and basis points.

```ts
import {
  computeSettlementN,
  submitSettlementN,
  type SettlementRequestN,
} from "@coumtech/synxed-solana-protocol";

const request: SettlementRequestN = {
  eventId: "evt_8f2c...",
  occurredAt: new Date().toISOString(),
  kind: "audio_ad_impression",
  amountAtomic: 20_000n,
  asset: "SOL_LAMPORTS_STANDIN",
  shares: [
    { label: "artist", recipient: "<base58>", bps: 3_500 },
    { label: "studio", recipient: "<base58>", bps: 3_500 },
    { label: "synxed", recipient: "<base58>", bps: 2_000 },
    { label: "rewards_pool", recipient: "<pool wallet>", bps: 1_000 },
  ],
  memo: "audio ad impression",
};

const result = computeSettlementN(request); // payouts per label
const submission = await submitSettlementN({ connection, payer, request,
  lamportsPerAtomicUnit: 1_000n, programId, namespace });
```

One to eight shares are accepted; the shares must sum to 10000 bps. A
pooled share is just a recipient wallet on-chain; distribution from the
pool to individual listeners is an off-chain, batched concern described in
[payout-ledger.md](payout-ledger.md).

## Classic SPL Token settlement

Use `submitTokenSettlementN` when the settlement asset is a configured classic
SPL Token mint. The SDK derives the payer and recipient associated token
accounts, adds idempotent recipient-account creation instructions, and submits
one `SettleTokenN` program instruction. With that account creation one
transaction fits five token shares, and six only while the event id and memo
stay short; see known limitation 7 in [security-model.md](security-model.md). The on-chain program verifies the mint,
decimals, account ownership, and every checked transfer.

```ts
import { getMint, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  reconcileTokenSettlementN,
  submitTokenSettlementN,
} from "@coumtech/synxed-solana-protocol";

const mint = new PublicKey(process.env.STABLECOIN_MINT!);
const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
const submission = await submitTokenSettlementN({
  connection,
  payer,
  request: { ...request, asset: "SPL_STABLECOIN" },
  mint,
  decimals: mintInfo.decimals,
  programId,
  namespace,
  tokenBaseUnitsPerAtomicUnit: 1n,
});

const evidence = await reconcileTokenSettlementN({
  connection,
  signature: submission.signature,
  request: { ...request, asset: "SPL_STABLECOIN" },
  mint,
  decimals: mintInfo.decimals,
  programId,
  namespace,
  tokenBaseUnitsPerAtomicUnit: 1n,
});
```

The payer must own the source associated token account and hold enough base
units for the gross amount. A payer cannot also be a recipient in token mode,
because that would derive the source account as a destination. The public demo
uses the `SPL_STABLECOIN` asset identifier for a generic configured mint. Use
`USDC` only when your mint allowlist identifies the supplied mint as USDC.
Mint identity is never inferred from the label and must be supplied explicitly.

Only the classic SPL Token program is accepted. Token-2022 mints require a
separate design and reconciliation path for extensions such as transfer fees.
See [spl-stablecoin.md](spl-stablecoin.md) for the runnable devnet procedure and
security boundary.

## Reference: the runnable example

`examples/gaming-payment-demo` wires all of the above into CLIs:
fake impression -> `SettlementRequest` -> split table -> devnet transaction
-> Explorer link. Reading its `src/index.ts` top to bottom is the fastest
way to see the native integration surface; `src/token.ts` shows the token path.
