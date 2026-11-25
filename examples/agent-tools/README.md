# Agent tools example

Two agents that pay for what they use, both in mock mode: no secrets, no
network, nothing settled on chain.

| Script | What it shows |
| ------ | ------------- |
| `src/mcp-agent.ts` | An agent calls a paid MCP tool through `createTollwayMcpClient` (#207). Two forecasts are paid and their receipts verified; the third is refused by the daily budget. It prints the spend summary from the receipt store. |
| `src/ai-agent.ts` | A Vercel AI SDK model, the SDK's mock language model, uses the `paid_fetch` tool from `@vegaforge/tollway-ai-sdk` (#208). One fetch on an allowed origin is paid; one on another origin is refused before any request. |

`src/paid-weather-server.ts` is the mock paid MCP tool. It speaks the x402
MCP transport the way a Tollway gate does: `PaymentRequired` on an unpaid
call, and the signed receipt in `_meta["tollway/receipt"]` on a paid one.

The AI SDK script pays through a stand-in paid fetch built on a real Tollway
client and policy engine. Swap in `createPaidFetch` from
`@vegaforge/tollway-client` once #201 ships.

## Run it

From the repository root:

```bash
pnpm install
pnpm turbo run build --filter='@vegaforge/tollway-example-agent-tools...'
pnpm --filter @vegaforge/tollway-example-agent-tools mcp
pnpm --filter @vegaforge/tollway-example-agent-tools ai
```

Run the tests with `pnpm turbo run test --filter=@vegaforge/tollway-example-agent-tools`.
