// Generate a local devnet payer keypair (no Solana CLI required).
//
// Writes a solana-keygen-compatible JSON array to .keys/payer.json,
// which is gitignored. Never use this keypair on mainnet.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PAYER_FILE = resolve(REPO_ROOT, ".keys/payer.json");

if (existsSync(PAYER_FILE) && !process.argv.includes("--force")) {
  console.error(
    `${PAYER_FILE} already exists. Pass --force to overwrite it ` +
      "(the old key becomes unrecoverable).",
  );
  process.exit(1);
}

const keypair = Keypair.generate();
mkdirSync(dirname(PAYER_FILE), { recursive: true });
writeFileSync(
  PAYER_FILE,
  `${JSON.stringify(Array.from(keypair.secretKey))}\n`,
  { mode: 0o600 },
);

console.log(`Wrote devnet payer keypair to ${PAYER_FILE}`);
console.log(`Public key: ${keypair.publicKey.toBase58()}`);
console.log("");
console.log("Next steps:");
console.log("  1. Fund it with devnet SOL: https://faucet.solana.com");
console.log("     (the demo also tries an RPC airdrop automatically)");
console.log("  2. Add to .env:  SOLANA_PAYER_KEYPAIR=.keys/payer.json");
console.log("  3. Run:          bun run demo");
