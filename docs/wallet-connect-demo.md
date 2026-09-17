# Wallet-connect settlement demo

The open-source browser example uses Solana Wallet Adapter and automatically
discovers installed Wallet Standard wallets. Phantom and Solflare are also
registered as fallback entries so the picker is never empty. With no wallet
installed it still lists both: choosing Phantom turns the header button into
**Connect**, and pressing it opens phantom.app (the page says so); choosing
Solflare opens Solflare's hosted web wallet inside the page, pinned to devnet.
On Android mobile web the picker also offers Mobile Wallet Adapter, which hands
off to an installed wallet app. An installed wallet of the same name replaces
its fallback entry. The example does not ship a private key, custody funds, or
request mainnet access.

## Hosted demo

A build of `main` is hosted at
<https://synxed-solana-protocol-wallet-conne.vercel.app/>. It targets the
reference devnet program and the public devnet RPC; nothing in the bundle is
secret. To use it you need a Wallet Standard browser wallet (Phantom, Solflare,
and others) switched to **devnet** (Phantom: Settings → Developer Settings →
Testnet Mode, then choose Solana Devnet) and funded from <https://faucet.solana.com> (about 0.022 SOL is
spent per settlement). On an iPhone, open the page inside your wallet app's
built-in browser; on Android, Chrome hands off to an installed wallet app
through Mobile Wallet Adapter. Evidence of a successful settlement stays in
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
wallet to **devnet**, and fund it from the Solana devnet faucet. The example
requires approximately 0.022 SOL: 0.020 SOL for the reference split, settlement
record rent, and the transaction fee.

The recipient fields are intentionally visible and editable. Public demo
addresses are prefilled so the flow is reproducible; replace them with devnet
addresses you control when recipient balance inspection matters.

## What the wallet signs

The web app calls the SDK's `buildSettlementNTransaction`; it does not maintain
a second instruction codec. The transaction contains:

1. A structured memo binding the event ID, occurrence time, asset, amount, and
   human-readable description.
2. One `SettleN` instruction using the 35/35/20/10 split.

After the wallet submits the transaction, the app waits for finalized RPC
evidence. `reconcileSettlementN` verifies the RPC genesis hash is devnet,
decodes the instruction, derives the idempotency record PDA, and compares the
memo, share configuration, accounts, and exact inner transfers. Only a full
match is displayed or saved.

Successful evidence is stored under the versioned browser key
`synxed:settlement-evidence:v1:<signature>`. It contains public devnet data
only and can be cleared through normal browser storage controls.

## Security boundary

- The connected wallet remains the signer; the app never receives its secret
  key.
- Recipient addresses are validated by the shared SDK before wallet approval.
- The demo defaults to the public devnet program and checks the RPC genesis
  hash before wallet approval as well as during reconciliation.
- Choosing Solflare without its extension embeds Solflare's hosted wallet UI
  (connect.solflare.com) in the page. It appears only after you pick it, is
  configured for devnet, and signs inside Solflare's own frame; the demo never
  sees key material.
- System-transfer mode is not available in the browser example because it does
  not provide the program's idempotency record.
- This is a public protocol demonstration, not SYNXED's private attribution,
  fraud, or production payout system.
