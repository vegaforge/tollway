# ADR for Dummies: create-tollway scaffolder

- **Status:** Accepted 2026-11-18
- **Date:** 2026-11-18
- **Technical ADR:** [ADR-2026-11-18-create-tollway](ADR-2026-11-18-create-tollway.md)

## The idea

Add a command that creates a small paid API project using Express, Hono, or Next.js. Each project starts in mock mode and includes a test that proves a request can receive a payment challenge, complete a mock payment, and get a verified receipt.

## What people see

1. A developer runs `npm create tollway` or `pnpm create tollway` and chooses a framework, or passes flags to skip prompts.
2. The command creates a project with one paid route, setup instructions, and testnet configuration examples.
3. The developer runs the included test without a wallet, secret key, or network payment.

## Important limitation

Mock mode proves the integration shape, not a real payment. The template never creates or asks for secret keys; an operator must bring a signer and facilitator to accept real payments.

## What changes

The repository gains a new published scaffolder package, three checked templates, and documentation for the three framework commands.

## What does not change

The existing adapters and standalone example apps keep their APIs and purposes. The scaffolder does not hold funds or create a wallet.
