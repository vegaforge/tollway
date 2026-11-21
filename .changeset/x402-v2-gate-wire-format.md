---
"@vegaforge/tollway-server": minor
"@vegaforge/tollway-core": minor
---

The gate speaks the x402 V2 wire format. `PAYMENT-REQUIRED` now carries a standard-base64 `PaymentRequired` (`x402Version: 2`, `resource`, `accepts`), also sent as the 402 body. `PAYMENT-SIGNATURE` is decoded as a V2 `PaymentPayload`; a malformed header or a version other than 2 is rejected with 400. The HTTP facilitator forwards the decoded payload unchanged. A settlement puts the facilitator's `SettleResponse` in `PAYMENT-RESPONSE` and the signed Tollway receipt in the new `TOLLWAY-RECEIPT` header (`TOLLWAY_RECEIPT_HEADER`). Breaking: `X402Payment` carries the decoded `PaymentPayload` instead of a bare `paymentSignature` string, and `PaywallConfig` gains `maxTimeoutSeconds` and `extra` so the challenge names the same terms the facilitator verifies.
