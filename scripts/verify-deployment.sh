#!/usr/bin/env bash
# Verify that the program deployed on devnet is byte-for-byte the program
# built from this source tree.
#
# Builds the program with the pinned Agave toolchain, dumps the on-chain
# executable, and compares SHA-256 digests (the on-chain dump is padded to
# the program-data account size, so it is truncated to the local length).
#
# Usage:
#   scripts/verify-deployment.sh [PROGRAM_ID] [RPC_URL]
# Defaults to the reference devnet deployment. Exit 0 = match, 1 = drift.
#
# For an independent, container-based reproducible build (no local toolchain
# trust required), see docs/verified-build.md.

set -euo pipefail

PROGRAM_ID="${1:-HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT}"
RPC_URL="${2:-https://api.devnet.solana.com}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/programs/synxed-settlement/Cargo.toml"
LOCAL_SO="$ROOT/programs/synxed-settlement/target/deploy/synxed_settlement.so"

if ! command -v cargo-build-sbf >/dev/null 2>&1 || ! command -v solana >/dev/null 2>&1; then
  echo "error: cargo-build-sbf and solana must be on PATH (Agave toolchain)." >&2
  echo "       see docs/integration.md for installation." >&2
  exit 2
fi

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

echo "building program from source..."
cargo-build-sbf --manifest-path "$MANIFEST" --features onchain >/dev/null 2>&1 \
  || cargo-build-sbf --manifest-path "$MANIFEST" --features onchain
LOCAL_LEN="$(wc -c < "$LOCAL_SO" | tr -d ' ')"
LOCAL_SHA="$(sha "$LOCAL_SO")"

DUMP="$(mktemp -t synxed-onchain.XXXXXX)"
trap 'rm -f "$DUMP" "$DUMP.trunc"' EXIT
echo "dumping on-chain program $PROGRAM_ID from $RPC_URL..."
solana program dump "$PROGRAM_ID" "$DUMP" --url "$RPC_URL" >/dev/null
head -c "$LOCAL_LEN" "$DUMP" > "$DUMP.trunc"
ONCHAIN_SHA="$(sha "$DUMP.trunc")"

echo "local build : $LOCAL_SHA ($LOCAL_LEN bytes)"
echo "on-chain    : $ONCHAIN_SHA (first $LOCAL_LEN bytes of the program data)"
if [ "$LOCAL_SHA" = "$ONCHAIN_SHA" ]; then
  echo "MATCH: the deployed program is the build of this source tree."
  exit 0
fi
echo "DRIFT: the deployed program differs from this source tree." >&2
exit 1
