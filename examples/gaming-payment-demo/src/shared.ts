// Helpers shared by the demo entry points: env parsing, local keys, and
// devnet funding. Nothing here is protocol logic.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

export const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
export const RECIPIENTS_FILE = resolve(REPO_ROOT, ".keys/demo-recipients.json");

const USD_DECIMALS = 6n;
const AIRDROP_LAMPORTS = 1_000_000_000; // 1 SOL
const DECIMAL_INTEGER = /^[+-]?\d+$/;

export function envString(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

export function envInt(name: string, fallback: number): number {
  const raw = envString(name);
  if (raw === undefined) {
    return fallback;
  }
  return parseDecimalInt(name, raw);
}

export function envBigInt(name: string, fallback: bigint): bigint {
  const raw = envString(name);
  if (raw === undefined) {
    return fallback;
  }
  if (!DECIMAL_INTEGER.test(raw)) {
    throw new Error(`${name} must be a decimal integer, got "${raw}"`);
  }
  return BigInt(raw);
}

/** Comma-separated decimal integers, e.g. `NWAY_BPS=3500,3500,2000,1000`. */
export function envIntList(name: string, fallback: readonly number[]): number[] {
  const raw = envString(name);
  if (raw === undefined) {
    return [...fallback];
  }
  return raw.split(",").map((item) => parseDecimalInt(name, item.trim()));
}

/** Comma-separated labels, e.g. `NWAY_LABELS=artist,studio,synxed,rewards_pool`. */
export function envStringList(
  name: string,
  fallback: readonly string[],
): string[] {
  const raw = envString(name);
  if (raw === undefined) {
    return [...fallback];
  }
  return raw.split(",").map((item) => item.trim());
}

function parseDecimalInt(name: string, raw: string): number {
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

export interface DemoRecipients {
  artist: string;
  studio: string;
  synxed: string;
  rewardsPool?: string;
}

function isDemoRecipients(value: unknown): value is DemoRecipients {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const pool = record["rewardsPool"];
  return (
    typeof record["artist"] === "string" &&
    typeof record["studio"] === "string" &&
    typeof record["synxed"] === "string" &&
    (pool === undefined || typeof pool === "string")
  );
}

/**
 * Recipient wallets: env overrides win; otherwise demo pubkeys are generated
 * once and reused across runs (stored gitignored under .keys/). Pass
 * `withRewardsPool` to make sure a pool wallet exists too.
 */
export function loadRecipients(withRewardsPool = false): DemoRecipients {
  const fromEnv = {
    artist: envString("ARTIST_PUBKEY"),
    studio: envString("STUDIO_PUBKEY"),
    synxed: envString("SYNXED_PUBKEY"),
    rewardsPool: envString("REWARDS_POOL_PUBKEY"),
  };
  if (
    fromEnv.artist &&
    fromEnv.studio &&
    fromEnv.synxed &&
    (!withRewardsPool || fromEnv.rewardsPool)
  ) {
    return {
      artist: fromEnv.artist,
      studio: fromEnv.studio,
      synxed: fromEnv.synxed,
      ...(fromEnv.rewardsPool !== undefined
        ? { rewardsPool: fromEnv.rewardsPool }
        : {}),
    };
  }

  let stored: DemoRecipients | undefined;
  if (existsSync(RECIPIENTS_FILE)) {
    const parsed: unknown = JSON.parse(readFileSync(RECIPIENTS_FILE, "utf8"));
    if (isDemoRecipients(parsed)) {
      stored = parsed;
    }
  }
  const recipients: DemoRecipients = stored ?? {
    artist: Keypair.generate().publicKey.toBase58(),
    studio: Keypair.generate().publicKey.toBase58(),
    synxed: Keypair.generate().publicKey.toBase58(),
  };
  let changed = stored === undefined;
  if (withRewardsPool && recipients.rewardsPool === undefined) {
    recipients.rewardsPool = Keypair.generate().publicKey.toBase58();
    changed = true;
  }
  if (changed) {
    mkdirSync(dirname(RECIPIENTS_FILE), { recursive: true });
    writeFileSync(RECIPIENTS_FILE, `${JSON.stringify(recipients, null, 2)}\n`);
    console.log(`Updated demo recipient wallets -> ${RECIPIENTS_FILE}`);
  }
  return recipients;
}

export function loadPayer(path: string): Keypair {
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

export function usd(amountAtomic: bigint): string {
  const denominator = 10n ** USD_DECIMALS;
  const whole = amountAtomic / denominator;
  const fraction = (amountAtomic % denominator)
    .toString()
    .padStart(Number(USD_DECIMALS), "0");
  return `$${whole}.${fraction}`;
}

/** Parse SETTLEMENT_PROGRAM_ID, or undefined for system-transfer mode. */
export function parseProgramId(): PublicKey | undefined {
  const raw = envString("SETTLEMENT_PROGRAM_ID");
  if (raw === undefined) {
    return undefined;
  }
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`SETTLEMENT_PROGRAM_ID is not a valid base58 pubkey: "${raw}"`);
  }
}

/**
 * Lamports to keep on top of the settlement itself: program mode also pays
 * rent for the 41-byte settlement record (~1,176,240 lamports) plus fees.
 */
export function fundingOverhead(programId: PublicKey | undefined): bigint {
  return programId !== undefined ? 1_200_000n : 1_000_000n;
}

export async function ensureFunds(
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
