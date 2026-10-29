// Configuration from the environment. Keys are read from local files and
// never logged.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export interface StudioConfig {
  rpcUrl: string;
  /** An independent second provider; strongly recommended beyond devnet. */
  secondRpcUrl: string | undefined;
  payer: Keypair;
  /** The namespace authority, when it is not the payer. */
  authority: Keypair | undefined;
  programId: PublicKey;
  namespaceLabel: string;
  /** The pinned namespace address; `run` refuses any other. */
  namespaceAddress: PublicKey | undefined;
  lamportsPerAtomicUnit: bigint;
  databasePath: string;
  maxAttempts: number;
}

function envString(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

function required(name: string): string {
  const value = envString(name);
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInteger(name: string, fallback: string): bigint {
  const raw = envString(name) ?? fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive decimal integer, got "${raw}"`);
  }
  return BigInt(raw);
}

function publicKey(name: string, raw: string): PublicKey {
  try {
    return new PublicKey(raw);
  } catch {
    throw new Error(`${name} is not a valid public key`);
  }
}

export function loadKeypair(name: string, path: string): Keypair {
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${name} must point at a JSON keypair file`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((byte) => Number.isInteger(byte))) {
    throw new Error(`${name} must point at a 64-byte JSON keypair file`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

/** Where the worker's SQLite database lives (gitignored under `.local/`). */
export function databasePath(): string {
  return envString("STUDIO_DB") ?? resolve(REPO_ROOT, ".local/studio-backend.sqlite");
}

export function loadConfig(): StudioConfig {
  const authorityPath = envString("SETTLEMENT_AUTHORITY_KEYPAIR");
  const pinned = envString("SETTLEMENT_NAMESPACE_ADDRESS");
  return {
    rpcUrl: envString("SOLANA_RPC_URL") ?? "https://api.devnet.solana.com",
    secondRpcUrl: envString("SOLANA_SECOND_RPC_URL"),
    payer: loadKeypair("SOLANA_PAYER_KEYPAIR", required("SOLANA_PAYER_KEYPAIR")),
    authority: authorityPath === undefined ? undefined : loadKeypair("SETTLEMENT_AUTHORITY_KEYPAIR", authorityPath),
    programId: publicKey("SETTLEMENT_PROGRAM_ID", required("SETTLEMENT_PROGRAM_ID")),
    namespaceLabel: envString("STUDIO_NAMESPACE") ?? "studio-payouts-devnet",
    namespaceAddress: pinned === undefined ? undefined : publicKey("SETTLEMENT_NAMESPACE_ADDRESS", pinned),
    lamportsPerAtomicUnit: positiveInteger("LAMPORTS_PER_UNIT", "1000"),
    databasePath: databasePath(),
    maxAttempts: Number(positiveInteger("STUDIO_MAX_ATTEMPTS", "5")),
  };
}
