# Contributing

This is the public **SYNXED Solana settlement protocol** (Coum Technologies Ltd, Ireland). It is not the SYNXED product. Do not copy proprietary radio SDK, Hub, ads, fraud, portal, or backend code into this repository.

## Branch protection (do not bypass)

- Default branch is `main`.
- **Never commit directly to `main` after Day 0 bootstrap.** Open a pull request.
- `main` requires:
  - a pull request
  - 1 approving review
  - CODEOWNERS review
  - stale reviews dismissed on new pushes
  - all review conversations resolved
  - CI status checks
  - no force-push
  - no branch deletion
- Direct pushes to `main` are restricted. Admins must not bypass these rules.

## Workflow

1. Fork or create a feature branch from `main`: `feat/*`, `fix/*`, `docs/*`, or `test/*`.
2. Keep changes scoped to this protocol (split math, program, TypeScript SDK, demo, docs).
3. Run `bun test` and `bun run typecheck` locally. If you change the Rust program, also run `cargo fmt --check` and `cargo test` (with and without `--features onchain`) against `programs/synxed-settlement/Cargo.toml`. Processor changes must also pass the in-process SVM tests: build with `cargo build-sbf --manifest-path programs/synxed-settlement/Cargo.toml --features onchain`, then `cargo test --manifest-path programs/synxed-settlement/svm-tests/Cargo.toml` (needs Rust 1.89 or newer for the SVM test dependencies).
4. Open a PR against `main` using the pull request template.
5. Every PR receives an **adversarial review** before merge: a reviewer (human or agent) whose explicit job is to find bugs, broken claims, and security issues in the diff — not to rubber-stamp it. Confirmed findings are fixed in the PR before it merges.
6. Do not merge your own PR unless maintainers have documented an exception.

## Changing the on-chain program

Program changes are not done when they merge — they are done when the
reference devnet deployment matches `main` again. Follow the upgrade
procedure in [docs/verified-build.md](docs/verified-build.md) right after
merging, then confirm with `scripts/verify-deployment.sh`. The *Verify
deployment* workflow runs the same check daily and fails on drift.

## Releasing the TypeScript SDK

The SDK in `sdk/typescript` is published to npm as
`@coumtech/synxed-solana-protocol`. The workspace package exports TypeScript
sources for the tests and examples in this repository and stays
`"private": true`, so it can never be published as it is.
`bun run build:sdk` compiles it into `sdk/typescript/dist/package` with a
generated manifest, and `bun run smoke:sdk` packs that directory, installs the
tarball into a fresh Node project, runs it, and type-checks a consumer and the
package README example. CI runs the smoke test on every pull request.

1. Bump `version` in `sdk/typescript/package.json` in a pull request. While the
   version is 0.x, a minor bump may change the API. Merge it after review.
2. Run the **Publish SDK** workflow from `main` with *publish* unchecked. It
   repeats the checks, refuses a version that is already on npm, and runs
   `npm publish --dry-run`.
3. Run it again with *publish* checked. The package is published with an npm
   provenance attestation that links it to the workflow run and the commit.

Publish through the workflow, not from a local machine, so every version
carries provenance.

Authentication: the workflow uses npm trusted publishing when it is
configured on npmjs.com for this repository, the workflow file
`publish-sdk.yml`, and the environment `npm-publish`. Trusted publishing is
set up from the package's settings page, so the first release instead uses an
`NPM_TOKEN` secret stored in the `npm-publish` GitHub environment: a granular
npm access token with read and write access to `@coumtech` packages. Once
trusted publishing is configured, delete the secret and revoke the token.

## Secrets

- Never commit `.env`, keypairs, or program deploy keys. Use `.env.example`.
- Demo keypairs stay in `.keys/` on your machine (gitignored).
- CI must not hold production or mainnet keys. The current release targets **devnet only**.

## Code standards

- TypeScript: `strict: true`, no `any`.
- Split basis points must sum to `10000`. Invalid splits are rejected, not silently renormalized.
- Do not invent Coum private HTTP APIs. Demos construct a `SettlementRequest` locally.
- This is not a token launch, RWA issuance, or Seeker app.

## License

Contributions are accepted under the Apache License 2.0 (see `LICENSE`).
