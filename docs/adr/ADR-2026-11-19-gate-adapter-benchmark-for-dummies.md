# ADR for Dummies: Gate and adapter benchmark regression checks

- **Status:** Proposed, awaiting maintainer approval
- **Date:** 2026-11-19
- **Technical ADR:** [ADR-2026-11-19-gate-adapter-benchmark](ADR-2026-11-19-gate-adapter-benchmark.md)

## The idea

No benchmarks exist. Gate verification, signing, canonicalization, cache and replay paths need measurable performance. Shared CI runners make absolute baselines unreliable.

## What people see

1. Use a private benchmark workspace to avoid adapter cross-dependencies; pin Vitest 4.1.8, exclude *.bench.ts from vitest run.

2. Benchmark 402 challenge, fresh x402, replay, fresh mpp-charge, N concurrent identical requests and a mocked Redis cache/lock variant.

3. Exercise Express via ephemeral listen(0) and keep-alive HTTP, Fastify inject, Hono app.request, Next handler(Request); isolate canonicalJson, signing, verification, headers and nonce digest.

## Important limitation

ioredis-mock measures code paths, not real Redis; shared runner measurements are noisy.

## What changes

After maintainer approval, this issue's feature or test coverage will be implemented and verified.

## What does not change

These proposal documents do not alter production code, payment settlement or policy enforcement.
