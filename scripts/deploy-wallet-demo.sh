#!/usr/bin/env bash
# Build the wallet-connect demo against the reference devnet deployment and
# publish it as a static site on Vercel. Maintainer tool; nothing in the
# bundle is secret (program id + public devnet RPC only) and the demo never
# touches the private SYNXED product or its repository.
#
# The normal path is the Git-connected Vercel project (imported from this
# repository; see docs/wallet-connect-demo.md). This script is the manual
# alternative for a one-off deploy or a team without the Git integration.
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

# The RPC URL is inlined into a public bundle. Refuse anything that looks
# like a keyed endpoint unless the maintainer explicitly opts in.
case "$RPC_URL" in
  *\?*|*api-key*|*api_key*|*apikey*)
    if [ "${ALLOW_CUSTOM_RPC:-0}" != "1" ]; then
      echo "error: VITE_SOLANA_RPC_URL looks like a keyed endpoint and would be published; set ALLOW_CUSTOM_RPC=1 to override" >&2
      exit 2
    fi
    ;;
esac

echo "building demo for program $PROGRAM_ID via $RPC_URL..."
(cd "$ROOT" && bun install --frozen-lockfile >/dev/null)
(cd "$DEMO" && VITE_SETTLEMENT_PROGRAM_ID="$PROGRAM_ID" VITE_SOLANA_RPC_URL="$RPC_URL" bun run build >/dev/null)
grep -q "$PROGRAM_ID" "$DEMO"/dist/assets/*.js || { echo "error: built bundle does not contain the program id" >&2; exit 2; }

# `project add` exits 0 when the project already exists; any other failure
# (auth, permissions, quota) must stop the script rather than fall through.
vercel project add "$PROJECT" --scope "$SCOPE"
# Deploy the prebuilt static output straight to the named project; no local
# link file is created and no framework build runs on Vercel.
vercel deploy "$DEMO/dist" --prod --yes --scope "$SCOPE" --project "$PROJECT"
