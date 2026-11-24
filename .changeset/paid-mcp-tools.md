---
"@vegaforge/tollway-mcp": minor
"@vegaforge/tollway-server": minor
---

Add `@vegaforge/tollway-mcp` with `paidTool(config, deps)(handler)`, which charges for MCP tool calls over the x402 MCP transport and settles only after the tool succeeds. Add `createPaidCall` to `@vegaforge/tollway-server`, a transport-agnostic entry point that shares the HTTP gate's settlement path and adds an optional `beforeSettle` hook for settle-after-success. Work that fails leaves the payment unsettled and is rejected with the new gate error code `work-failed` (424), after which the same payment may be sent again. A paid call reports to the gate's payment observer (#106) the same way an HTTP payment does.
