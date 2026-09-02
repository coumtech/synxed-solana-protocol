#!/usr/bin/env bash
# Verify that the program deployed on devnet is byte-for-byte the program
# built from this source tree in the pinned, reproducible build container.
#
# Canonical build environment: the solana-verifiable-build image pinned by
# digest below (Agave 4.0.3 toolchain, platform-tools v1.54, sBPF v0). A
# build in that image produces the same bytes on any host with Docker; the
# same image is used by CI (.github/workflows/verify-deployment.yml) and by
# the maintainers when deploying. Native `cargo build-sbf` output differs
# between host operating systems and toolchain versions, so it is not used
# for verification.
#
# Usage:
#   scripts/verify-deployment.sh [PROGRAM_ID] [RPC_URL]
# Defaults to the reference devnet deployment.
#
# Exit codes:
#   0  MATCH — the on-chain program is the build of this source tree
#   1  DRIFT — the comparison completed and the hashes differ
#   2  could not complete (missing tools, build failure, RPC failure)

set -euo pipefail

PROGRAM_ID="${1:-HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT}"
RPC_URL="${2:-https://api.devnet.solana.com}"
BASE_IMAGE="${SYNXED_BUILD_IMAGE:-solanafoundation/solana-verifiable-build@sha256:588d0c6f45c2faa4456c7b8279897d8af8c6cd17e9613bb8ddf622a820039eb2}"
LIBRARY="synxed_settlement"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Under the repository (not $TMPDIR) so Docker Desktop's default file
# sharing covers it; removed on exit and gitignored.
WORK="$ROOT/.verify-work"

export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"

fail() {
  echo "error: $*" >&2
  exit 2
}

command -v docker >/dev/null 2>&1 || fail "docker is required (https://docs.docker.com/get-docker/)"
docker info >/dev/null 2>&1 || fail "the docker daemon is not running"
command -v solana-verify >/dev/null 2>&1 || fail "solana-verify is required: cargo install solana-verify"
command -v rsync >/dev/null 2>&1 || fail "rsync is required"

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

rm -rf "$WORK"
mkdir -p "$WORK"
trap 'rm -rf "$WORK"' EXIT
# Isolated copy of the program crate so the container never touches the
# working tree's own target/ directory.
rsync -a --exclude target --exclude svm-tests "$ROOT/programs/synxed-settlement/" "$WORK/program/"

echo "solana-verify : $(solana-verify --version 2>/dev/null | awk '{print $NF}')"
echo "build image   : $BASE_IMAGE"
echo "building in the pinned container (first run pulls the image; emulated on Apple Silicon, so slow)..."
solana-verify build --base-image "$BASE_IMAGE" --library-name "$LIBRARY" "$WORK/program" -- --features onchain \
  || fail "container build failed"
SO="$WORK/program/target/deploy/$LIBRARY.so"
[ -f "$SO" ] || fail "the build produced no $SO"
BUILD_HASH="$(solana-verify get-executable-hash "$SO" 2>/dev/null | tail -n 1)"
[ -n "$BUILD_HASH" ] || fail "could not hash the build"

ONCHAIN_HASH=""
for attempt in 1 2 3; do
  if ONCHAIN_HASH="$(solana-verify get-program-hash -u "$RPC_URL" "$PROGRAM_ID" 2>/dev/null | tail -n 1)" \
    && [ -n "$ONCHAIN_HASH" ]; then
    break
  fi
  sleep $((attempt * 5))
done
[ -n "$ONCHAIN_HASH" ] || fail "could not fetch the on-chain program hash from $RPC_URL (unreachable or rate-limited)"

echo "built from src: $BUILD_HASH ($(wc -c < "$SO" | tr -d ' ') bytes, sha256 $(sha "$SO"))"
echo "on-chain      : $ONCHAIN_HASH ($PROGRAM_ID via $RPC_URL)"
if [ "$BUILD_HASH" = "$ONCHAIN_HASH" ]; then
  echo "MATCH: the deployed program is the build of this source tree."
  exit 0
fi
echo "DRIFT: the deployed program differs from this source tree." >&2
exit 1
