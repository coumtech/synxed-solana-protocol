// Classic SPL Token stablecoin settlement demo. Requires an existing 6-decimal
// devnet mint and a funded payer ATA; this repo never mints a production token.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  DEVNET_RPC_URL,
  assertLedgerCluster,
  reconcileTokenSettlementN,
  submitTokenSettlementN,
  type SettlementRequestN,
  type ShareInput,
} from "@coumtech/synxed-solana-protocol";
import { fakeAudioAdImpression } from "./event.ts";
import {
  REPO_ROOT,
  ensureFunds,
  envString,
  loadPayer,
  loadRecipients,
  parseProgramId,
} from "./shared.ts";

const BPS = [3_500, 3_500, 2_000, 1_000] as const;
const LABELS = ["artist", "studio", "synxed", "rewards_pool"] as const;
const AMOUNT_BASE_UNITS = 20_000n;
const REQUIRED_DECIMALS = 6;
const SOL_FEE_AND_RENT_BUFFER = 12_000_000n;

async function main(): Promise<void> {
  const payerPath = requiredEnv("SOLANA_PAYER_KEYPAIR");
  const programId = parseProgramId();
  if (programId === undefined) {
    throw new Error("SETTLEMENT_PROGRAM_ID is required for token settlement");
  }
  const mint = parsePublicKey("STABLECOIN_MINT", requiredEnv("STABLECOIN_MINT"));
  const payer = loadPayer(resolve(REPO_ROOT, payerPath));
  const connection = new Connection(
    envString("SOLANA_RPC_URL") ?? DEVNET_RPC_URL,
    "confirmed",
  );
  await assertLedgerCluster(connection, "devnet");
  const mintState = await getMint(connection, mint, "confirmed", TOKEN_PROGRAM_ID);
  if (mintState.decimals !== REQUIRED_DECIMALS) {
    throw new Error(
      `STABLECOIN_MINT must have ${REQUIRED_DECIMALS} decimals, got ${mintState.decimals}`,
    );
  }
  const source = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const sourceState = await getAccount(connection, source, "confirmed", TOKEN_PROGRAM_ID);
  if (sourceState.amount < AMOUNT_BASE_UNITS) {
    throw new Error(
      `payer ATA ${source.toBase58()} has ${sourceState.amount} base units; ` +
        `${AMOUNT_BASE_UNITS} required`,
    );
  }
  await ensureFunds(connection, payer, SOL_FEE_AND_RENT_BUFFER);

  const recipients = loadRecipients(true);
  const wallets = [
    recipients.artist,
    recipients.studio,
    recipients.synxed,
    recipients.rewardsPool,
  ];
  if (wallets[3] === undefined) {
    throw new Error("rewards-pool wallet is missing");
  }
  const shares: ShareInput[] = LABELS.map((label, index) => ({
    label,
    recipient: wallets[index] as string,
    bps: BPS[index],
  }));
  const event = fakeAudioAdImpression();
  const request: SettlementRequestN = {
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    kind: "audio_ad_impression",
    amountAtomic: AMOUNT_BASE_UNITS,
    asset: "SPL_STABLECOIN",
    shares,
    memo: `audio ad in ${event.gameTitle} (4-way SPL stablecoin)`,
  };
  const submission = await submitTokenSettlementN({
    connection,
    payer,
    request,
    mint,
    decimals: REQUIRED_DECIMALS,
    programId,
  });
  console.log("Classic SPL Token settlement submitted");
  console.log(`  mint       ${mint.toBase58()}`);
  console.log(`  source ATA ${submission.sourceTokenAccount.toBase58()}`);
  shares.forEach((share, index) => {
    console.log(
      `  ${share.label.padEnd(14)} ${submission.tokenAmountsByShare[index]} -> ` +
        submission.recipientTokenAccounts[index].toBase58(),
    );
  });
  console.log(`  signature  ${submission.signature}`);
  console.log(`  explorer   ${submission.explorerUrl}`);

  const reconciliation = await reconcileTokenSettlementN({
    connection,
    signature: submission.signature,
    programId,
    request,
    tokenBaseUnitsPerAtomicUnit: 1n,
    mint,
    decimals: REQUIRED_DECIMALS,
    beneficiaryIds: {
      artist: "artist:demo",
      studio: "studio:demo",
      synxed: "platform:synxed",
    },
  });
  const ledgerPath = resolve(
    REPO_ROOT,
    ".local/ledger",
    `${submission.signature}.json`,
  );
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, `${JSON.stringify(reconciliation, null, 2)}\n`);
  console.log("Ledger reconciliation: MATCH");
  console.log(`  evidence ${ledgerPath}`);
}

function requiredEnv(name: string): string {
  const value = envString(name);
  if (value === undefined) throw new Error(`${name} is required in .env`);
  return value;
}

function parsePublicKey(name: string, value: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} is not a valid base58 public key`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
