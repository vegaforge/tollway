---
"@vegaforge/tollway-server": minor
---

Adds the x402 offer-receipt extension to the gate, opt-in per route with `PaywallConfig.offerReceipt`. A 402 then carries a signed JWS offer per x402 requirement and a settled x402 payment's PAYMENT-RESPONSE carries a signed JWS receipt, both in the format `@x402/extensions/offer-receipt` reads. Adds `createOfferReceiptJwsSigner`, `didKeyFromEd25519PublicKey` and the `OfferReceiptOptions` type. Responses are unchanged when the option is off.
