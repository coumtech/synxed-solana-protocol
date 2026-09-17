#!/usr/bin/env bash
# Build the wallet-connect demo against the reference devnet deployment and
# publish it as a static site on Vercel. Maintainer tool; nothing in the
# bundle is secret (program id + public devnet RPC only) and the demo never
# touches the private SYNXED product or its repository.
#
# Usage:
#   scripts/deploy-wallet-demo.sh <vercel-team-scope> [project-name]
# Example:
#   scripts/deploy-wallet-demo.sh coum-hq synxed-wallet-demo
#
# Requires: bun, vercel CLI (logged in with rights to create projects in the
# given team). Creates the project on first run; later runs redeploy it.

set -euo pipefail

SCOPE="${1:?vercel team scope required, e.g. coum-hq}"
PROJECT="${2:-synxed-wallet-demo}"
PROGRAM_ID="${VITE_SETTLEMENT_PROGRAM_ID:-HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT}"
RPC_URL="${VITE_SOLANA_RPC_URL:-https://api.devnet.solana.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO="$ROOT/examples/wallet-connect-demo"

command -v bun >/dev/null 2>&1 || { echo "error: bun is required" >&2; exit 2; }
command -v vercel >/dev/null 2>&1 || { echo "error: vercel CLI is required (npm i -g vercel)" >&2; exit 2; }

echo "building demo for program $PROGRAM_ID via $RPC_URL..."
(cd "$ROOT" && bun install --frozen-lockfile >/dev/null)
(cd "$DEMO" && VITE_SETTLEMENT_PROGRAM_ID="$PROGRAM_ID" VITE_SOLANA_RPC_URL="$RPC_URL" bun run build >/dev/null)
grep -q "$PROGRAM_ID" "$DEMO"/dist/assets/*.js || { echo "error: built bundle does not contain the program id" >&2; exit 2; }

cd "$DEMO"
if [ ! -f .vercel/project.json ]; then
  vercel project add "$PROJECT" --scope "$SCOPE" >/dev/null 2>&1 || true
  vercel link --yes --scope "$SCOPE" --project "$PROJECT"
fi
# Deploy the prebuilt static output; the link is copied alongside it so the
# CLI targets the linked project rather than creating one named "dist".
rm -rf dist/.vercel && cp -R .vercel dist/.vercel
trap 'rm -rf "$DEMO/dist/.vercel"' EXIT
vercel deploy dist --prod --yes --scope "$SCOPE"
