# Verified builds

How to confirm that the program running on devnet is the program whose
source you are reading — without trusting the maintainers.

The reference deployment is `HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT`
on devnet. It is upgradeable by the maintainers (standard upgradeable
loader), which is exactly why an independent check matters: anyone can
rebuild from a given commit and compare the bytes on chain.

## One canonical build environment

`cargo build-sbf` does **not** produce identical bytes across hosts: the
same source gave three different binaries on macOS, on a Linux CI runner,
and in the build container (prebuilt platform-tools embed host paths, and
toolchain minor versions differ in post-processing). Comparing hashes is
therefore only meaningful against a build from one fixed environment. This
project pins one:

| | |
| --- | --- |
| Image | `solanafoundation/solana-verifiable-build@sha256:588d0c6f45c2faa4456c7b8279897d8af8c6cd17e9613bb8ddf622a820039eb2` (the Agave v4.0.3 release image; 1.4 GB compressed) |
| Toolchain inside | `cargo-build-sbf` 4.0.0, platform-tools v1.53, rustc 1.89.0, sBPF v0 |
| Build command | `cargo build-sbf --features onchain` on `programs/synxed-settlement` |

The deployed program is built in that image. The verification script and
the CI workflow build in that image. Building there yields the same bytes
on Linux, on macOS (under emulation), anywhere Docker runs — the pull
request that introduced this check proved it by building on a macOS host
and a native Linux runner and matching both to the chain.

## Verify it yourself

Prerequisites: Docker running, and `cargo install solana-verify --locked --version 0.5.1`.

```bash
scripts/verify-deployment.sh
```

The script copies the program crate to a scratch directory
(`.verify-work/`, gitignored, removed on exit), builds it in the pinned
image with `solana-verify build`, hashes the result, fetches the on-chain
program hash, and compares. Output ends in `MATCH` (exit 0) or `DRIFT`
(exit 1); an incomplete run (missing tools, build or RPC failure) exits 2
and never claims either. The first run pulls the image; on Apple Silicon it
is `linux/amd64` and runs under emulation, so expect 15–30 minutes the first
time.

It is an 85-line script written by the maintainers — read it, or skip it
entirely and use `verify-from-repo` below, which goes through none of it.

CI runs the same script after every push to `main`, once a day, and on pull
requests that change the script or the workflow
(`.github/workflows/verify-deployment.yml`). A red run means the deployment
has not been upgraded to `main` yet, or was built from something else.

Trust boundary: the on-chain hash comes from whatever RPC you point at.
Use an RPC you trust, or cross-check with a second one.

## Verify against a git commit directly

`solana-verify` can clone the repository at a commit and build it in the
same image:

```bash
solana-verify verify-from-repo -u https://api.devnet.solana.com \
  --program-id HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT \
  --base-image solanafoundation/solana-verifiable-build@sha256:588d0c6f45c2faa4456c7b8279897d8af8c6cd17e9613bb8ddf622a820039eb2 \
  --library-name synxed_settlement \
  --mount-path programs/synxed-settlement \
  --commit-hash <commit the deployment was built from> \
  https://github.com/coumtech/synxed-solana-protocol -- --features onchain
```

Read the printed verdict (✅ or ❌): the command exits 0 either way, so do
not script on its exit code. Without `--base-image` the tool picks an
image from the `solana-program` version in `Cargo.lock` (a different
toolchain), and without `--features onchain` the crate builds without its
entrypoint — both give a mismatch that says nothing about the deployment.
After a match the tool offers to upload a verification record on-chain;
decline unless you mean to sign for it with a funded key.

## Current deployment

| | |
| --- | --- |
| Program id | `HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT` (devnet) |
| Built from | `main` at the commit named in the PR that last upgraded it |
| Build | pinned image above |
| Upgrade authority | the maintainers' devnet payer key |

The expected hash is deliberately not hard-coded here: the check *is* the
comparison, performed against whatever `main` currently is.

## Maintainer procedure for an upgrade

1. Merge the change to `main` (after CI and the adversarial review).
2. Build the release artifact in the pinned image via the script's isolated
   copy — never with a native toolchain, and never into the working tree's
   shared `target/`:
   ```bash
   SYNXED_KEEP_SO=/tmp/synxed_settlement.so scripts/verify-deployment.sh
   ```
   The run reports `DRIFT` (the chain still has the old program); the
   artifact at `/tmp/synxed_settlement.so` is the canonical build of your
   checkout.
3. If the new binary is larger than the program-data account (`solana
   program show <id>` prints the data length), extend it first:
   ```bash
   solana program extend HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT <additional bytes> \
     --keypair <upgrade authority keypair> --url devnet
   ```
4. Upgrade in place, signing with the upgrade authority:
   ```bash
   solana program deploy /tmp/synxed_settlement.so \
     --program-id HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT \
     --keypair <upgrade authority keypair> --url devnet
   ```
5. Run `scripts/verify-deployment.sh` and confirm `MATCH`, then trigger
   the *Verify deployment* workflow (or wait for the daily run) so the
   public record shows green.

Do not merge program changes without upgrading: the docs describe `main`,
and the daily check fails until the deployment catches up.
