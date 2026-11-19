---
date: 2026-11-19
feature: A Next.js paid API example that deploys next to the dashboard, and a way to load a persisted receipt key
scope: feat
packages: [@vegaforge/tollway-core]
scenario-impact: none
---

# Next.js paid API example and persisted receipt keys

`examples/next-paid-api` is a Next.js 16 App Router service with two paid
routes at different prices (`GET /api/quote` for 0.001 USDC, `POST
/api/summarize` for 0.005 USDC), built only with `createPaywall` and
`withPaywall`, and a read-only `GET /api/receipt-key` that publishes the
receipt public key and `keyId` until #167 replaces it with the well-known key
set. It runs in mock mode with no secrets, or on testnet through the
OpenZeppelin Channels facilitator. Its README covers local runs, both modes,
every environment variable, the receipt key, Redis and the Netlify deploy.
Closes #250.

A serverless deployment broke two assumptions the earlier examples made
silently, and both are now solved in code:

- **One receipt key across instances.** `@vegaforge/tollway-core` adds
  `Ed25519Signer.fromPrivateKey(encodedKey, keyId?)`, which imports a
  persisted Ed25519 key with WebCrypto only, so it runs on Node and edge
  runtimes. The `keyId` defaults to the base64url public key, so it is stable
  for a given key. A key that is not base64url, has the wrong length or is not
  Ed25519 throws a `TollwayError` with the new code `invalid-signing-key`, and
  the message never contains the key.
- **One settlement across instances.** In deployed mode the example uses
  `createRedisSettlementCache` with a real Redis client, so the cross-process
  lock stops two instances settling one payment.

The example validates its configuration at startup through Next.js
instrumentation: a missing or malformed receipt key outside local mock mode,
or a deployment without Redis, stops the server with the list of problems.

`apps/dashboard/netlify.toml` and `examples/next-paid-api/netlify.toml`,
modelled on `apps/web/netlify.toml`, let both deploy from this repository.
The dashboard config adds no data wiring (#237). `examples/*` joins
`pnpm-workspace.yaml`, and the example is in the changeset `ignore` list.
`@vegaforge/tollway-adapter-next` already declared `^16.0.0` and tests
against Next 16.4.6, which the example uses, so its manifest is unchanged.
Gate outcomes are not fed into `@vegaforge/tollway-observability` yet, since
#106 has not merged; the README says so.

## Choices the issue left open

- **Key format.** `TOLLWAY_RECEIPT_KEY` is base64url (no padding) holding
  either the 48-byte PKCS#8 document that `crypto.subtle.exportKey("pkcs8")`
  produces or the bare 32-byte seed. WebCrypto cannot import a raw Ed25519
  private key, so a seed is wrapped in the fixed RFC 8410 PKCS#8 header before
  import. The constructor is `Ed25519Signer.fromPrivateKey`. The issue asked
  for this to be agreed in its thread first; it was not, so the maintainer
  should confirm the name and formats in review.
- **Deployed flag.** Deployment is an explicit `TOLLWAY_DEPLOYED=true`
  rather than a guess from the host's environment, and it applies in both
  modes. It requires `TOLLWAY_RECEIPT_KEY` and `REDIS_URL`.
- **Redis client.** `ioredis`, already in the lockfile through `ioredis-mock`.
  A small typed adapter maps it to `RedisLikeClient` instead of casting.
- **Startup failure.** The service exits with status 1 when instrumentation
  finds a bad configuration, because Next.js otherwise logs the error and
  keeps serving 500s.
- **Default `payTo`.** A testnet account generated for the example, so the
  default is a valid strkey; its secret was discarded, and the README tells
  users to set their own.
