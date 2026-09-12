import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The SDK deliberately imports Buffer explicitly. Point Vite at the
    // browser package instead of its Node built-in compatibility stub.
    alias: {
      buffer: "buffer/",
    },
  },
  build: {
    sourcemap: true,
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/react")) return "react";
          if (
            id.includes("@solana/wallet-adapter") ||
            id.includes("@wallet-standard")
          ) {
            return "wallet-adapter";
          }
          if (
            id.includes("@solana/web3.js") ||
            id.includes("@solana/codecs") ||
            id.includes("@noble/") ||
            id.includes("bs58")
          ) {
            return "solana";
          }
          return undefined;
        },
      },
    },
  },
});
