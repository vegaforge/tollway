# Inference Endpoint Example

This example exposes a paid `/complete` endpoint. The route returns a canned completion only after Tollway settles the x402 request, and the handler reads the verified receipt from `res.locals`.

## Run

From the repository root:

```bash
pnpm install
MOCK_MODE=true pnpm --filter @tollway/example-inference start
```

Request the endpoint without payment:

```bash
curl -i http://127.0.0.1:3002/complete \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Write a one-line market summary"}'
```

The unpaid request receives a `402` response with the `PAYMENT-REQUIRED` challenge.

Send a mock paid request:

```bash
curl -i http://127.0.0.1:3002/complete \
  -H "Content-Type: application/json" \
  -H "PAYMENT-SIGNATURE: mock-signed-auth-entry" \
  -d '{"prompt":"Write a one-line market summary"}'
```

`MOCK_MODE=true` uses the mock facilitator and accepts any non-empty payment signature. Without `MOCK_MODE`, configure `FACILITATOR_URL` for a real x402 facilitator.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3002` | HTTP port for the example service |
| `INFERENCE_PRICE` | `50000` | Price in the asset's smallest unit |
| `INFERENCE_ASSET` | testnet USDC asset code and issuer | Asset used in the x402 offer |
| `INFERENCE_PAY_TO` | example Stellar address | Payee address used in the offer |
| `FACILITATOR_URL` | OpenZeppelin x402 facilitator | Real facilitator endpoint |
| `MOCK_MODE` | unset | Set to `true` for local mock settlement |
