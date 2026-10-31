// Command line for the studio settlement worker. See docs/studio-integration.md.
//
//   bun run studio init                 open (or check) the namespace; prints the address to pin
//   bun run studio enqueue <file.json>  store billable events
//   bun run studio dry-run [limit]      build and simulate pending events; sends and writes nothing
//   bun run studio run [limit]          resolve in-flight events, then settle pending ones
//   bun run studio resolve <eventId>    look at an event a person flagged, from the chain
//   bun run studio status               events by status, and the ones that need a person
//   bun run studio ledger               paid amounts per beneficiary

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  assertLedgerCluster,
  ensureNamespace,
  namespaceIdFromLabel,
} from "@coumtech/synxed-solana-protocol";
import { databasePath, loadConfig, type StudioConfig } from "./config.ts";
import { prepareEvent } from "./events.ts";
import { Store } from "./store.ts";
import { SettlementWorker } from "./worker.ts";

function openStore(path: string): Store {
  mkdirSync(dirname(path), { recursive: true });
  return new Store(path);
}

function limitArgument(raw: string | undefined): number {
  if (raw === undefined) {
    return 10;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`limit must be a positive integer, got "${raw}"`);
  }
  return Number(raw);
}

/**
 * The namespace to settle in. `init` opens it unless an address is pinned;
 * `dry-run`, `run` and `resolve` require it to exist and, when pinned, to be
 * exactly that address.
 */
async function namespace(config: StudioConfig, connection: Connection, create: boolean): Promise<PublicKey> {
  const ensured = await ensureNamespace({
    connection,
    payer: config.payer,
    programId: config.programId,
    namespaceId: namespaceIdFromLabel(config.namespaceLabel),
    ...(config.authority !== undefined ? { authority: config.authority.publicKey } : {}),
    ...(config.namespaceAddress !== undefined
      ? { create: false, expectedAddress: config.namespaceAddress }
      : { create }),
  });
  if (ensured.created) {
    console.log(`Opened namespace "${config.namespaceLabel}" ${ensured.address.toBase58()} (${ensured.signature})`);
  }
  return ensured.address;
}

function settlementWorker(
  config: StudioConfig,
  connection: Connection,
  second: Connection | undefined,
  address: PublicKey,
  store: Store,
): SettlementWorker {
  return new SettlementWorker({
    store,
    connection,
    ...(second !== undefined ? { secondConnection: second } : {}),
    payer: config.payer,
    ...(config.authority !== undefined ? { authority: config.authority } : {}),
    programId: config.programId,
    namespace: address,
    lamportsPerAtomicUnit: config.lamportsPerAtomicUnit,
    maxAttempts: config.maxAttempts,
    log: (line) => console.log(line),
  });
}

async function connections(config: StudioConfig): Promise<{ connection: Connection; second: Connection | undefined }> {
  const connection = new Connection(config.rpcUrl, "confirmed");
  await assertLedgerCluster(connection, "devnet");
  if (config.secondRpcUrl === undefined) {
    console.warn("SOLANA_SECOND_RPC_URL is not set: the primary RPC is trusted alone (acceptable on devnet only).");
    return { connection, second: undefined };
  }
  const second = new Connection(config.secondRpcUrl, "confirmed");
  await assertLedgerCluster(second, "devnet");
  return { connection, second };
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  switch (command) {
    case "init": {
      const config = loadConfig();
      const { connection } = await connections(config);
      const address = await namespace(config, connection, true);
      console.log(`Namespace "${config.namespaceLabel}": ${address.toBase58()}`);
      if (config.namespaceAddress === undefined) {
        console.log(`Pin it: SETTLEMENT_NAMESPACE_ADDRESS=${address.toBase58()}`);
      }
      return;
    }
    case "enqueue": {
      if (argument === undefined) {
        throw new Error("usage: enqueue <events.json>");
      }
      const parsed: unknown = JSON.parse(readFileSync(argument, "utf8"));
      if (!Array.isArray(parsed)) {
        throw new Error("the events file must hold a JSON array");
      }
      // Validate the whole file before storing any of it.
      const events = parsed.map(prepareEvent);
      const store = openStore(databasePath());
      try {
        for (const { request, beneficiaryIds } of events) {
          console.log(`${request.eventId}: ${store.enqueue(request, beneficiaryIds)}`);
        }
      } finally {
        store.close();
      }
      return;
    }
    case "dry-run":
    case "run": {
      const config = loadConfig();
      const { connection, second } = await connections(config);
      const address = await namespace(config, connection, false);
      const store = openStore(config.databasePath);
      try {
        const worker = settlementWorker(config, connection, second, address, store);
        if (command === "dry-run") {
          for (const result of await worker.dryRun(limitArgument(argument))) {
            const sol = Number(result.lamportsTotal) / LAMPORTS_PER_SOL;
            console.log(
              `${result.eventId}: ${sol} SOL as [${result.lamportsByShare.join(", ")}] lamports, ` +
                (result.error === null ? "simulation ok" : `simulation failed: ${JSON.stringify(result.error)}`),
            );
          }
          return;
        }
        const summary = await worker.run(limitArgument(argument));
        for (const [eventId, outcome] of Object.entries({ ...summary.resolved, ...summary.settled })) {
          console.log(`${eventId}: ${outcome}`);
        }
      } finally {
        store.close();
      }
      return;
    }
    case "resolve": {
      if (argument === undefined) {
        throw new Error("usage: resolve <eventId>");
      }
      const config = loadConfig();
      const { connection, second } = await connections(config);
      const address = await namespace(config, connection, false);
      const store = openStore(config.databasePath);
      try {
        const worker = settlementWorker(config, connection, second, address, store);
        console.log(`${argument}: ${await worker.recheck(argument)}`);
      } finally {
        store.close();
      }
      return;
    }
    case "status": {
      const store = openStore(databasePath());
      try {
        for (const line of statusLines(store)) {
          console.log(line);
        }
      } finally {
        store.close();
      }
      return;
    }
    case "ledger": {
      const store = openStore(databasePath());
      try {
        for (const { beneficiaryId, amountOnChain } of store.balances()) {
          console.log(`${beneficiaryId.padEnd(28)} ${amountOnChain} lamports`);
        }
      } finally {
        store.close();
      }
      return;
    }
    default:
      throw new Error("usage: bun run studio <init | enqueue <file> | dry-run [limit] | run [limit] | resolve <eventId> | status | ledger>");
  }
}

/**
 * The `status` report: counts, then in-flight, pending, incident and
 * needs-attention details, in that order. A pending note records why the
 * event is still queued: a blockhash fault, a refused attempt, or no attempt
 * landed. At most 50 details are printed per status, with the rest
 * counted.
 */
export function statusLines(store: Store): string[] {
  const lines = store.statusCounts().map(({ status, count }) => `${status.padEnd(16)} ${count}`);
  for (const status of ["in_flight", "pending", "incident", "needs_attention"] as const) {
    const events = store.eventsWithStatus(status);
    for (const event of events.slice(0, 50)) {
      lines.push(`${status}: ${event.eventId}${event.note === null ? "" : ` (${event.note})`}`);
    }
    if (events.length > 50) {
      lines.push(`${status}: ... and ${events.length - 50} more`);
    }
  }
  return lines;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
