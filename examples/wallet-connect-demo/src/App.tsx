import { useEffect, useState, type FormEvent } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  WalletMultiButton,
  useWalletModal,
} from "@solana/wallet-adapter-react-ui";
import { PublicKey } from "@solana/web3.js";
import type { SettlementReconciliation } from "@coumtech/synxed-solana-protocol/ledger";
import type {
  SettlementRequestN,
  ShareInput,
} from "@coumtech/synxed-solana-protocol/types";

const DEFAULT_RPC = "https://api.devnet.solana.com";
const DEFAULT_PROGRAM_ID = "HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT";
const AMOUNT_ATOMIC = 20_000n;
const UNITS_PER_ATOMIC = 1_000n;
const FUNDING_OVERHEAD = 1_200_000n;

export const DEVNET_ENDPOINT =
  import.meta.env.VITE_SOLANA_RPC_URL?.trim() || DEFAULT_RPC;

const PROGRAM_ID = new PublicKey(
  import.meta.env.VITE_SETTLEMENT_PROGRAM_ID?.trim() || DEFAULT_PROGRAM_ID,
);

const SHARE_CONFIG = [
  { label: "artist", title: "Artist", bps: 3_500, amount: "$0.007" },
  { label: "studio", title: "Studio", bps: 3_500, amount: "$0.007" },
  { label: "synxed", title: "SYNXED platform", bps: 2_000, amount: "$0.004" },
  {
    label: "rewards_pool",
    title: "Listener rewards pool",
    bps: 1_000,
    amount: "$0.002",
  },
] as const;

type ShareLabel = (typeof SHARE_CONFIG)[number]["label"];
type RecipientFields = Record<ShareLabel, string>;

const INITIAL_RECIPIENTS: RecipientFields = {
  artist: "6AF4DwckLZ7pxwWYarmJx5Sk6dyziagHNoDA8CJpDQa5",
  studio: "EfKS8o2pDsHAJUKQQ3evE5m6PgYR7rxEYvGQavk2y1Da",
  synxed: "GJ7JUe6w6DktBDBPKGWNzhJUhRRFExJqb2hrtdsQFX7s",
  rewards_pool: "48fB8mLhZJNZxVjyebuEhu5nvKPSyM31asQE6kkjqhA9",
};

type RunState =
  | { status: "idle" }
  | { status: "needs-wallet"; message: string }
  | { status: "working"; message: string }
  | { status: "error"; message: string }
  | {
      status: "matched";
      signature: string;
      reconciliation: SettlementReconciliation;
    };

export function App(): React.JSX.Element {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const { setVisible: openWalletPicker } = useWalletModal();
  const [recipients, setRecipients] =
    useState<RecipientFields>(INITIAL_RECIPIENTS);
  const [run, setRun] = useState<RunState>({ status: "idle" });
  const connectedAddress = publicKey?.toBase58() ?? null;

  // The "connect a wallet first" prompt must disappear the moment a wallet
  // connects, otherwise the page contradicts itself.
  useEffect(() => {
    if (publicKey !== null && run.status === "needs-wallet") {
      setRun({ status: "idle" });
    }
  }, [publicKey, run.status]);

  async function settle(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (publicKey === null) {
      // Never leave a click unanswered: explain and open the wallet picker.
      setRun({
        status: "needs-wallet",
        message:
          "No wallet connected yet. Pick a Solana wallet in the picker, make sure it is on devnet, and fund it from the faucet, then try again.",
      });
      openWalletPicker(true);
      return;
    }

    try {
      setRun({ status: "working", message: "Validating the four-way settlement…" });
      const [
        { buildSettlementNTransaction },
        { assertLedgerCluster, reconcileSettlementN },
      ] = await Promise.all([
          import("@coumtech/synxed-solana-protocol/client"),
          import("@coumtech/synxed-solana-protocol/ledger"),
        ]);
      await assertLedgerCluster(connection, "devnet");
      const shares: ShareInput[] = SHARE_CONFIG.map((share) => ({
        label: share.label,
        recipient: recipients[share.label].trim(),
        bps: share.bps,
      }));
      const request: SettlementRequestN = {
        eventId: `evt_wallet_${crypto.randomUUID()}`,
        occurredAt: new Date().toISOString(),
        kind: "audio_ad_impression",
        amountAtomic: AMOUNT_ATOMIC,
        asset: "SOL_LAMPORTS_STANDIN",
        shares,
        memo: "Wallet-connected four-way settlement",
      };
      const prepared = buildSettlementNTransaction({
        payer: publicKey,
        request,
        lamportsPerAtomicUnit: UNITS_PER_ATOMIC,
        programId: PROGRAM_ID,
      });
      const balance = BigInt(await connection.getBalance(publicKey, "confirmed"));
      const required = prepared.lamportsTotal + FUNDING_OVERHEAD;
      if (balance < required) {
        throw new Error(
          `Wallet needs at least ${formatSol(required)} SOL on devnet; current balance is ${formatSol(balance)} SOL. Fund it at faucet.solana.com.`,
        );
      }

      setRun({ status: "working", message: "Approve the transaction in your wallet…" });
      const signature = await sendTransaction(prepared.transaction, connection, {
        preflightCommitment: "confirmed",
        skipPreflight: false,
      });
      setRun({
        status: "working",
        message: "Transaction submitted. Waiting for finalized evidence…",
      });
      const reconciliation = await reconcileSettlementN({
        connection,
        signature,
        programId: PROGRAM_ID,
        request,
        unitsPerAtomicUnit: UNITS_PER_ATOMIC,
        beneficiaryIds: {
          artist: "artist:demo",
          studio: "studio:demo",
          synxed: "platform:synxed",
        },
      });
      persistEvidence(signature, reconciliation);
      setRun({ status: "matched", signature, reconciliation });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Settlement failed.";
      // A wallet still set to mainnet cannot act on a devnet blockhash; the
      // wallet's own error wording varies, so add the likely cause.
      const hint = /expired|blockhash|simulat/i.test(message)
        ? " Check that your wallet is on devnet (Phantom: Settings → Developer Settings → Testnet Mode)."
        : "";
      setRun({ status: "error", message: `${message}${hint}` });
    }
  }

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="/" aria-label="SYNXED settlement demo home">
          <span className="brand-mark" aria-hidden="true">S</span>
          <span>SYNXED</span>
        </a>
        <WalletMultiButton />
      </header>

      <section className="hero" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">Open-source protocol · Solana devnet</p>
          <h1 id="page-title">Revenue, split visibly.</h1>
          <p className="lede">
            Sign one four-way settlement, inspect it on-chain, and reconcile
            every payout against finalized Solana evidence.
          </p>
        </div>
        <div className="proof-card">
          <span>Protocol status</span>
          <strong><i aria-hidden="true" /> Verified build</strong>
          <code>{shorten(PROGRAM_ID.toBase58())}</code>
        </div>
      </section>

      <section className="howto" aria-label="How to try the demo">
        <p className="eyebrow">Try it in three steps</p>
        <ol>
          <li>
            Install any Wallet Standard browser wallet, for example{" "}
            <a href="https://solana.com/wallets" target="_blank" rel="noreferrer">Phantom or Solflare</a>,
            and switch it to <strong>devnet</strong> (Phantom: Settings → Developer Settings →
            Testnet Mode).
          </li>
          <li>
            Fund that wallet with free devnet SOL at{" "}
            <a href="https://faucet.solana.com" target="_blank" rel="noreferrer">faucet.solana.com</a>{" "}
            (0.05 SOL is plenty; the settlement uses about 0.022).
          </li>
          <li>
            Press <strong>Select Wallet</strong>, then <strong>Sign &amp; settle</strong>. The
            transaction and its reconciliation appear below.
          </li>
        </ol>
        <p className="howto-note">
          On an iPhone, open this page inside your wallet app's built-in browser. On
          Android, Chrome can hand off to an installed wallet app.
        </p>
      </section>

      <section className="split-grid" aria-label="Default revenue split">
        {SHARE_CONFIG.map((share, index) => (
          <article className="share-card" key={share.label}>
            <span className="share-index">0{index + 1}</span>
            <p>{share.title}</p>
            <strong>{share.bps / 100}%</strong>
            <small>{share.amount} of the $0.020 event</small>
          </article>
        ))}
      </section>

      <section className="workspace">
        <form className="settlement-form" onSubmit={settle}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">Settlement request</p>
              <h2>Recipient wallets</h2>
            </div>
            <span className="network-pill">Devnet only</span>
          </div>

          <p className="form-note">
            Public demo addresses are prefilled. Replace them with wallets you
            control if you want to inspect every recipient balance.
          </p>

          <div className="fields">
            {SHARE_CONFIG.map((share) => (
              <label key={share.label}>
                <span>{share.title}</span>
                <input
                  name={share.label}
                  value={recipients[share.label]}
                  onChange={(event) =>
                    setRecipients((current) => ({
                      ...current,
                      [share.label]: event.target.value,
                    }))
                  }
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>
            ))}
          </div>

          <div className="signing-row">
            <div>
              <span>Signing wallet</span>
              <code>{connectedAddress === null ? "Not connected" : shorten(connectedAddress)}</code>
            </div>
            <button
              className="settle-button"
              type="submit"
              disabled={run.status === "working"}
            >
              {run.status === "working"
                ? "Working…"
                : connectedAddress === null
                  ? "Connect a wallet to settle"
                  : "Sign & settle 0.02 SOL"}
            </button>
          </div>
          {run.status === "needs-wallet" ||
          run.status === "working" ||
          run.status === "error" ? (
            <p className={`status inline ${run.status === "working" ? "working" : "error"}`}>
              {run.message}
            </p>
          ) : null}
          {run.status === "matched" ? (
            <p className="status inline matched">
              Settled and reconciled: MATCH.{" "}
              <a href={explorerTxUrl(run.signature)} target="_blank" rel="noreferrer">
                Open transaction in Explorer ↗
              </a>
            </p>
          ) : null}
        </form>

        <aside className="evidence-panel" aria-live="polite">
          <p className="eyebrow">Finalized evidence</p>
          <h2>Reconciliation</h2>
          {run.status === "idle" ? (
            <p className="muted">
              Connect a devnet wallet and submit the settlement. Chain evidence
              will appear here after finality.
            </p>
          ) : null}
          {run.status === "working" ? <p className="status working">{run.message}</p> : null}
          {run.status === "error" || run.status === "needs-wallet" ? (
            <p className="status error">{run.message}</p>
          ) : null}
          {run.status === "matched" ? (
            <div className="match-result">
              <div className="match-badge"><i aria-hidden="true" /> MATCH</div>
              <dl>
                <div><dt>Slot</dt><dd>{run.reconciliation.record.slot}</dd></div>
                <div><dt>Direct entries</dt><dd>{run.reconciliation.directEntries.length}</dd></div>
                <div><dt>Pool entries</dt><dd>{run.reconciliation.poolPayouts.length}</dd></div>
              </dl>
              <a href={explorerTxUrl(run.signature)} target="_blank" rel="noreferrer">
                Open transaction in Explorer ↗
              </a>
              <details>
                <summary>View ledger JSON</summary>
                <pre>{JSON.stringify(run.reconciliation, null, 2)}</pre>
              </details>
            </div>
          ) : null}
          <footer>
            <span>Finality</span>
            <strong>Required</strong>
            <span>Mismatch policy</span>
            <strong>Fail closed</strong>
          </footer>
        </aside>
      </section>
    </main>
  );
}

function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

function persistEvidence(
  signature: string,
  reconciliation: SettlementReconciliation,
): void {
  try {
    localStorage.setItem(
      `synxed:settlement-evidence:v1:${signature}`,
      JSON.stringify({ version: 1, reconciliation }),
    );
  } catch {
    // Display remains authoritative even when private browsing blocks storage.
  }
}

function formatSol(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const fraction = (lamports % 1_000_000_000n).toString().padStart(9, "0").slice(0, 4);
  return `${whole}.${fraction}`;
}

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}
