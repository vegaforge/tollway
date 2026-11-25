# Paid MCP tool example

An MCP server with one paid tool, `get-quote`, wrapped with `paidTool(...)` from [`@vegaforge/tollway-mcp`](../../packages/mcp). An agent in the same process calls it over an in-memory MCP transport, so the whole flow runs in mock mode with no network and no secrets.

The agent makes three calls:

1. Without a payment. The tool does not run; the result is `isError: true` with the x402 `PaymentRequired` in `structuredContent`.
2. With an x402 V2 `PaymentPayload` in `_meta["x402/payment"]`. The payment is verified, the tool runs, and only then does the payment settle. The result carries the quote, `_meta["x402/payment-response"]` and the signed receipt in `_meta["tollway/receipt"]`, which the agent verifies.
3. With the same payment again. The receipt is replayed from the settlement cache and nothing settles a second time.

The price is `10000`, 0.001 USDC in its smallest unit (7 decimals). In mock mode any transaction string stands in for the signed Soroban authorization entry; a real agent builds it with `@x402/stellar`.

## Run it

From the repository root:

```bash
pnpm install
pnpm turbo run build --filter='@vegaforge/tollway-example-paid-mcp-tool...'
pnpm --filter @vegaforge/tollway-example-paid-mcp-tool start
```

The whole example is [`src/main.ts`](src/main.ts), and [`src/main.test.ts`](src/main.test.ts) checks the same three calls. Run it with `pnpm turbo run test --filter=@vegaforge/tollway-example-paid-mcp-tool`.
