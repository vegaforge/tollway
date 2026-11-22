# Data feed paywall example

A small Express service that sells one read of a data feed per request with
x402. `GET /feed` sits behind `expressPaywall(createPaywall(...))` from
[`@vegaforge/tollway-adapter-express`](../../packages/adapter-express) and
[`@vegaforge/tollway-server`](../../packages/server). The route holds no payment
logic of its own.

| Route | Price | What it returns |
| ----- | ----- | --------------- |
| `GET /feed` | `10000` (0.001 USDC) | Three canned XLM/USD ticks and the receipt id |

The price is an integer string in USDC's smallest unit (7 decimals). An
unpaid request gets `402` with a `PAYMENT-REQUIRED` header. A paid request gets
`200` with the x402 `SettleResponse` in the `PAYMENT-RESPONSE` header and the
signed Tollway receipt in the `TOLLWAY-RECEIPT` header. The handler reads the
same receipt from `res.locals.tollwayReceipt` and returns its id.

The whole service is [`src/server.ts`](src/server.ts), and
[`src/server.test.ts`](src/server.test.ts) is its smoke test.

## Run it in mock mode

Mock mode is the default. It needs no secrets and reaches no network: the mock
facilitator accepts any well-formed x402 V2 payment, and the receipt key is
generated when the process starts.

From the repository root:

```bash
pnpm install
pnpm turbo run build --filter='@vegaforge/tollway-example-data-feed...'
pnpm --filter @vegaforge/tollway-example-data-feed start
```

The first request has no payment and gets the challenge:

```bash
curl -i http://localhost:3000/feed   # 402
```

To pay it, answer the challenge with an x402 V2 `PaymentPayload` that accepts
exactly what the challenge asks. In mock mode any transaction string stands in
for the signed authorization entry:

```bash
CHALLENGE=$(curl -s -D - -o /dev/null http://localhost:3000/feed \
  | awk 'tolower($1) == "payment-required:" { print $2 }' | tr -d '\r')

PAYMENT=$(node -e 'const challenge = JSON.parse(Buffer.from(process.argv[1], "base64").toString()); const payment = { x402Version: 2, accepted: challenge.accepts[0], payload: { transaction: "mock-signed-auth-entry" } }; console.log(Buffer.from(JSON.stringify(payment)).toString("base64"));' "$CHALLENGE")

curl -i http://localhost:3000/feed -H "PAYMENT-SIGNATURE: $PAYMENT"   # 200
```

The answer is `200` with the feed and a `receiptId`, plus the
`PAYMENT-RESPONSE` and `TOLLWAY-RECEIPT` headers.

Run the tests with `pnpm turbo run test --filter=@vegaforge/tollway-example-data-feed`.

## Run it on testnet

`TOLLWAY_MODE=testnet` settles real testnet USDC through the OpenZeppelin
Channels facilitator at `https://channels.openzeppelin.com/x402/testnet`.

It needs an OpenZeppelin Channels API key. Generate one at
<https://channels.openzeppelin.com/testnet/gen> and pass it as `OZ_API_KEY`;
the service refuses to start on testnet without it.

```bash
TOLLWAY_MODE=testnet \
OZ_API_KEY=<your key> \
TOLLWAY_PAY_TO=<a testnet account you control, G...> \
pnpm --filter @vegaforge/tollway-example-data-feed start
```

The defaults are the testnet USDC contract from `@x402/stellar` and a testnet
account generated for this example. Nobody holds that account's secret, so
set `TOLLWAY_PAY_TO` before taking payments you want to keep.

The paying side is an x402 V2 client for Stellar with a funded testnet account
holding USDC. `createStellarPayer` in
[`apps/demo/src/demo.ts`](../../apps/demo/src/demo.ts) shows the smallest one:
it signs the payment for a challenge with `@x402/stellar`.

## Environment variables

The service reads its settings from the environment and loads no `.env` file.
Pass them inline, as in the testnet command above, or export them in your shell.

| Variable | Required | Meaning |
| -------- | -------- | ------- |
| `TOLLWAY_MODE` | no | `mock` (default) or `testnet`. |
| `PORT` | no | Port to listen on. Default `3000`. |
| `OZ_API_KEY` | testnet | OpenZeppelin Channels API key, sent as a Bearer token. |
| `FACILITATOR_URL` | no | Overrides the testnet facilitator URL. |
| `TOLLWAY_PAY_TO` | no | Account that receives payments (`G...`). |
| `TOLLWAY_ASSET` | no | USDC Soroban contract address (`C...`). |

A missing or malformed setting stops the service at startup with the full list
of problems.

## Before you copy this into a real service

The example keeps to one file, so it leaves out three things a deployment
needs. [`examples/next-paid-api`](../next-paid-api) shows all of them.

- **A stable receipt key.** This example generates a key per process, so
  receipts stop verifying against the running service after a restart. Load a
  key from configuration and publish its public half.
- **A shared settlement cache.** The in-memory cache settles a payment once per
  process. With more than one instance, use `createRedisSettlementCache`.
- **A real payee.** Set `TOLLWAY_PAY_TO` to an account you control.
