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
  0.00114808 SOL on devnet on 21 October 2026, paid once) and afterwards
  only checks that it exists and that its authority is the one you expect.
  `CreateNamespace` does not ask the initial authority to sign, so check the
  key you pass: a namespace opened with a key nobody holds can never settle,
  and its id is used up for that creator.
- **Idempotency is per namespace.** An event settled in one namespace can be
  settled again in another, so a different label, payer key, or program id
  silently starts afresh. Pin the namespace address in your production
  configuration and call `ensureNamespace` there with `create: false` and
  `expectedAddress` set to it, so a missing namespace or a different address
  is an error instead of a new namespace (`NAMESPACE_MISSING`,
  `NAMESPACE_ADDRESS`). If the payer key that opened it was replaced, also
  pass the old key as `creator` and, unless you rotated the authority to the
  new key, as `authority` (and to the submit functions).
- **Environments:** use one namespace per environment (for example
  `studio-payouts-staging` and `studio-payouts`), so the same event id can be
  settled independently in each.
- **A separate authority:** pass `authority` to `ensureNamespace`, then the
  authority's `Keypair` as `authority` to the submit functions; both the
  payer and the authority sign. A wallet that builds its own transaction
  passes the authority's public key to `buildSettlementNTransaction`. A
  hardware key signs the transaction directly. A multisig (for example a
  Squads vault) signs through its own program, so its settlements are inner
  instructions that the SDK's reconcile functions do not read: reconcile
  those by hand, as described in known limitation 1 of
  [security-model.md](security-model.md).
- **Rotating the key:** the current and the new authority both sign
  `buildSetNamespaceAuthorityInstruction`, so the namespace can never be
  handed to a key nobody holds. The namespace address and its records stay
  the same, so events settled before the rotation stay settled. Rotating to
  or from a multisig vault means the vault signs through its own program
  while the other key signs the same transaction; this repository has not
  tested that with any multisig, so try it on devnet before relying on it.
- **Losing the authority key:** nobody can recover a namespace whose
  authority key is lost; the creator has no override. Keep the authority
  backed up. If you must move to a new namespace, first make sure nothing
  already signed for the old one can still land: settlements never expire
  on chain once signed, except through their blockhash. Wait until every
  recent blockhash you signed with has expired, advance or close any durable
  nonce you signed with, and cancel pending multisig proposals; an event
  whose signed settlement cannot be invalidated stays unresolved. Then check
  each pending event in the old namespace with `fetchSettlementRecord`, which
  counts only a record the program owns for that event (anyone can send
  lamports to a record's address, so an account merely existing there proves
  nothing).
  For each record found, find its creating transaction with
  `findSettlementTransaction` and reconcile it against your stored request
  (known limitation 1 of [security-model.md](security-model.md)) before
  treating the event as paid. Settle in the new namespace only the events
  with no record in the old one, and confirm each null with a second RPC
  provider first.
- **Wallets:** `fetchNamespace` reports whether the namespace exists (lamports
  someone sent to its address do not count; the program opens a namespace
  there all the same). Passing `createNamespaceId` to
  `buildSettlementNTransaction` opens it in the same transaction as the first
  settlement, so the user approves once. If that transaction fails with
  `AccountAlreadyInitialized` in its first instruction (`CreateNamespace`),
  the namespace was opened meanwhile: build the settlement again without
  `createNamespaceId`.

## 6. Upgrading from the retired instructions

The reference deployment once ran instructions that keyed the settlement
record on the event id alone (tags 0 to 2). The program now refuses them, and
this SDK neither builds nor reconciles them.

Events settled before the upgrade have their records at the old address,
`["settlement", event_id]`, which a namespaced settlement does not see. The
retired instructions let anyone settle any event id, with their own payer and
to wallets of their choosing. Events first attempted after the upgrade need
no check. Before retrying an event first attempted before it:

1. Call `fetchLegacySettlementRecord`. It counts only an account the program
   owns that holds this event's record; lamports sent to the address do not
   count. If it returns null, confirm that with a second RPC provider, then
   settle the event in your namespace as usual.
2. For a record, find its creating transaction with
   `findLegacySettlementTransaction`, and confirm the transaction with a
   second provider. The SDK does not reconcile retired instructions, so
   compare it with your stored requests by hand: the payer is the
   instruction's first account, and the payouts are the transfers inside it.
   "Matches" means everything `reconcileSettlementN` and
   `reconcileTokenSettlementN` would check: the same asset (lamports or
   tokens), mint and decimals, the same recipient wallets (and their token
   accounts for that mint), and the same on-chain amounts after scaling. The
   retired instructions let a payer choose all of these. Keep a list of every
   payer key you have used, including your users' wallets in a wallet flow,
   then decide:

| The creating transaction | Decision |
| --- | --- |
| Paid by a key you control or controlled, and matches a stored request | Paid: never settle it again |
| Paid by a key you control or controlled, and matches no stored request | Incident: do not mark it paid, and do not settle it again |
| Paid by someone else, and matches a stored request | Paid by them: never settle it again, and raise an alert |
| Paid by someone else, in any other way | Not paid by you: settle it in your namespace, and raise an alert |

Anything you cannot decide (the transaction cannot be found, or the two
providers disagree) is unresolved: retry later, and do not settle the event
meanwhile.

Ledger rows written before the upgrade are `SettlementRecord` schema
version 1, without `namespace` and `authority`, and their `settlementRecord`
is the old address `["settlement", event_id]`; keep them as they are. This
SDK cannot reconcile those transactions again, so a ledger rebuilt from
chain history covers only settlements made after the upgrade.

## 7. Operational notes

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
