# Demo script (1–2 minutes)

A walkthrough for recording or presenting the protocol live. Timings are
approximate; the whole thing fits in two minutes with the network calls.

## Before recording

```bash
bun install
bun run demo:keygen          # once; prints a devnet address
```

Fund the printed address with devnet SOL (https://faucet.solana.com), then
put these in `.env`:

```
SOLANA_PAYER_KEYPAIR=.keys/payer.json
SETTLEMENT_PROGRAM_ID=HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT
```

Have a browser tab open on https://explorer.solana.com with the cluster
set to devnet.

## Script

**0:00 — The problem (one sentence).**
"When a game plays a sponsored track, three parties are owed money: the
artist, the studio, and the platform. This settles that on Solana, exactly,
in one transaction."

**0:15 — Run the tests.**
```bash
bun test
```
Point at the count: split math, instruction byte layout, and client guards
— invalid splits are rejected, never rounded into shape.

**0:30 — Dry run.**
```bash
bun run demo
```
Read the table aloud: $0.020 impression, 35 / 40 / 25, and the total line.
"Every atomic unit is accounted for; rounding dust goes to the last share,
and that rule is documented."

**0:50 — Settle it for real.**
Set `SOLANA_PAYER_KEYPAIR` (already in `.env`) and run the demo again.
Wait for the `Settled on devnet (program mode)` block. Copy the
`explorer` URL into the browser.

**1:15 — Show the transaction.**
In Explorer, scroll to the instruction list: the memo, then the settlement
program instruction with its inner transfers — one to each wallet, amounts
matching the table. Point at the inner `Transfer`, `Allocate`, `Assign`
trio that builds the record account: "that's the idempotency record; this
event can never be paid twice."

**1:40 — Close.**
"Open source, Apache 2.0, devnet only. The platform that decides *what* is
billable stays private; this is the public rail that settles it." Show the
README's architecture diagram if there's time.

## If something fails on camera

- Airdrop rate-limited: the demo makes one airdrop attempt, then stops with
  the faucet URL and your address. Fund from the web faucet and rerun.
- `SETTLEMENT_PROGRAM_ID` unset: the demo falls back to system transfers —
  still a real transaction, just without the on-chain record. Say so.
- Explorer slow to index: the signature is printed; search it directly.
