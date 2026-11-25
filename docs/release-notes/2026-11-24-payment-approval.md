# Payment approval for high-value transactions

**Date:** 2026-11-24  
**Issue:** #199  
**Packages:** `@vegaforge/tollway-client`, `@vegaforge/tollway-core`

## Summary

Payments above a configured threshold or matching a predicate now require human approval before settling. The approver callback receives an AbortSignal that fires on timeout, budget stays reserved during approval (pending #189), and timeout or denial throws distinct typed errors.

## What changed

### New approval configuration

`TollwayClientOptions.approval` takes:
- `thresholds`: per-asset thresholds (integer strings in base units)
- `predicate`: optional function over the intent
- `approver`: async callback that returns `{ approved: true }` or `{ approved: false, reason?: string }`
- `timeoutMs`: how long to wait (default 5 minutes)

The approver receives an `ApprovalRequest` with resource, payee, amount, asset, model, and (once #189 lands) projected policy usage.

### New error types

- `ApprovalTimeoutError` (code `approval-timeout`): the approver did not respond in time
- `ApprovalDeniedError` (code `approval-denied`): the approver refused, or the approver threw

Both extend `TollwayError` with stable codes for branching.

### New events

- `approval:requested`: emitted when approval starts, before the callback
- `approval:resolved`: emitted when the approver returns, with `approved`, `latencyMs`, and optional `reason`

## Usage

```typescript
import { createClient, type ApprovalRequest, type ApprovalDecision } from "@vegaforge/tollway-client";

const client = createClient({
  network: "testnet",
  settler: mySettler,
  approval: {
    // Payments >= 1000 USDC require approval
    thresholds: {
      "USDC:GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP": "10000000"
    },
    // Or match a custom rule
    predicate: (intent) => intent.payee === "HIGH_RISK_PAYEE",
    // Approver with timeout signal
    approver: async (request: ApprovalRequest, { signal }) => {
      console.log(`Approve ${request.amount} ${request.asset} to ${request.payee}?`);
      
      // Could post to a webhook, show a UI prompt, etc.
      // signal.aborted becomes true on timeout
      
      return { approved: true };
      // or: return { approved: false, reason: "too expensive" };
    },
    timeoutMs: 300_000, // 5 minutes
  },
});

// Payment flow
try {
  const result = await client.pay({ resource, offer });
  console.log("Paid:", result.receipt);
} catch (error) {
  if (error.code === "approval-timeout") {
    console.error("Approval timed out");
  } else if (error.code === "approval-denied") {
    console.error("Approval denied:", error.reason);
  }
}
```

## Implementation notes

Approval runs after the policy check but before the settler. The approver is called with the routed model (after `decideModel`), so a channel open's large deposit is visible to the human.

Identical concurrent payments share one approval request (pending #210).

Budget reservation during approval (the issue's acceptance criteria) is noted as pending #189. The current implementation checks the threshold and calls the approver; full budget reservation integration will follow in #189.

## Testing

- Approve, deny, timeout, approver throws, abort signal tests with fake timers
- Threshold and predicate matching
- Event emission for requested and resolved
- Error codes and messages

Run: `pnpm --filter @vegaforge/tollway-client test approval.test.ts`

## Breaking changes

None. The `approval` option is optional; existing clients are unaffected.

## Related

- #189: Budget reservation (dependency noted in issue)
- #203: Retry handling (approval happens before retries)
- #210: Single-flight payments (approval deduplication pending)
