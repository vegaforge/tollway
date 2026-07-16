# Content Paywall Example

This example serves a small premium HTML page only after a Tollway x402 payment settles. It demonstrates both sides of the flow: unpaid clients receive a `402` challenge and paid clients receive the protected content.

## Run

From the repository root:

```bash
pnpm install
MOCK_MODE=true pnpm --filter @tollway/example-content-paywall start
```

Request the premium page without payment:

```bash
curl -i http://127.0.0.1:3003/premium
```

The response is a `402` and includes the `PAYMENT-REQUIRED` header.

Request it with a mock payment:

```bash
curl -i http://127.0.0.1:3003/premium \
  -H "PAYMENT-SIGNATURE: mock-signed-auth-entry"
```

With `MOCK_MODE=true`, any non-empty payment signature is accepted by the mock facilitator. Without mock mode, set `FACILITATOR_URL` to a real x402 facilitator and provide a real signed payment.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3003` | HTTP port for the example service |
| `CONTENT_PRICE` | `15000` | Price in the asset's smallest unit |
| `CONTENT_ASSET` | testnet USDC asset code and issuer | Asset used in the x402 offer |
| `CONTENT_PAY_TO` | example Stellar address | Payee address used in the offer |
| `FACILITATOR_URL` | OpenZeppelin x402 facilitator | Real facilitator endpoint |
| `MOCK_MODE` | unset | Set to `true` for local mock settlement |
