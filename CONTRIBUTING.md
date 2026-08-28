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
3. Run `bun test` and `bun run typecheck` locally. If you change the Rust program, also run `cargo fmt --check` and `cargo test` (with and without `--features onchain`) against `programs/synxed-settlement/Cargo.toml`.
4. Open a PR against `main` using the pull request template.
5. Every PR receives an **adversarial review** before merge: a reviewer (human or agent) whose explicit job is to find bugs, broken claims, and security issues in the diff — not to rubber-stamp it. Confirmed findings are fixed in the PR before it merges.
6. Do not merge your own PR unless maintainers have documented an exception.

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
