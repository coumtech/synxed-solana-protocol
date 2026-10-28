# @coumtech/synxed-solana-protocol

TypeScript client for the SYNXED Solana settlement protocol: an open source,
Solana native revenue settlement rail for gaming and audio. A billable event,
for example an in-game audio-ad impression, becomes a deterministic revenue
split that is settled on chain in one atomic, idempotent instruction and then
reconciled against finalized chain evidence.

> Devnet only. Not financial advice. Not a token launch.

## Install

```bash
npm install @coumtech/synxed-solana-protocol @solana/web3.js
```

`@solana/web3.js` (1.99 or later in the 1.x line) is a peer dependency, so the
client shares your application's copy. The package is an ES module and needs
Node 22.12 or later (or a modern bundler).

## Settle and reconcile one event

```ts
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DEVNET_RPC_URL,
  computeSettlementN,
  ensureNamespace,
  namespaceIdFromLabel,
  submitSettlementN,
  type SettlementRequestN,
} from "@coumtech/synxed-solana-protocol";
import { assertLedgerCluster, reconcileSettlementN } from "@coumtech/synxed-solana-protocol/ledger";

// Reference devnet deployment. Deploy your own copy to trust exact bytecode.
const programId = new PublicKey("HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT");
const connection = new Connection(DEVNET_RPC_URL, "confirmed");
// A funded devnet keypair kept out of version control. Create one with
// `solana-keygen new --outfile payer.json`, then fund it on devnet.
const secretKey: number[] = JSON.parse(readFileSync("payer.json", "utf8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(secretKey));

const request: SettlementRequestN = {
  eventId: "impression-0001", // one id per billable event; the chain settles it once
  occurredAt: new Date().toISOString(),
  kind: "audio_ad_impression",
  amountAtomic: 20_000n, // $0.020 in micro-dollars
  asset: "SOL_LAMPORTS_STANDIN",
  memo: "audio ad impression",
  shares: [
    { label: "artist", recipient: "<artist wallet>", bps: 3_500 },
    { label: "studio", recipient: "<studio wallet>", bps: 3_500 },
    { label: "synxed", recipient: "<platform wallet>", bps: 2_000 },
    { label: "rewards_pool", recipient: "<pool wallet>", bps: 1_000 },
  ],
};

console.log(computeSettlementN(request).payouts); // integer split, sums to 20_000

await assertLedgerCluster(connection, "devnet");
// Your settlement namespace: opened once, then only its authority (the payer
// here) can settle in it.
const { address: namespace } = await ensureNamespace({
  connection,
  payer,
  programId,
  namespaceId: namespaceIdFromLabel("studio-payouts"),
});
const submission = await submitSettlementN({
  connection,
  payer,
  request,
  programId, // program mode: on-chain split check and per-event idempotency
  namespace,
  lamportsPerAtomicUnit: 1_000n, // native SOL stand-in: 20_000 units = 0.02 SOL
});

const reconciliation = await reconcileSettlementN({
  connection,
  signature: submission.signature,
  programId,
  namespace,
  request,
  unitsPerAtomicUnit: 1_000n,
});
console.log(submission.explorerUrl, reconciliation.record.slot);
```

Passing `programId` and `namespace` selects program mode: the settlement
program checks that the namespace's authority signed, re-validates the split
on chain, pays every share in one instruction, and refuses a second
settlement of the same event id in that namespace. Nobody else can settle
your event ids. Without a program id, the client sends plain system transfers
plus a memo, with no on-chain validation and no idempotency; that fallback
exists for devnet demonstrations only, and reconciliation needs program mode.

`reconcileSettlementN` waits for finality, decodes the instruction, checks the
namespace, derives the event's settlement record, and compares the memo,
shares, accounts, and every inner transfer with the request. Any mismatch
throws a `LedgerError` instead of producing a ledger entry.

## Entry points

| Import | Contents |
| --- | --- |
| `@coumtech/synxed-solana-protocol` | Everything below, plus the split math and instruction codec (`computeSettlementN`, `encodeSettleNData`, `buildSettleNInstruction`, `buildCreateNamespaceInstruction`, `buildSetNamespaceAuthorityInstruction`, `eventIdSeed`, `findNamespacePda`, `findSettlementRecordPda`) |
| `@coumtech/synxed-solana-protocol/types` | Request and result types, protocol constants, `ProtocolError` |
| `@coumtech/synxed-solana-protocol/client` | Transaction builders and submitters, including SPL Token settlement, namespace helpers (`ensureNamespace`, `fetchNamespace`, `findNamespacePda`, `namespaceIdFromLabel`), `fetchSettlementRecord`, and `fetchLegacySettlementRecord` for events settled before namespaces |
| `@coumtech/synxed-solana-protocol/ledger` | Payout ledger types, reconciliation, pool allocation, and `findSettlementTransaction` / `findLegacySettlementTransaction` for the transaction that created a record |

Unsigned builders such as `buildSettlementNTransaction` return a transaction
for a browser or hardware wallet to sign.

## Guarantees

- **Exact integer splits.** Basis points must sum to 10000; payouts always sum
  to the gross amount. Invalid splits are rejected, never renormalized.
- **Only you settle your events.** In program mode every settlement runs in
  your namespace, which only its authority can settle in.
- **Per-event idempotency.** In program mode the chain refuses to settle the
  same event id twice in a namespace.
- **Atomic settlement.** In program mode one instruction pays every share or
  the whole transaction reverts.

## Documentation

The protocol specification, integration guide, payout ledger design, SPL
stablecoin settlement, and verified-build instructions live in the
repository: <https://github.com/coumtech/synxed-solana-protocol>.

## License

Apache 2.0 © Coum Technologies Ltd.
