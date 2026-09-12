# Wallet-connect settlement demo

The Phase 2 browser example uses Solana Wallet Adapter and automatically
discovers installed Wallet Standard wallets. It does not ship a private key,
custody funds, or request mainnet access.

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
- System-transfer mode is not available in the browser example because it does
  not provide the program's idempotency record.
- This is a public protocol demonstration, not SYNXED's private attribution,
  fraud, or production payout system.
