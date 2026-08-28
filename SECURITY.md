# Security Policy

## Supported versions

This repository is an early-stage public protocol. Report issues against `main`.

## Private vulnerability reporting

Do **not** open a public GitHub issue for a security vulnerability.

1. Use GitHub's private reporting flow: **Security → Report a vulnerability** on
   [coumtech/synxed-solana-protocol](https://github.com/coumtech/synxed-solana-protocol).
2. Include reproduction steps, affected paths, and impact. Do not attach
   private keys, seed phrases, or `.env` files.

We will acknowledge the report and work on a fix before any public disclosure.

## Secrets and keypairs

- Never commit `.env`, keypairs, or program deploy keys.
- Keypairs used for the devnet demo live only under `.keys/` on your machine.
- Rotate any key that was pasted into chat, CI logs, or a pull request.

## Out of scope for this repo

The proprietary SYNXED platform (radio SDK, Hub, ads, fraud, portal, backend)
is **not** in this repository. Do not send those credentials or product bugs here.
