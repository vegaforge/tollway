# Data Feed Paywall Example

This example sells one `/feed` response per request with the Tollway Express adapter. The route is protected by `createPaywall`, so unpaid clients receive an x402 `402 Payment Required` challenge and paid clients receive the feed payload.

## Run

From the repository root:

```bash
pnpm install
MOCK_MODE=true pnpm --filter @tollway/example-data-feed start
```

Open a second terminal and request the feed without payment:

```bash
curl -i http://127.0.0.1:3001/feed
```

The response is a `402` with the `PAYMENT-REQUIRED` header and a JSON challenge body.

For a mock paid request:

```bash
curl -i http://127.0.0.1:3001/feed \
  -H "PAYMENT-SIGNATURE: mock-signed-auth-entry"
```

`MOCK_MODE=true` uses Tollway's mock facilitator, which accepts any non-empty payment signature. Drop `MOCK_MODE` to use a real facilitator and set `FACILITATOR_URL` when you need a custom endpoint.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port for the example service |
| `FEED_PRICE` | `25000` | Price in the asset's smallest unit |
| `FEED_ASSET` | testnet USDC asset code and issuer | Asset used in the x402 offer |
| `FEED_PAY_TO` | example Stellar address | Payee address used in the offer |
| `FACILITATOR_URL` | OpenZeppelin x402 facilitator | Real facilitator endpoint |
| `MOCK_MODE` | unset | Set to `true` for local mock settlement |
