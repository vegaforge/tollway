# Next.js paid API example

A Next.js App Router service whose routes are paywalled with
[`@vegaforge/tollway-adapter-next`](../../packages/adapter-next). Every paid
route is built from `createPaywall` and `withPaywall` and nothing else.

| Route | Price | What it returns |
| ----- | ----- | --------------- |
| `GET /api/quote` | `10000` (0.001 USDC) | A price quote |
| `POST /api/summarize` with `{ "text": "..." }` | `50000` (0.005 USDC) | The first sentence of the text |
| `GET /api/receipt-key` | free | The public key and `keyId` receipts verify against |

Prices are integer strings in USDC's smallest unit (7 decimals). An unpaid
request gets `402` with a `PAYMENT-REQUIRED` header. A paid request gets `200`
with the signed Tollway receipt in the `PAYMENT-RESPONSE` header.
`/api/summarize` checks its body before the gate, so a malformed request is
refused with `400` and never charged.

`/api/receipt-key` is temporary: [#167](https://github.com/vegaforge/tollway/issues/167)
replaces it with the well-known key set.

Gate outcomes are not fed into `@vegaforge/tollway-observability` and there
is no summary route yet: that waits for
[#106](https://github.com/vegaforge/tollway/issues/106).

## Run it locally

From the repository root:

```bash
pnpm install
pnpm turbo build --filter=@vegaforge/tollway-example-next-paid-api
pnpm --filter @vegaforge/tollway-example-next-paid-api start
```

`pnpm --filter @vegaforge/tollway-example-next-paid-api dev` runs the
development server instead (it needs the workspace packages built once).

```bash
curl -i http://localhost:3000/api/quote                                  # 402
curl -i http://localhost:3000/api/quote -H "PAYMENT-SIGNATURE: mock-1"   # 200 in mock mode
curl -s http://localhost:3000/api/receipt-key
```

Run the tests with `pnpm --filter @vegaforge/tollway-example-next-paid-api test`.

## Modes

**Mock** (`TOLLWAY_MODE=mock`, the default) needs no secrets. It uses the
mock facilitator, which accepts any non-empty `PAYMENT-SIGNATURE`, the
in-memory settlement cache, and a receipt key generated when the process
starts. Every restart therefore publishes a new key. That is fine on one
machine and wrong anywhere else.

**Testnet** (`TOLLWAY_MODE=testnet`) settles real testnet USDC through the
OpenZeppelin Channels facilitator at
`https://channels.openzeppelin.com/x402/testnet`. It needs an OpenZeppelin
Channels API key (generate one at <https://channels.openzeppelin.com/testnet/gen>)
and a stable receipt key. The defaults are the testnet USDC contract from
`@x402/stellar` and a generated testnet account for `payTo`; set
`TOLLWAY_PAY_TO` to an account you control, because nobody holds the
default's secret.

**Deployed** (`TOLLWAY_DEPLOYED=true`) is for any host that runs more than one
instance, in either mode. It requires `TOLLWAY_RECEIPT_KEY` and `REDIS_URL`,
because instances share nothing in memory:

- each instance must sign with the same key, or receipts from different
  instances verify against different keys;
- retries of one payment can reach different instances, so the settlement
  cache and its cross-process lock live in Redis
  (`createRedisSettlementCache`), and a payment settles once.

A missing or malformed setting stops the server at startup with the full list
of problems. The key is never generated silently outside local mock mode, and
error messages never contain it.

## Environment variables

Copy `.env.example` to `.env.local` for local runs. Never commit a filled-in
copy.

| Variable | Required | Meaning |
| -------- | -------- | ------- |
| `TOLLWAY_MODE` | no | `mock` (default) or `testnet`. |
| `TOLLWAY_DEPLOYED` | on hosts | `true` on a deployment. Default `false`. |
| `TOLLWAY_RECEIPT_KEY` | testnet, deployed | base64url Ed25519 private key: a 48-byte PKCS#8 document or a 32-byte seed. |
| `TOLLWAY_RECEIPT_KEY_ID` | no | Published `keyId`. Defaults to the base64url public key. |
| `REDIS_URL` | deployed | Redis connection URL, for example `rediss://user:password@host:6379`. |
| `OZ_API_KEY` | testnet | OpenZeppelin Channels API key, sent as a Bearer token. |
| `FACILITATOR_URL` | no | Overrides the testnet facilitator URL. |
| `TOLLWAY_PAY_TO` | no | Account that receives payments (`G...`). |
| `TOLLWAY_ASSET` | no | USDC Soroban contract address (`C...`). |

## Receipt key

Generate a key once and store it as a secret (a password manager, your host's
secret store). Anyone with it can sign receipts in your service's name.

```bash
node -e "crypto.subtle.generateKey('Ed25519', true, ['sign']).then((k) => crypto.subtle.exportKey('pkcs8', k.privateKey)).then((b) => console.log(Buffer.from(b).toString('base64url')))"
```

The output is the base64url PKCS#8 form that
`Ed25519Signer.fromPrivateKey` from `@vegaforge/tollway-core` loads. Set it as
`TOLLWAY_RECEIPT_KEY`. To rotate, generate a new key, set a new
`TOLLWAY_RECEIPT_KEY_ID`, and keep publishing the old public key until the
receipts it signed no longer matter.

## Redis

Any Redis 6 or later works; the cache uses `GET`, `SET` with `EX`, `SET` with
`PX NX` for the settlement lock, and `EVAL` to release and renew the lock
atomically. The client is [`ioredis`](https://github.com/redis/ioredis), and
keys live under `next-paid-api:settlement:`. Use a TLS URL (`rediss://`) for
hosted Redis.

## Deploy on Netlify

`netlify.toml` in this folder builds only this package, and skips the build
when neither the example nor a package it uses changed.

1. In Netlify, add a new site from this repository.
2. Set the package directory to `examples/next-paid-api` and leave the base
   directory empty.
3. Under Site configuration, Environment variables, set `TOLLWAY_DEPLOYED=true`,
   `TOLLWAY_RECEIPT_KEY` and `REDIS_URL` (scope them to Functions so the
   runtime sees them). For testnet also set `TOLLWAY_MODE=testnet`,
   `OZ_API_KEY` and `TOLLWAY_PAY_TO`.
4. Deploy. If a variable is missing, the function log shows the startup error
   that names it.

The dashboard deploys from the same repository with
[`apps/dashboard/netlify.toml`](../../apps/dashboard/netlify.toml): a second
Netlify site with the package directory `apps/dashboard`.
