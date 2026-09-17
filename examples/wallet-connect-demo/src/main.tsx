import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WalletAdapterNetwork, type Adapter } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import "@solana/wallet-adapter-react-ui/styles.css";
import { App, DEVNET_ENDPOINT } from "./App.tsx";
import "./styles.css";

// Installed Wallet Standard wallets are discovered automatically and take
// precedence: the provider drops a fallback adapter whose name matches a
// detected wallet (logging a console warning that the adapter "can be
// removed"; that warning is expected), so nothing is listed twice.
//
// The fallbacks exist for visitors with no wallet installed. Without them the
// wallet picker renders only its title and no way forward. With them:
// - Phantom is listed with readyState NotDetected. Choosing it turns the
//   header button into Connect, and pressing Connect opens phantom.app (the
//   provider's default reaction to a wallet that is not ready); App.tsx
//   explains this. In an iPhone browser both entries are Loadable instead and
//   redirect to the wallet app's in-app browser.
// - Solflare is "loadable" without an extension: choosing it opens Solflare's
//   hosted web wallet in the page. The network must be pinned to devnet or the
//   hosted wallet defaults to mainnet and cannot sign the demo's devnet
//   transaction. The app enforces devnet for every RPC anyway.
const FALLBACK_WALLETS: Adapter[] = [
  new PhantomWalletAdapter(),
  new SolflareWalletAdapter({ network: WalletAdapterNetwork.Devnet }),
];

const root = document.getElementById("root");
if (root === null) {
  throw new Error("wallet demo root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <ConnectionProvider endpoint={DEVNET_ENDPOINT}>
      <WalletProvider wallets={FALLBACK_WALLETS} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  </StrictMode>,
);
