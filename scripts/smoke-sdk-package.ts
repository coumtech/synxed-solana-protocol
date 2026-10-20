/**
 * Proves the npm package works for a project outside this repository.
 *
 * 1. Builds sdk/typescript/dist/package (scripts/build-sdk-package.ts) and
 *    packs it with `npm pack`, exactly as `npm publish` would. With
 *    SYNXED_SDK_TARBALL=<path>, skips this and tests that tarball instead,
 *    which must match this checkout's package name and version (the publish
 *    workflow uses this to test the exact file it publishes).
 * 2. Checks the tarball's file list against an allowlist.
 * 3. Installs the tarball into a fresh Node project next to the peer
 *    dependency, with install scripts disabled.
 * 4. Runs the installed package under Node and compares its results with the
 *    same calls made against the TypeScript sources, plus the golden bytes the
 *    Rust program tests also use.
 * 5. Type-checks a TypeScript consumer, and the example in the package
 *    README, with Node and with bundler module resolution.
 *
 * Usage: bun run smoke:sdk   (set SYNXED_KEEP_SMOKE=1 to keep the temp dir)
 *        SYNXED_SDK_TARBALL=path/to/package.tgz bun run smoke:sdk
 * Needs network access to the npm registry for step 3.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import {
  computeSettlementN,
  encodeSettleNData,
  eventIdSeed,
  findSettlementRecordPda,
} from "../sdk/typescript/src/index.ts";
import { explorerTxUrl } from "../sdk/typescript/src/client.ts";
import { ledgerEntryId } from "../sdk/typescript/src/ledger.ts";
import {
  ALLOWED_PACKAGE_FILE,
  PACKAGE_DIR,
  REPO_ROOT,
  SDK_DIR,
  buildSdkPackage,
  readWorkspaceManifest,
} from "./build-sdk-package.ts";

const REQUIRED_FILES = ["package.json", "README.md", "LICENSE", "index.js", "index.d.ts", "index.js.map", "client.js", "ledger.js", "types.js"];
/** Network installs get this long before the smoke test gives up. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Any valid program id works for these offline checks; the reference devnet
 * deployment's id is used so derived addresses match the documentation.
 */
const REFERENCE_PROGRAM_ID = "HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT";
const EVENT_ID = "smoke-event-1";
const SHARES = [
  { label: "artist", bps: 3_500 },
  { label: "studio", bps: 3_500 },
  { label: "synxed", bps: 2_000 },
  { label: "rewards_pool", bps: 1_000 },
] as const;

function fail(message: string): never {
  throw new Error(`smoke-sdk-package: ${message}`);
}

function run(command: string, args: readonly string[], cwd: string, timeout = INSTALL_TIMEOUT_MS): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    const reason = result.error?.message ?? `exit ${result.status ?? result.signal ?? "unknown"}`;
    fail(`${command} ${args.join(" ")} failed: ${reason}`);
  }
  return result.stdout;
}

function stringField(value: unknown, field: string, what: string): string {
  if (typeof value === "object" && value !== null && field in value) {
    const fieldValue: unknown = Reflect.get(value, field);
    if (typeof fieldValue === "string") {
      return fieldValue;
    }
  }
  return fail(`${what} has no string "${field}"`);
}

function installedVersion(name: string): string {
  const parsed: unknown = JSON.parse(
    readFileSync(join(REPO_ROOT, "node_modules", name, "package.json"), "utf8"),
  );
  if (typeof parsed === "object" && parsed !== null && "version" in parsed && typeof parsed.version === "string") {
    return parsed.version;
  }
  return fail(`cannot read the installed version of ${name}`);
}

/** Deterministic recipient addresses, one per share, so source and package see identical inputs. */
const RECIPIENTS: readonly string[] = SHARES.map(({ label }) =>
  PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(label)],
    new PublicKey(REFERENCE_PROGRAM_ID),
  )[0].toBase58(),
);

/** The same calls the Node consumer makes, answered by the TypeScript sources. */
function expectedFromSource(): Record<string, unknown> {
  const seed = eventIdSeed(EVENT_ID);
  const split = computeSettlementN({
    eventId: EVENT_ID,
    occurredAt: "2026-01-01T00:00:00.000Z",
    kind: "audio_ad_impression",
    amountAtomic: 20_000n,
    asset: "SOL_LAMPORTS_STANDIN",
    shares: SHARES.map((share, i) => ({ ...share, recipient: RECIPIENTS[i] ?? fail("missing recipient") })),
    memo: "smoke",
  });
  return {
    seedHex: Buffer.from(seed).toString("hex"),
    dataHex: Buffer.from(encodeSettleNData({ eventSeed: seed, amount: 20_000n, bps: SHARES.map((s) => s.bps) })).toString("hex"),
    payouts: split.payouts.map((p) => [p.label, p.recipient, p.amountAtomic.toString()]),
    record: findSettlementRecordPda(new PublicKey(REFERENCE_PROGRAM_ID), seed)[0].toBase58(),
    entryId: ledgerEntryId("smoke-signature", "artist", "artist:1"),
    explorer: explorerTxUrl("smoke-signature"),
  };
}

const CONSUMER_MJS = `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import * as sdk from "@coumtech/synxed-solana-protocol";
import * as client from "@coumtech/synxed-solana-protocol/client";
import * as ledger from "@coumtech/synxed-solana-protocol/ledger";
import * as types from "@coumtech/synxed-solana-protocol/types";
import manifest from "@coumtech/synxed-solana-protocol/package.json" with { type: "json" };

const input = JSON.parse(readFileSync("./input.json", "utf8"));
const expected = input.expected;
const programId = new PublicKey(input.programId);
const recipients = input.recipients.map((r) => new PublicKey(r));

// The SettleN golden vector, written out independently here; the same bytes are
// asserted by tests/instruction-n.test.ts and the Rust codec tests.
const fixed = Uint8Array.from({ length: 32 }, (_, i) => i);
const golden = sdk.encodeSettleNData({ eventSeed: fixed, amount: 20000n, bps: [3500, 3500, 2000, 1000] });
assert.deepEqual(Array.from(golden), [1, ...fixed, 0x20, 0x4e, 0, 0, 0, 0, 0, 0, 4, 0xac, 0x0d, 0xac, 0x0d, 0xd0, 0x07, 0xe8, 0x03]);

// Same answers as the TypeScript sources.
const seed = sdk.eventIdSeed(input.eventId);
const hex = (bytes) => Buffer.from(bytes).toString("hex");
assert.equal(hex(seed), expected.seedHex);
assert.equal(hex(sdk.encodeSettleNData({ eventSeed: seed, amount: 20000n, bps: input.bps })), expected.dataHex);
const split = sdk.computeSettlementN({
  eventId: input.eventId,
  occurredAt: "2026-01-01T00:00:00.000Z",
  kind: "audio_ad_impression",
  amountAtomic: 20000n,
  asset: "SOL_LAMPORTS_STANDIN",
  shares: input.labels.map((label, i) => ({ label, bps: input.bps[i], recipient: input.recipients[i] })),
  memo: "smoke",
});
assert.deepEqual(split.payouts.map((p) => [p.label, p.recipient, p.amountAtomic.toString()]), expected.payouts);
assert.equal(split.totalAtomic, 20000n);
assert.equal(sdk.findSettlementRecordPda(programId, seed)[0].toBase58(), expected.record);
assert.equal(ledger.ledgerEntryId("smoke-signature", "artist", "artist:1"), expected.entryId);
assert.equal(client.explorerTxUrl("smoke-signature"), expected.explorer);

// The package's PublicKey objects are the consumer's class. This catches a
// second web3.js copy at a different version; a same-version regular
// dependency would be deduped by npm, so the manifest checks below are what
// pin web3.js as a peer dependency.
const ix = sdk.buildSettleNInstruction({ programId, payer: recipients[0], recipients }, { eventSeed: seed, amount: 20000n, bps: input.bps });
const systemKey = ix.keys.at(-1).pubkey;
assert.ok(systemKey instanceof PublicKey, "package returned a PublicKey from a different @solana/web3.js copy");
assert.ok(systemKey.equals(SystemProgram.programId));
assert.ok(sdk.findSettlementRecordPda(programId, seed)[0] instanceof PublicKey);

// Subpath entry points share module instances with the root entry point.
assert.equal(client.submitSettlementN, sdk.submitSettlementN);
assert.equal(ledger.reconcileSettlementN, sdk.reconcileSettlementN);
assert.equal(types.ProtocolError, sdk.ProtocolError);

// Typed errors survive the build.
assert.throws(() => sdk.encodeSettleNData({ eventSeed: fixed, amount: 1n, bps: [] }), (e) => e instanceof sdk.ProtocolError);

assert.equal(manifest.name, input.name);
assert.equal(manifest.version, input.version);
assert.ok(manifest.peerDependencies["@solana/web3.js"], "web3.js must be a peer dependency");
assert.equal(manifest.dependencies["@solana/web3.js"], undefined, "web3.js must not be a regular dependency");
assert.equal(manifest.private, undefined);
assert.equal(manifest.engines.node, input.engines);
assert.deepEqual(Object.keys(manifest.exports["."]), ["types", "default"], "types must come first");

// Source maps carry the original sources, since src/ is not shipped.
const map = JSON.parse(readFileSync("./node_modules/@coumtech/synxed-solana-protocol/index.js.map", "utf8"));
assert.ok(Array.isArray(map.sourcesContent) && map.sourcesContent.every((s) => typeof s === "string" && s.length > 0));
console.log(\`node consumer on \${process.version}: ok\`);
`;

const CONSUMER_TS = `import { computeSettlementN, ProtocolError, type SettlementRequestN, type SplitResultN } from "@coumtech/synxed-solana-protocol";
import { submitSettlementN, type SubmitSettlementNOptions } from "@coumtech/synxed-solana-protocol/client";
import { reconcileSettlementN, type SettlementReconciliation } from "@coumtech/synxed-solana-protocol/ledger";
import type { ShareInput } from "@coumtech/synxed-solana-protocol/types";

const shares: ShareInput[] = [{ label: "artist", recipient: "", bps: 10_000 }];
const request: SettlementRequestN = {
  eventId: "typed",
  occurredAt: "2026-01-01T00:00:00.000Z",
  kind: "audio_ad_impression",
  amountAtomic: 20_000n,
  asset: "SOL_LAMPORTS_STANDIN",
  shares,
  memo: "typed",
};
export const result: SplitResultN = computeSettlementN(request);
export const surface = [submitSettlementN, reconcileSettlementN, ProtocolError] as const;
export type Surface = [SubmitSettlementNOptions, SettlementReconciliation];
// @ts-expect-error amountAtomic is a bigint, so the declarations are real types and not any.
computeSettlementN({ ...request, amountAtomic: 1 });
`;

/** The first ```ts block of the package README, which npm shows to users. */
function readmeExample(): string {
  const readme = readFileSync(join(SDK_DIR, "README.md"), "utf8");
  const match = /```ts\n([\s\S]*?)```/.exec(readme);
  return match?.[1] ?? fail("the package README has no ```ts example");
}

function tsconfig(module: string, moduleResolution: string): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module,
        moduleResolution,
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["node"],
      },
      files: ["consumer.ts", "readme-example.ts"],
    },
    null,
    2,
  )}\n`;
}

/** Paths inside a tarball, without npm's leading "package/" directory. */
function tarballFiles(tarball: string): string[] {
  return run("tar", ["-tzf", tarball], REPO_ROOT)
    .split("\n")
    .filter((line) => line !== "" && !line.endsWith("/"))
    .map((line) => (line.startsWith("package/") ? line.slice("package/".length) : fail(`unexpected tarball entry ${line}`)));
}

function tarballManifest(tarball: string): { name: string; version: string } {
  const parsed: unknown = JSON.parse(run("tar", ["-xzOf", tarball, "package/package.json"], REPO_ROOT));
  return {
    name: stringField(parsed, "name", "the tarball manifest"),
    version: stringField(parsed, "version", "the tarball manifest"),
  };
}

/** Build and pack, or take SYNXED_SDK_TARBALL. Returns the tarball path. */
function obtainTarball(work: string): string {
  const given = process.env.SYNXED_SDK_TARBALL;
  if (given !== undefined && given !== "") {
    const tarball = resolve(given);
    const { name, version } = tarballManifest(tarball);
    const workspace = readWorkspaceManifest();
    if (name !== workspace.name || version !== workspace.version) {
      fail(`${tarball} is ${name}@${version}, but this checkout is ${String(workspace.name)}@${String(workspace.version)}`);
    }
    console.log(`testing the given tarball ${tarball}`);
    return tarball;
  }
  buildSdkPackage();
  const packed: unknown = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], PACKAGE_DIR));
  const entry: unknown = Array.isArray(packed) ? packed[0] : undefined;
  return join(work, stringField(entry, "filename", "npm pack output"));
}

/** The workspace package's declared Node range, which the shipped manifest must keep. */
function engineRange(): string {
  return stringField(readWorkspaceManifest().engines, "node", "sdk/typescript/package.json engines");
}

function main(): void {
  const work = mkdtempSync(join(tmpdir(), "synxed-sdk-smoke-"));
  // spawnSync blocks, so a signal lands after the current child exits; clean up then.
  const cleanUpAndExit = (signal: NodeJS.Signals): void => {
    rmSync(work, { recursive: true, force: true });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", cleanUpAndExit);
  process.once("SIGTERM", cleanUpAndExit);
  try {
    // 1 and 2. Obtain the tarball and inspect its contents.
    const tarball = obtainTarball(work);
    const { name, version } = tarballManifest(tarball);
    const files = tarballFiles(tarball);
    for (const file of files) {
      if (!ALLOWED_PACKAGE_FILE.test(file)) {
        fail(`tarball contains an unexpected file: ${file}`);
      }
    }
    for (const file of REQUIRED_FILES) {
      if (!files.includes(file)) {
        fail(`tarball is missing ${file}`);
      }
    }
    console.log(`checked ${name}@${version}: ${files.length} files`);

    // 3. Install into a fresh consumer project.
    const consumer = join(work, "consumer");
    mkdirSync(consumer);
    writeFileSync(join(consumer, "package.json"), `${JSON.stringify({ name: "sdk-smoke-consumer", private: true, type: "module" }, null, 2)}\n`);
    run(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--ignore-scripts",
        tarball,
        `@solana/web3.js@${installedVersion("@solana/web3.js")}`,
        `typescript@${installedVersion("typescript")}`,
        `@types/node@${installedVersion("@types/node")}`,
      ],
      consumer,
    );

    // 4. Run it under Node and compare with the sources.
    writeFileSync(
      join(consumer, "input.json"),
      `${JSON.stringify({
        name,
        version,
        programId: REFERENCE_PROGRAM_ID,
        engines: engineRange(),
        eventId: EVENT_ID,
        labels: SHARES.map((s) => s.label),
        bps: SHARES.map((s) => s.bps),
        recipients: RECIPIENTS,
        expected: expectedFromSource(),
      })}\n`,
    );
    writeFileSync(join(consumer, "consumer.mjs"), CONSUMER_MJS);
    process.stdout.write(run("node", ["consumer.mjs"], consumer));

    // 5. Type-check a TypeScript consumer under both resolution modes.
    writeFileSync(join(consumer, "consumer.ts"), CONSUMER_TS);
    writeFileSync(join(consumer, "readme-example.ts"), readmeExample());
    writeFileSync(join(consumer, "tsconfig.node.json"), tsconfig("NodeNext", "NodeNext"));
    writeFileSync(join(consumer, "tsconfig.bundler.json"), tsconfig("ESNext", "Bundler"));
    const tsc = join(consumer, "node_modules", "typescript", "bin", "tsc");
    run("node", [tsc, "-p", "tsconfig.node.json"], consumer);
    run("node", [tsc, "-p", "tsconfig.bundler.json"], consumer);
    console.log("typescript consumer and README example (NodeNext and Bundler resolution): ok");
    console.log(`smoke test passed for ${name}@${version}`);
  } finally {
    if (process.env.SYNXED_KEEP_SMOKE === "1") {
      console.log(`kept ${work}`);
    } else {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

main();
