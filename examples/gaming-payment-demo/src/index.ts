// Gaming payment demo: fake audio-ad impression -> deterministic 3-way
// split -> (optionally) a settlement transaction on Solana devnet.
//
// Dry-run by default. Set SOLANA_PAYER_KEYPAIR in .env to submit for real.
// See README.md for the 10-minute walkthrough, and nway.ts for the N-way
// variant with a listener rewards pool share.

import { resolve } from "node:path";
import { Connection } from "@solana/web3.js";
import {
  APPROX_RENT_EXEMPT_MIN_LAMPORTS,
  DEFAULT_ARTIST_BPS,
  DEFAULT_STUDIO_BPS,
  DEFAULT_SYNXED_BPS,
  DEVNET_RPC_URL,
  computeSettlement,
  explorerAddressUrl,
  splitAmountAtomic,
  submitSettlement,
  type SettlementRequest,
  type SettlementRole,
  type SplitResult,
} from "@coumtech/synxed-solana-protocol";
import { fakeAudioAdImpression } from "./event.ts";
import {
  REPO_ROOT,
  ensureFunds,
  envBigInt,
  envInt,
  envString,
  fundingOverhead,
  loadPayer,
  loadRecipients,
  parseProgramId,
  usd,
} from "./shared.ts";

function printSplitTable(result: SplitResult): void {
  console.log("\nDeterministic revenue split");
  console.log("  role     bps    amount (atomic)   amount (USD)");
  for (const payout of result.payouts) {
    console.log(
      `  ${payout.role.padEnd(8)} ${String(payout.bps).padStart(5)}  ` +
        `${payout.amountAtomic.toString().padStart(15)}   ${usd(payout.amountAtomic)}`,
    );
  }
  console.log(
    `  ${"total".padEnd(8)} ${"10000".padStart(5)}  ` +
      `${result.totalAtomic.toString().padStart(15)}   ${usd(result.totalAtomic)}`,
  );
}

async function main(): Promise<void> {
  // 1. A game/simulator emits a billable audio-ad impression (fake here).
  const impression = fakeAudioAdImpression();
  console.log("Audio-ad impression (simulated)");
  console.log(`  event    ${impression.eventId}`);
  console.log(`  at       ${impression.occurredAt}`);
  console.log(`  game     ${impression.gameTitle}`);
  console.log(
    `  track    "${impression.trackTitle}" by ${impression.artistName}`,
  );

  // 2. Build the SettlementRequest this protocol settles.
  const amountAtomic = envBigInt("AMOUNT_ATOMIC", 20_000n);
  const recipients = loadRecipients();
  const request: SettlementRequest = {
    eventId: impression.eventId,
    occurredAt: impression.occurredAt,
    kind: "audio_ad_impression",
    amountAtomic,
    asset: "SOL_LAMPORTS_STANDIN",
    splits: [
      {
        role: "artist",
        recipient: recipients.artist,
        bps: envInt("ARTIST_BPS", DEFAULT_ARTIST_BPS),
      },
      {
        role: "studio",
        recipient: recipients.studio,
        bps: envInt("STUDIO_BPS", DEFAULT_STUDIO_BPS),
      },
      {
        role: "synxed",
        recipient: recipients.synxed,
        bps: envInt("SYNXED_BPS", DEFAULT_SYNXED_BPS),
      },
    ],
    memo: `audio ad in ${impression.gameTitle}`,
  };

  // 3. Deterministic split (throws on any invalid configuration).
  const result = computeSettlement(request);
  printSplitTable(result);

  // 4. Settle on devnet, or stop at the dry-run boundary.
  const payerPath = envString("SOLANA_PAYER_KEYPAIR");
  if (payerPath === undefined) {
    console.log(
      "\nDry run complete (no transaction submitted)." +
        "\nTo settle on devnet: bun run demo:keygen, fund the printed address," +
        "\nthen set SOLANA_PAYER_KEYPAIR in .env and rerun bun run demo.",
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
  // Zero-lamport shares are skipped entirely, so only nonzero payouts can
  // hit the rent-exemption floor for brand-new recipient accounts.
  const smallestNonzeroShare = splitAmountAtomic(lamportsTotal, request.splits)
    .filter((share) => share > 0n)
    .reduce((min, share) => (share < min ? share : min));
  if (smallestNonzeroShare < APPROX_RENT_EXEMPT_MIN_LAMPORTS) {
    console.log(
      `\nNote: small payouts may fail rent-exemption for brand-new accounts ` +
        `(~${APPROX_RENT_EXEMPT_MIN_LAMPORTS} lamports minimum). ` +
        `Raise LAMPORTS_PER_UNIT if the transfer is rejected.`,
    );
  }

  const programId = parseProgramId();
  await ensureFunds(connection, payer, lamportsTotal + fundingOverhead(programId));

  const submission = await submitSettlement({
    connection,
    payer,
    request,
    lamportsPerAtomicUnit: scale,
    ...(programId !== undefined ? { programId } : {}),
  });

  console.log(`\nSettled on devnet (${submission.mode} mode)`);
  console.log(`  total     ${submission.lamportsTotal} lamports`);
  const roles: readonly SettlementRole[] = ["artist", "studio", "synxed"];
  roles.forEach((role, i) => {
    const lamports = submission.lamportsByRole[i];
    const share = request.splits[i];
    console.log(
      `  ${role.padEnd(8)} ${lamports.toString().padStart(10)} lamports -> ` +
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
