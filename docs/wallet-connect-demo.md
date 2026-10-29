# Wallet-connect settlement demo

The open source browser example uses Solana Wallet Adapter and automatically
discovers installed Wallet Standard wallets. Phantom and Solflare are also
registered as fallback entries so the picker is never empty. In a desktop
browser with no wallet installed it still lists both: choosing Phantom turns
the header button into **Connect**, and pressing it opens phantom.app (the
page says so); choosing Solflare opens Solflare's hosted web wallet, pinned to
devnet. On an iPhone (any iOS browser outside a wallet's in-app browser)
choosing either entry redirects to that wallet app's in-app browser through a
universal link. On Android mobile web the picker also
offers Mobile Wallet Adapter, which hands off to an installed wallet app. An
installed wallet of the same name replaces its fallback entry. The example
does not ship a private key, custody funds, or request mainnet access.

## Hosted demo

A build of `main` is hosted at
<https://synxed-solana-protocol-wallet-conne.vercel.app/>. It targets the
reference devnet program and the public devnet RPC; nothing in the bundle is
secret. To use it you need a Solana wallet: a Wallet Standard browser wallet
(Phantom, Solflare, and others) or Solflare's web wallet, switched to
**devnet** (Phantom: Settings → Developer Settings → Testnet Mode, then
choose Solana Devnet) and funded from <https://faucet.solana.com>. The demo
asks for about 0.0215 SOL in the wallet, 0.0227 SOL for its first
settlement, and a settlement spends about 0.021 SOL of it. On an iPhone,
open the page inside your wallet app's built-in browser; on Android, Chrome
hands off to an installed wallet app through Mobile Wallet Adapter. Evidence of a successful settlement stays in
your browser's local storage only.

The site is a Vercel project imported from this repository with **Root
Directory** set to `examples/wallet-connect-demo` and the Vite preset; the
small `vercel.json` in that directory only pins `bun install
--frozen-lockfile` so production builds match the committed lockfile (Bun
installs the whole workspace from the member directory). Pushes to `main`
redeploy production through Vercel's Git integration, and pull requests from
this repository get preview deployments (fork PRs need a maintainer to
authorize). The two `VITE_*` variables are optional: without them the build
targets the reference devnet program and the public devnet RPC. A one-off
manual deploy without the Git integration is
`scripts/deploy-wallet-demo.sh <team-scope> [project-name]`; pass the Git
project's name as the second argument to update the hosted URL, otherwise the
script targets its own default project.

## Run locally

```bash
bun install
cp examples/wallet-connect-demo/.env.example \
  examples/wallet-connect-demo/.env.local
bun run demo:wallet
```

Open the printed local URL in a browser with a Solana wallet, switch that
wallet to **devnet**, and fund it from the Solana devnet faucet. Before it asks
for a signature, the demo checks that the wallet holds the 0.020 SOL reference
split, the settlement record's rent, the transaction fee, and the wallet's own
rent-exempt minimum, which stays in the wallet. That is about 0.0215 SOL on
devnet (28 October 2026). The wallet's first settlement also opens its
namespace and pays that account's rent once, about 0.0227 SOL in all. The demo
asks the cluster for each rent figure, so these can change.

The recipient fields are intentionally visible and editable. Public demo
addresses are prefilled so the flow is reproducible; replace them with devnet
addresses you control when recipient balance inspection matters.

## What the wallet signs

The web app calls the SDK's `buildSettlementNTransaction`; it does not maintain
a second instruction codec. The transaction contains:

1. On the wallet's first settlement only, a `CreateNamespace` instruction
   that opens the wallet's own settlement namespace (label
   `synxed-wallet-demo`, with the wallet as creator and authority). Later
   settlements check that it exists and that the wallet is its authority.
2. A structured memo binding the event ID, occurrence time, asset, amount, and
   human-readable description.
3. One `SettleN` instruction using the 35/35/20/10 split, settled in that
   namespace and signed by the wallet as payer and namespace authority.

After the wallet submits the transaction, the app waits for finalized RPC
evidence. `reconcileSettlementN` verifies the RPC genesis hash is devnet,
decodes the instruction, checks the namespace, derives the idempotency record
PDA from it, and compares the
memo, share configuration, accounts, and exact inner transfers. Only a full
match is displayed or saved.

Successful evidence is stored under the versioned browser key
`synxed:settlement-evidence:v2:<signature>`. It contains public devnet data
only and can be cleared through normal browser storage controls.

## Security boundary

- The connected wallet remains the signer; the app never receives its secret
  key.
- Recipient addresses are validated by the shared SDK before wallet approval.
- The demo defaults to the public devnet program and checks the RPC genesis
  hash before wallet approval as well as during reconciliation.
- Choosing Solflare without its extension loads Solflare's hosted wallet UI:
  an iframe from connect.solflare.com, and a solflare.com popup window if you
  pick its web wallet. Both are pinned to devnet. The UI appears when you pick
  Solflare and again on later visits while Solflare is the remembered wallet
  (auto-connect), until you disconnect or close Solflare's dialog. Signing
  happens in Solflare's frame or popup; the demo only ever passes serialized
  transactions out and receives signatures back, never key material.
- System-transfer mode is not available in the browser example because it does
  not provide the program's idempotency record.
- This is a public protocol demonstration, not SYNXED's private attribution,
  fraud, or production payout system.
