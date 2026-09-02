# Verified builds

How to confirm that the program running on devnet is the program whose
source you are reading — without trusting the maintainers.

The reference deployment is `HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT`
on devnet. It is upgradeable by the maintainers (standard upgradeable
loader), which is exactly why an independent check matters: anyone can
rebuild from a given commit and compare the bytes on chain.

## One canonical build environment

`cargo build-sbf` does **not** produce identical bytes across hosts: the
same source and the same Agave version gave three different binaries on
macOS, on a Linux CI runner, and in the build container (the prebuilt
platform-tools embed host paths, and toolchain minor versions differ in
post-processing). Comparing hashes is therefore only meaningful against a
build from a fixed environment. This project pins one:

| | |
| --- | --- |
| Image | `solanafoundation/solana-verifiable-build@sha256:588d0c6f45c2faa4456c7b8279897d8af8c6cd17e9613bb8ddf622a820039eb2` (tag `4.0.3`) |
| Toolchain inside | Agave 4.0.3 `cargo-build-sbf`, platform-tools v1.54, sBPF v0 |
| Build command | `cargo build-sbf --features onchain` on `programs/synxed-settlement` |

The deployed program is built in that image. The verification script and
the CI workflow build in that image. If you build in that image, you get
the same bytes — on Linux, on macOS (under emulation), anywhere Docker runs.

## Verify it yourself

Prerequisites: Docker running, `cargo install solana-verify`.

```bash
scripts/verify-deployment.sh
```

The script copies the program crate to a scratch directory, builds it in
the pinned image with `solana-verify build`, hashes the result, fetches the
on-chain program hash, and compares. Output ends in `MATCH` (exit 0) or
`DRIFT` (exit 1); an incomplete run (missing tools, build or RPC failure)
exits 2 and never claims either. The first run pulls a ~2 GB image; on
Apple Silicon the image is `linux/amd64` and runs under emulation, so
expect 15–30 minutes the first time.

CI runs the same script after every push to `main` and once a day
(`.github/workflows/verify-deployment.yml`). A red run means the
deployment has not been upgraded to `main` yet, or was built from
something else.

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

Without `--base-image` the tool picks an image from the `solana-program`
version in `Cargo.lock` (a different toolchain), and without
`--features onchain` the crate builds without its entrypoint — both give a
mismatch that says nothing about the deployment. After a match the tool
offers to upload a verification record on-chain; decline unless you mean
to sign for it with a funded key.

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
2. Build the release artifact in the pinned image — never with a native
   toolchain:
   ```bash
   solana-verify build \
     --base-image solanafoundation/solana-verifiable-build@sha256:588d0c6f45c2faa4456c7b8279897d8af8c6cd17e9613bb8ddf622a820039eb2 \
     --library-name synxed_settlement "$PWD/programs/synxed-settlement" -- --features onchain
   ```
3. Upgrade in place, signing with the upgrade authority:
   ```bash
   solana program deploy programs/synxed-settlement/target/deploy/synxed_settlement.so \
     --program-id HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT \
     --keypair <upgrade authority keypair> --url devnet
   ```
4. Run `scripts/verify-deployment.sh` and confirm `MATCH`, then trigger
   the *Verify deployment* workflow (or wait for the daily run) so the
   public record shows green.

Do not merge program changes without upgrading: the docs describe `main`,
and the daily check fails until the deployment catches up.
