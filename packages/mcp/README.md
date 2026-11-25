# @vegaforge/tollway-mcp

Paid MCP tools. `paidTool(config, deps)(handler)` wraps a Model Context Protocol tool handler so a call is charged with an x402 payment, settled only after the tool succeeds, and answered with a signed Tollway receipt. It follows the x402 MCP transport (`specs/transports-v2/mcp.md` in the x402 repository) and settles through the same path as the HTTP gate in [`@vegaforge/tollway-server`](../server): the same facilitator, settlement cache, replay protection and offer binding.

Full documentation: [`apps/web/src/content/docs/mcp.mdx`](../../apps/web/src/content/docs/mcp.mdx). A runnable example: [`examples/paid-mcp-tool`](../../examples/paid-mcp-tool).

## Use

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Ed25519Signer } from "@vegaforge/tollway-core";
import { paidTool } from "@vegaforge/tollway-mcp";
import { createInMemorySettlementCache, createMockFacilitator } from "@vegaforge/tollway-server";
import { z } from "zod";

const signer = await Ed25519Signer.generate("tools-key");
const server = new McpServer({ name: "quotes", version: "1.0.0" });

server.registerTool(
  "get-quote",
  { description: "Latest quote", inputSchema: { symbol: z.string() } },
  paidTool(
    {
      toolName: "get-quote",
      amount: "10000", // 0.001 USDC in base units
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      payTo: "GBR4MM3F4WLDE7VETP5FL4TQDTYIRR7A6QI3JPDCM4BSOHMRIABLSU4K",
      network: "testnet",
    },
    { signer, facilitator: createMockFacilitator(), cache: createInMemorySettlementCache() },
  )(async ({ symbol }: { symbol: string }) => ({
    content: [{ type: "text" as const, text: `${symbol}/USD 0.1234` }],
  })),
);
```

## What a call gets

| Call | Result |
| --- | --- |
| No `_meta["x402/payment"]` | `isError: true`, the x402 `PaymentRequired` in `structuredContent` and as JSON in `content[0].text`. The tool does not run. |
| A malformed payment, one for other terms, or one the facilitator does not verify | The same, with the reason in `PaymentRequired.error`. The tool does not run. |
| A verified payment | The tool runs. On success the payment settles, and the result carries `_meta["x402/payment-response"]` (the x402 `SettleResponse`) and `_meta["tollway/receipt"]` (the signed receipt). |
| The tool throws or returns `isError: true` | Nothing settles. The payment stays usable for a retry. |
| Settlement fails after the tool ran | Only the payment error, never the tool's content. |
| The same payment again | The cached receipt; nothing settles twice. The tool runs again for the retry. |

The receipt's `resource` is the tool's resource id, `mcp://tool/<toolName>` unless `resource` is set, and a v2 receipt's `method` is `tools/call`.

The package depends on `@vegaforge/tollway-server`, `@vegaforge/tollway-core` and `@x402/core`. It does not depend on `@modelcontextprotocol/sdk`: its types are a structural subset of the SDK's tool callback, so any 1.x `McpServer` accepts the wrapped handler.
