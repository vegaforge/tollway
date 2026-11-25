---
date: 2026-11-24
feature: Tests that lock every webhook signing guarantee from #104
scope: chore
packages: [@vegaforge/tollway-observability]
scenario-impact: none
---

# Webhook signing: the remaining guarantees are tested

HMAC signing of webhook deliveries and the exported `verifyWebhookSignature`
shipped with the durable outbox in #326 (see
`2026-11-23-webhook-outbox.md` and docs/webhook-delivery.md). This change
closes #104 by testing the guarantees that were still only implied:

- A delivery signed with a different secret is rejected (`signature-mismatch`).
- A captured header replayed with its `t=` rewritten to pass the tolerance
  is rejected, because the HMAC covers the timestamp.
- A subscription without a secret sends no `Tollway-Signature` header, as
  before signing existed.
- Inline (non-outbox) retries are signed again with a fresh timestamp over the
  same body, and each retry verifies.
- The secret never appears in a `DeliveryFailure`, its error message or stack,
  or what `onDeliveryFailure` receives.

No runtime code changed, so there is no changeset.
