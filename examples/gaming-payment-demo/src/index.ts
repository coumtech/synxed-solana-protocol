// Gaming payment demo: fake audio-ad impression -> deterministic 3-way
// split -> (optionally) a settlement transaction on Solana devnet.
//
// Dry-run by default. Set SOLANA_PAYER_KEYPAIR in .env to submit for real.
// See README.md for the 10-minute walkthrough.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
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

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RECIPIENTS_FILE = resolve(REPO_ROOT, ".keys/demo-recipients.json");

const USD_DECIMALS = 6n;
const AIRDROP_LAMPORTS = 1_000_000_000; // 1 SOL

function envString(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

const DECIMAL_INTEGER = /^[+-]?\d+$/;

function envInt(name: string, fallback: number): number {
  const raw = envString(name);
  if (raw === undefined) {
    return fallback;
  }
  // Strict decimal only: parseInt would silently truncate "3500.9" or
  // accept "35junk", and BigInt would accept hex/binary prefixes.
  if (!DECIMAL_INTEGER.test(raw)) {
    throw new Error(`${name} must be a decimal integer, got "${raw}"`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a decimal integer, got "${raw}"`);
  }
  return parsed;
}

function envBigInt(name: string, fallback: bigint): bigint {
  const raw = envString(name);
  if (raw === undefined) {
    return fallback;
  }
  if (!DECIMAL_INTEGER.test(raw)) {
    throw new Error(`${name} must be a decimal integer, got "${raw}"`);
  }
  return BigInt(raw);
}

interface DemoRecipients {
  artist: string;
  studio: string;
  synxed: string;
}

function isDemoRecipients(value: unknown): value is DemoRecipients {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["artist"] === "string" &&
    typeof record["studio"] === "string" &&
    typeof record["synxed"] === "string"
  );
}

/**
 * Recipient wallets: env overrides win; otherwise generate three demo
 * pubkeys once and reuse them across runs (stored gitignored under .keys/).
 */
function loadRecipients(): DemoRecipients {
  const fromEnv = {
    artist: envString("ARTIST_PUBKEY"),
    studio: envString("STUDIO_PUBKEY"),
    synxed: envString("SYNXED_PUBKEY"),
  };
  if (fromEnv.artist && fromEnv.studio && fromEnv.synxed) {
    return { artist: fromEnv.artist, studio: fromEnv.studio, synxed: fromEnv.synxed };
  }
  if (existsSync(RECIPIENTS_FILE)) {
    const parsed: unknown = JSON.parse(readFileSync(RECIPIENTS_FILE, "utf8"));
    if (isDemoRecipients(parsed)) {
      return parsed;
    }
  }
  const generated: DemoRecipients = {
    artist: Keypair.generate().publicKey.toBase58(),
    studio: Keypair.generate().publicKey.toBase58(),
    synxed: Keypair.generate().publicKey.toBase58(),
  };
  mkdirSync(dirname(RECIPIENTS_FILE), { recursive: true });
  writeFileSync(RECIPIENTS_FILE, `${JSON.stringify(generated, null, 2)}\n`);
  console.log(`Generated demo recipient wallets -> ${RECIPIENTS_FILE}`);
  return generated;
}

function loadPayer(path: string): Keypair {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    !parsed.every(
      (n): n is number =>
        typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255,
    )
  ) {
    throw new Error(
      `${path} is not a 64-byte JSON keypair (solana-keygen format: ` +
        `an array of 64 integers in 0..=255)`,
    );
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function usd(amountAtomic: bigint): string {
  const denominator = 10n ** USD_DECIMALS;
  const whole = amountAtomic / denominator;
  const fraction = (amountAtomic % denominator)
    .toString()
    .padStart(Number(USD_DECIMALS), "0");
  return `$${whole}.${fraction}`;
}

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

async function ensureFunds(
  connection: Connection,
  payer: Keypair,
  neededLamports: bigint,
): Promise<void> {
  const balance = BigInt(await connection.getBalance(payer.publicKey));
  if (balance >= neededLamports) {
    return;
  }
  console.log(
    `Payer balance ${balance} lamports < required ${neededLamports}; requesting devnet airdrop...`,
  );
  try {
    const signature = await connection.requestAirdrop(
      payer.publicKey,
      AIRDROP_LAMPORTS,
    );
    const latest = await connection.getLatestBlockhash();
    await connection.confirmTransaction(
      { signature, ...latest },
      "confirmed",
    );
    console.log("Airdrop confirmed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Devnet airdrop failed (${message}). Fund the payer manually at ` +
        `https://faucet.solana.com — address ${payer.publicKey.toBase58()}`,
    );
  }
  const after = BigInt(await connection.getBalance(payer.publicKey));
  if (after < neededLamports) {
    throw new Error(
      `Balance ${after} lamports still below required ${neededLamports} ` +
        `after airdrop. Fund the payer at https://faucet.solana.com — ` +
        `address ${payer.publicKey.toBase58()}`,
    );
  }
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

  const programIdRaw = envString("SETTLEMENT_PROGRAM_ID");
  let programId: PublicKey | undefined;
  if (programIdRaw !== undefined) {
    try {
      programId = new PublicKey(programIdRaw);
    } catch {
      throw new Error(
        `SETTLEMENT_PROGRAM_ID is not a valid base58 pubkey: "${programIdRaw}"`,
      );
    }
  }

  // Program mode also pays rent for the 41-byte settlement record
  // (~1,176,240 lamports); budget for it plus transaction fees.
  const overhead = programId !== undefined ? 1_200_000n : 1_000_000n;
  await ensureFunds(connection, payer, lamportsTotal + overhead);

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
  for (let i = 0; i < roles.length; i += 1) {
    const role = roles[i] as SettlementRole;
    const lamports = submission.lamportsByRole[i] ?? 0n;
    const share = request.splits[i];
    console.log(
      `  ${role.padEnd(8)} ${lamports.toString().padStart(10)} lamports -> ` +
        `${share?.recipient ?? "?"}`,
    );
  }
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
