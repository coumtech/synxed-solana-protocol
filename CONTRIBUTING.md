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
package README example. CI runs the smoke test on every pull request on Node
22.12.0, the minimum the package declares. The smoke test resolves the
consumer's dependencies fresh from the registry on purpose, to test what users
get, so an upstream release can break it without a change in this repository.

The **Publish SDK** workflow has three jobs. `package` builds and packs the
tarball from the lockfile with lifecycle scripts disabled and refuses a
version that is already on npm. `verify` runs the typecheck and the TypeScript
tests on the checkout, and the smoke test against that exact tarball.
`publish` checks the tarball's sha256, file names, and manifest, which GNU tar
and npm's own tar library must read identically, then stages it on npm
through trusted publishing with a provenance attestation. A staged
version stays private until a maintainer approves it on npmjs.com with
two-factor authentication. With the trusted publisher limited to staging (step
3 below), no workflow run can make a version public on its own. No npm token
is stored in GitHub.

One-time setup, in repository and npm settings, before the first release:

1. Create the GitHub environment `npm-publish` (Settings, Environments): limit
   deployment branches to `main`, add a required reviewer, and turn off
   administrator bypass. Leave "Prevent self-review" off while there is a single
   maintainer, or nobody could approve. Do this before the workflow first runs:
   a run that names a missing environment creates it without protection. The
   check for `main` inside the workflow file only catches mistakes, because a
   branch can edit its own copy.
2. Publish the first version by hand, because a trusted publisher can only be
   added to a package that exists. Run the workflow as a dry run and, within
   seven days (the artifact's retention), download its `sdk-tarball` artifact.
   It arrives as a zip; extract the `.tgz` and compare its sha256 with the one
   in the run summary. The dry run's `verify` job has already run the publish
   job's tarball check on that exact file, inside the smoke test, so this
   version meets the same rules as a staged one. Then, from the folder that holds the `.tgz`, on a
   machine logged in (`npm login`) to an npm account that is a member of the
   `@coumtech` organization with permission to create packages, run
   `npm publish --provenance=false ./<tarball file>`. The override is needed
   because the package asks for provenance, which only CI can generate, and
   the leading `./` stops npm from reading the path as a GitHub repository.
   This one version carries no provenance. Straight after, set the package's
   publishing access on npmjs.com to require two-factor authentication and
   disallow tokens; trusted publishing keeps working under that setting.
3. When the next release is ready to run (its version bump merged to `main`),
   add a trusted publisher to the package on npmjs.com: GitHub Actions,
   repository `coumtech/synxed-solana-protocol`, workflow `publish-sdk.yml`,
   environment `npm-publish`, with staged publishing only: do not allow direct
   `npm publish`, and leave dist-tag management off. npm expires a new trusted
   publisher whose first publish has not completed within two days, so stage
   the release and approve it within that window.

Each later release:

1. Bump `version` in `sdk/typescript/package.json` in a pull request. While the
   version is 0.x, a minor bump may change the API. Merge it after review.
2. Run **Publish SDK** from `main` with *publish* unchecked, a dry run.
3. Run it again with *publish* checked and approve the `npm-publish`
   deployment. The version is staged, not yet public.
4. Approve the staged version on npmjs.com, or with `npm stage approve
   <stage-id>`, using two-factor authentication. The stage id is printed by
   the workflow's "Stage on npm" step and listed by `npm stage list`. Reject
   it the same way if anything looks wrong.

## Secrets

- Never commit `.env`, keypairs, or program deploy keys. Use `.env.example`.
- Demo keypairs stay in `.keys/` on your machine (gitignored).
- CI must not hold Solana production or mainnet keys, and stores no npm token: SDK releases use npm trusted publishing. The current release targets **devnet only**.

## Code standards

- TypeScript: `strict: true`, no `any`.
- Split basis points must sum to `10000`. Invalid splits are rejected, not silently renormalized.
- Do not invent Coum private HTTP APIs. Demos construct a `SettlementRequest` locally.
- This is not a token launch, RWA issuance, or Seeker app.

## License

Contributions are accepted under the Apache License 2.0 (see `LICENSE`).
