# Paid API with Hono

Mock mode is enabled by default. Copy `.env.example` to `.env` to review the testnet settings; no secrets are generated.

```sh
__PACKAGE_MANAGER__ install
__PACKAGE_MANAGER__ run test
__PACKAGE_MANAGER__ run dev
```

The test requests `/api/paid`, receives a 402 challenge, retries with a mock payment, and verifies that a signed receipt is returned. To accept real payments, configure your own signer and facilitator before changing `MOCK_MODE`.
