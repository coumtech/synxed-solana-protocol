// N-way variant of the gaming payment demo: the same fake audio-ad
// impression split across configurable shares via the `SettleN`
// instruction. The default adds a fourth share, a listener rewards pool:
//   artist 35% / studio 35% / synxed 20% / rewards_pool 10%
//
// Dry-run by default; set SOLANA_PAYER_KEYPAIR in .env to submit.

import { resolve } from "node:path";
import { Connection, Keypair } from "@solana/web3.js";
import {
  APPROX_RENT_EXEMPT_MIN_LAMPORTS,
  DEVNET_RPC_URL,
  computeSettlementN,
  explorerAddressUrl,
  splitAmountAtomicShares,
  submitSettlementN,
  type SettlementRequestN,
  type ShareInput,
  type SplitResultN,
} from "@coumtech/synxed-solana-protocol";
import { fakeAudioAdImpression } from "./event.ts";
import {
  REPO_ROOT,
  ensureFunds,
  envBigInt,
  envIntList,
  envString,
  envStringList,
  fundingOverhead,
  loadPayer,
  loadRecipients,
  parseProgramId,
  usd,
  type DemoRecipients,
} from "./shared.ts";

const DEFAULT_LABELS = ["artist", "studio", "synxed", "rewards_pool"] as const;
const DEFAULT_BPS = [3_500, 3_500, 2_000, 1_000] as const;

/**
 * Map a share label to a wallet. The four built-in labels use the demo
 * wallets; any other label must name its wallet via `<LABEL>_PUBKEY`
 * (upper-cased, e.g. `CHARITY_PUBKEY`) so funds never go to an address
 * nobody controls.
 */
function recipientFor(label: string, recipients: DemoRecipients): string {
  switch (label) {
    case "artist":
      return recipients.artist;
    case "studio":
      return recipients.studio;
    case "synxed":
      return recipients.synxed;
    case "rewards_pool":
      return recipients.rewardsPool ?? Keypair.generate().publicKey.toBase58();
    default: {
      const envName = `${label.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_PUBKEY`;
      const configured = envString(envName);
      if (configured === undefined) {
        throw new Error(
          `share "${label}" has no wallet: set ${envName} in .env ` +
            "(refusing to pay a label nobody controls)",
        );
      }
      return configured;
    }
  }
}

function printSplitTable(result: SplitResultN): void {
  console.log("\nDeterministic revenue split (N-way)");
  console.log("  share          bps    amount (atomic)   amount (USD)");
  for (const payout of result.payouts) {
    console.log(
      `  ${payout.label.padEnd(14)} ${String(payout.bps).padStart(5)}  ` +
        `${payout.amountAtomic.toString().padStart(15)}   ${usd(payout.amountAtomic)}`,
    );
  }
  console.log(
    `  ${"total".padEnd(14)} ${"10000".padStart(5)}  ` +
      `${result.totalAtomic.toString().padStart(15)}   ${usd(result.totalAtomic)}`,
  );
}

async function main(): Promise<void> {
  const impression = fakeAudioAdImpression();
  console.log("Audio-ad impression (simulated)");
  console.log(`  event    ${impression.eventId}`);
  console.log(`  at       ${impression.occurredAt}`);
  console.log(`  game     ${impression.gameTitle}`);
  console.log(
    `  track    "${impression.trackTitle}" by ${impression.artistName}`,
  );

  const labels = envStringList("NWAY_LABELS", DEFAULT_LABELS);
  const bps = envIntList("NWAY_BPS", DEFAULT_BPS);
  if (labels.length !== bps.length) {
    throw new Error(
      `NWAY_LABELS has ${labels.length} entries but NWAY_BPS has ${bps.length}`,
    );
  }
  const recipients = loadRecipients(labels.includes("rewards_pool"));
  const shares: ShareInput[] = labels.map((label, i) => ({
    label,
    recipient: recipientFor(label, recipients),
    bps: bps[i],
  }));
  const amountAtomic = envBigInt("AMOUNT_ATOMIC", 20_000n);
  const request: SettlementRequestN = {
    eventId: impression.eventId,
    occurredAt: impression.occurredAt,
    kind: "audio_ad_impression",
    amountAtomic,
    asset: "SOL_LAMPORTS_STANDIN",
    shares,
    memo: `audio ad in ${impression.gameTitle} (${shares.length}-way)`,
  };

  const result = computeSettlementN(request);
  printSplitTable(result);

  const payerPath = envString("SOLANA_PAYER_KEYPAIR");
  if (payerPath === undefined) {
    console.log(
      "\nDry run complete (no transaction submitted)." +
        "\nSet SOLANA_PAYER_KEYPAIR in .env (see bun run demo:keygen) to settle on devnet.",
    );
    return;
  }

  const payer = loadPayer(resolve(REPO_ROOT, payerPath));
  const rpcUrl = envString("SOLANA_RPC_URL") ?? DEVNET_RPC_URL;
  const connection = new Connection(rpcUrl, "confirmed");
  const scale = envBigInt("LAMPORTS_PER_UNIT", 1_000n);
  if (scale <= 0n) {
    throw new Error(`LAMPORTS_PER_UNIT must be positive, got ${scale}`);
  }
  const lamportsTotal = amountAtomic * scale;
  const nonzero = splitAmountAtomicShares(lamportsTotal, bps).filter(
    (share) => share > 0n,
  );
  const smallest = nonzero.reduce((min, share) => (share < min ? share : min));
  if (smallest < APPROX_RENT_EXEMPT_MIN_LAMPORTS) {
    console.log(
      `\nNote: small payouts may fail rent-exemption for brand-new accounts ` +
        `(~${APPROX_RENT_EXEMPT_MIN_LAMPORTS} lamports minimum). ` +
        `Raise LAMPORTS_PER_UNIT if the transfer is rejected.`,
    );
  }

  const programId = parseProgramId();
  await ensureFunds(connection, payer, lamportsTotal + fundingOverhead(programId));

  const submission = await submitSettlementN({
    connection,
    payer,
    request,
    lamportsPerAtomicUnit: scale,
    ...(programId !== undefined ? { programId } : {}),
  });

  console.log(`\nSettled on devnet (${submission.mode} mode, ${shares.length}-way)`);
  console.log(`  total     ${submission.lamportsTotal} lamports`);
  shares.forEach((share, i) => {
    const lamports = submission.lamportsByShare[i];
    console.log(
      `  ${share.label.padEnd(14)} ${lamports.toString().padStart(10)} lamports -> ` +
        `${share.recipient}`,
    );
  });
  console.log(`  signature ${submission.signature}`);
  console.log(`  explorer  ${submission.explorerUrl}`);
  console.log(
    `  payer     ${explorerAddressUrl(payer.publicKey.toBase58())}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
