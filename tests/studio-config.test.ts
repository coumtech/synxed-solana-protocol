import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { loadConfig } from "../examples/studio-backend/src/config.ts";
import { limitArgument } from "../examples/studio-backend/src/cli.ts";

const KEYS = [
  "SOLANA_RPC_URL",
  "SOLANA_SECOND_RPC_URL",
  "SOLANA_PAYER_KEYPAIR",
  "SETTLEMENT_AUTHORITY_KEYPAIR",
  "SETTLEMENT_PROGRAM_ID",
  "STUDIO_NAMESPACE",
  "SETTLEMENT_NAMESPACE_ADDRESS",
  "LAMPORTS_PER_UNIT",
  "STUDIO_DB",
  "STUDIO_MAX_ATTEMPTS",
] as const;

const saved = new Map(KEYS.map((key) => [key, process.env[key]]));
const directories: string[] = [];

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function clearEnv(): void {
  for (const key of KEYS) {
    delete process.env[key];
  }
}

function keypairFile(bytes: number[] = Array.from(Keypair.generate().secretKey)): string {
  const directory = mkdtempSync(join(tmpdir(), "synxed-studio-config-"));
  directories.push(directory);
  const path = join(directory, "payer.json");
  writeFileSync(path, JSON.stringify(bytes));
  return path;
}

const PROGRAM_ID = "HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT";
const ADDRESS = "4xrJM7aoaSkbmzXRgARZP8WSBzdd1nqrSqk45KJhE7n3";

describe("studio config", () => {
  test("loads the devnet defaults", () => {
    clearEnv();
    process.env.SOLANA_PAYER_KEYPAIR = keypairFile();
    process.env.SETTLEMENT_PROGRAM_ID = PROGRAM_ID;
    const config = loadConfig();
    expect(config.rpcUrl).toBe("https://api.devnet.solana.com");
    expect(config.secondRpcUrl).toBeUndefined();
    expect(config.authority).toBeUndefined();
    expect(config.namespaceLabel).toBe("studio-payouts-devnet");
    expect(config.namespaceAddress).toBeUndefined();
    expect(config.lamportsPerAtomicUnit).toBe(1_000n);
    expect(config.maxAttempts).toBe(5);
    expect(config.databasePath.endsWith(".local/studio-backend.sqlite")).toBe(true);
    expect(config.programId.toBase58()).toBe(PROGRAM_ID);
  });

  test("reads every override", () => {
    clearEnv();
    process.env.SOLANA_PAYER_KEYPAIR = keypairFile();
    process.env.SETTLEMENT_AUTHORITY_KEYPAIR = keypairFile();
    process.env.SETTLEMENT_PROGRAM_ID = PROGRAM_ID;
    process.env.SOLANA_RPC_URL = "https://rpc.example.test";
    process.env.SOLANA_SECOND_RPC_URL = "https://second.example.test";
    process.env.STUDIO_NAMESPACE = "studio-payouts";
    process.env.SETTLEMENT_NAMESPACE_ADDRESS = ADDRESS;
    process.env.LAMPORTS_PER_UNIT = "2000";
    process.env.STUDIO_DB = "/tmp/studio-test.sqlite";
    process.env.STUDIO_MAX_ATTEMPTS = "3";
    const config = loadConfig();
    expect(config.rpcUrl).toBe("https://rpc.example.test");
    expect(config.secondRpcUrl).toBe("https://second.example.test");
    expect(config.authority).toBeDefined();
    expect(config.namespaceLabel).toBe("studio-payouts");
    expect(config.namespaceAddress?.toBase58()).toBe(ADDRESS);
    expect(config.lamportsPerAtomicUnit).toBe(2_000n);
    expect(config.maxAttempts).toBe(3);
    expect(config.databasePath).toBe("/tmp/studio-test.sqlite");
  });

  test("refuses missing or malformed settings", () => {
    clearEnv();
    expect(() => loadConfig()).toThrow("SOLANA_PAYER_KEYPAIR is required");

    process.env.SOLANA_PAYER_KEYPAIR = keypairFile();
    expect(() => loadConfig()).toThrow("SETTLEMENT_PROGRAM_ID is required");

    process.env.SETTLEMENT_PROGRAM_ID = "not-a-key";
    expect(() => loadConfig()).toThrow("SETTLEMENT_PROGRAM_ID is not a valid public key");

    process.env.SETTLEMENT_PROGRAM_ID = PROGRAM_ID;
    process.env.LAMPORTS_PER_UNIT = "0";
    expect(() => loadConfig()).toThrow("LAMPORTS_PER_UNIT must be a positive decimal integer");

    process.env.LAMPORTS_PER_UNIT = "1000";
    process.env.STUDIO_MAX_ATTEMPTS = "two";
    expect(() => loadConfig()).toThrow("STUDIO_MAX_ATTEMPTS must be a positive decimal integer");

    process.env.STUDIO_MAX_ATTEMPTS = "5";
    process.env.SETTLEMENT_NAMESPACE_ADDRESS = "not-a-key";
    expect(() => loadConfig()).toThrow("SETTLEMENT_NAMESPACE_ADDRESS is not a valid public key");
  });

  test("refuses a keypair file that is not 64 bytes", () => {
    clearEnv();
    process.env.SOLANA_PAYER_KEYPAIR = keypairFile([1, 2, 3]);
    process.env.SETTLEMENT_PROGRAM_ID = PROGRAM_ID;
    expect(() => loadConfig()).toThrow("SOLANA_PAYER_KEYPAIR must point at a 64-byte JSON keypair file");
  });

  test("parses the run limit", () => {
    expect(limitArgument(undefined)).toBe(10);
    expect(limitArgument("25")).toBe(25);
    expect(() => limitArgument("0")).toThrow('limit must be a positive integer, got "0"');
    expect(() => limitArgument("1.5")).toThrow('limit must be a positive integer, got "1.5"');
  });
});
