---
date: 2026-11-24
feature: Pay for MCP tools from an agent through the Tollway client
scope: feat
packages:
  - "@vegaforge/tollway-client"
scenario-impact: none
---

# Pay for MCP tools through the Tollway client

An agent can now call paid MCP tools and have Tollway decide whether to pay. `createTollwayMcpClient` in the new `@vegaforge/tollway-client/mcp` subpath wraps an MCP client: when a tool answers with the x402 MCP payment request, the payment goes through `pay()`, so offer checks, quarantine, policy, the retry rules, receipt verification, receipt-to-offer binding and the receipt store all apply. The tool result comes back with the verified receipt.

The challenge is read where the x402 MCP transport puts it (`structuredContent`, or JSON in the first text block) and parsed with the x402 V2 schema; a tool error that is not a valid challenge is returned unchanged and never paid. The offer's resource is the challenge's `resource.url`. A policy block rejects with `PolicyBlockedError` and a `skip` event, and so does an `onPaymentRequested` refusal. Paid calls to the same tool are paid one at a time, so concurrent calls never swap arguments and payments. The receipt is read from `_meta["tollway/receipt"]`, the key a Tollway gate uses (#206). The wrapper is typed against the shape of an MCP client, so the subpath does not import the MCP SDK.

`examples/agent-tools` runs an agent against a mock paid MCP tool and prints its spend summary. Docs: `apps/web/src/content/docs/mcp-tools.mdx`.

Closes #207. Pull request: #347.
