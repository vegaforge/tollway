# Paid API with Next.js App Router

This template uses Next 15, which is within the adapter's supported peer range. Mock mode is enabled by default. Copy `.env.example` to `.env` to review testnet settings; no secrets are generated.

```sh
__PACKAGE_MANAGER__ install
__PACKAGE_MANAGER__ run test
__PACKAGE_MANAGER__ run dev
```

The paid route is `app/api/paid/route.ts`. Its test receives the 402 challenge, retries with a mock payment, and checks the signed receipt response. Configure your own signer and facilitator before changing `MOCK_MODE`.
