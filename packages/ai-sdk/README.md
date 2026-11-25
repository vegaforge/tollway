# @vegaforge/tollway-ai-sdk

A Vercel AI SDK tool that lets a model fetch paid URLs within a Tollway
budget. `createPaidFetchTool` builds a `paid_fetch` tool with the AI SDK's
`tool()` helper on top of a Tollway paid fetch, which does the paying.

## Install

```bash
pnpm add @vegaforge/tollway-ai-sdk ai zod
```

`ai` 7 and `zod` 4 are peer dependencies.

## Use it

```ts
import { createPaidFetchTool } from "@vegaforge/tollway-ai-sdk";
import { generateText, stepCountIs } from "ai";

const { text } = await generateText({
  model,
  tools: {
    paid_fetch: createPaidFetchTool({
      paidFetch,
      allowedOrigins: ["https://api.example.com"],
      policy,
    }),
  },
  stopWhen: stepCountIs(5),
  prompt: "What is the XLM/USD price?",
});
```

Origins and methods the host did not allow are refused before any request.
A policy block or a failed offer check, such as a price over the per-call
ceiling set in the paid fetch's `offerChecks.maxAmount`, comes back as
`{ status: "blocked", rule, detail }`. The model sees a receipt summary, never
the signature.

See the [AI SDK guide](https://github.com/vegaforge/tollway/blob/dev/apps/web/src/content/docs/ai-sdk.mdx)
for the safety defaults and result shapes.
