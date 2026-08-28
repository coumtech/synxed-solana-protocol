# Integration guide

How a game studio (or any app) settles revenue events with this protocol
using only the public code in this repository.

## 1. Construct a `SettlementRequest`

Your app decides when an event is billable. This protocol only needs the
result:

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

> The SDK is consumed from source in this repository (Bun and modern
> bundlers run TypeScript directly). It is not published to npm yet; vendor
> `sdk/typescript/src` or import it as a workspace package.

## 2. Compute (and display) the split

```ts
const result = computeSettlement(request);
// result.payouts -> [{ role: "artist", amountAtomic: 7000n, ... }, ...]
```

`computeSettlement` throws a typed `ProtocolError` on any invalid split —
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
  // programId: new PublicKey("...") — optional, see "Program mode"
});
console.log(submission.explorerUrl);
```

- **Scaling:** amounts are modeled as 6-decimal micro-dollars but settled in
  SOL lamports on devnet. `lamportsPerAtomicUnit` (default `1`) converts
  between the two. Keep each recipient's share above the ~`890880` lamport
  rent-exempt minimum or transfers to brand-new accounts will fail.
- **Fallback mode (default):** three `SystemProgram` transfers plus a memo.
  No deployment needed.
- **Program mode:** pass `programId` and the client sends a single `Settle`
  instruction; the program re-validates the split on-chain, writes the
  idempotency record, and pays all three recipients atomically.

## 4. Deploying the program (optional, for program mode)

A reference deployment is live on devnet and can be used directly:

```
SETTLEMENT_PROGRAM_ID=HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT
```

To deploy your own copy you need the
[Solana CLI tools](https://docs.solana.com/cli/install) with
`cargo build-sbf` (plus `rustup`, which `cargo build-sbf` uses to link its
toolchain):

```bash
cargo build-sbf --manifest-path programs/synxed-settlement/Cargo.toml --features onchain
solana program deploy target/deploy/synxed_settlement.so --url devnet
```

Put the printed program id in `.env` as `SETTLEMENT_PROGRAM_ID`. Deploy
keys are yours; never commit them.

## 5. Operational notes

- Use one `eventId` per billable event. In program mode the chain rejects a
  second settlement of the same id (`AccountAlreadyInitialized`).
- Recipients are plain system accounts (wallet pubkeys). They do not need
  to sign.
- Fund the payer with devnet SOL: the demo attempts an RPC airdrop, and
  https://faucet.solana.com works when the RPC faucet is rate-limited.
- Everything here is devnet-only. Do not point the client at mainnet.

## Reference: the runnable example

`examples/gaming-payment-demo` wires all of the above into a CLI:
fake impression -> `SettlementRequest` -> split table -> devnet transaction
-> Explorer link. Reading its `src/index.ts` top to bottom is the fastest
way to see the full integration surface.
