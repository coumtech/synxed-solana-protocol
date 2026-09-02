# Verified builds

How to confirm that the program running on devnet is the program whose
source you are reading — without trusting the maintainers.

The reference deployment is `HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT`
on devnet. It is upgradeable by the maintainers (standard upgradeable
loader), which is exactly why an independent check matters: anyone can
rebuild from a given commit and compare the bytes on chain.

## Level 1 — build locally and compare (one command)

```bash
scripts/verify-deployment.sh
```

The script builds `programs/synxed-settlement` with the pinned Agave
toolchain (`cargo build-sbf --features onchain`), dumps the on-chain
program, and compares SHA-256 digests. `MATCH` means the deployed bytes are
the build of your checkout; `DRIFT` means they are not.

CI runs the same script on every push to `main` and once a day
(`.github/workflows/verify-deployment.yml`), so a deployment that lags or
diverges from `main` shows up as a failed run.

What this proves: the on-chain program equals a build of this source tree
*with this toolchain version*. What it does not prove: that the toolchain
itself is honest. For that, use level 2.

## Level 2 — reproducible container build

[`solana-verify`](https://github.com/Ellipsis-Labs/solana-verifiable-build)
builds the program inside a pinned Docker image so the result does not
depend on anything installed on your machine.

```bash
cargo install solana-verify
# The mount path must be absolute (Docker volume syntax).
solana-verify build --library-name synxed_settlement "$PWD/programs/synxed-settlement" -- --features onchain
solana-verify get-executable-hash programs/synxed-settlement/target/deploy/synxed_settlement.so
solana-verify get-program-hash -u https://api.devnet.solana.com HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT
```

Docker must be running. On Apple Silicon the build image is `linux/amd64`
and runs under emulation, so expect the first build to take a while.

Equal hashes mean the deployed program is byte-identical to a clean-room
build of the source. `solana-verify verify-from-repo` can do the same
against a git commit directly:

```bash
solana-verify verify-from-repo -u https://api.devnet.solana.com \
  --program-id HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT \
  --library-name synxed_settlement \
  --mount-path programs/synxed-settlement \
  https://github.com/coumtech/synxed-solana-protocol
```

## Current deployment

| | |
| --- | --- |
| Program id | `HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT` |
| Cluster | devnet |
| Source | `main` at the commit named in the latest release notes / PR |
| Toolchain | Agave v4.2.1 (`cargo-build-sbf` 4.1.0, platform-tools v1.54) |

The expected hash is not hard-coded here on purpose: the check is the
comparison itself, and the CI workflow performs it against whatever `main`
currently is.

## Maintainer procedure for an upgrade

1. Merge the change to `main` (after CI and the adversarial review).
2. Build from the merged commit and upgrade in place:
   ```bash
   cargo build-sbf --manifest-path programs/synxed-settlement/Cargo.toml --features onchain
   solana program deploy programs/synxed-settlement/target/deploy/synxed_settlement.so \
     --program-id HQtacJhd73ygr8rBg8mHpmHduhS79dFvDZqXCRhoU4HT --url devnet
   ```
3. Run `scripts/verify-deployment.sh` and confirm `MATCH`.
4. Trigger the *Verify deployment* workflow (or wait for the daily run) so
   the public record shows green.

Do not merge program changes without upgrading: the docs describe `main`,
and the daily check will fail until the deployment catches up.
