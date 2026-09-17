import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Adapter } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import "@solana/wallet-adapter-react-ui/styles.css";
import { App, DEVNET_ENDPOINT } from "./App.tsx";
import "./styles.css";

// Installed Wallet Standard wallets are discovered automatically and take
// precedence: the provider drops a fallback adapter whose name matches a
// detected wallet, so nothing is listed twice. The fallbacks exist for visitors
// with no wallet installed. Without them the wallet picker renders only its
// title and no way forward; with them it offers install links for Phantom and
// Solflare (the picker opens the wallet's website when an undetected entry is
// chosen).
const FALLBACK_WALLETS: Adapter[] = [new PhantomWalletAdapter(), new SolflareWalletAdapter()];

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
