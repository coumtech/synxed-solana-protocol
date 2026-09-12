import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Adapter } from "@solana/wallet-adapter-base";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { App, DEVNET_ENDPOINT } from "./App.tsx";
import "./styles.css";

const STANDARD_WALLETS: Adapter[] = [];

const root = document.getElementById("root");
if (root === null) {
  throw new Error("wallet demo root element is missing");
}

createRoot(root).render(
  <StrictMode>
    <ConnectionProvider endpoint={DEVNET_ENDPOINT}>
      <WalletProvider wallets={STANDARD_WALLETS} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  </StrictMode>,
);
