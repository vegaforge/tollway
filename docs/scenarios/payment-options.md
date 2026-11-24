# Pay a two-option route with the second option

1. Run `MOCK_MODE=true pnpm --filter @vegaforge/tollway-demo start payment-options`.
   The demo prints `Offered in one 402: stellar:pubnet 10000, stellar:testnet 20000`,
   then a row for the paid request with amount `20000`, and
   `Receipt signature valid: true`.
2. The receipt names the option paid (`network: testnet`, `amount: 20000`), and
   only the testnet option's facilitator was called. This is automated in
   `apps/demo/src/scenarios/payment-options.test.ts` and, through Express, in
   `packages/adapter-express/src/payment-options.test.ts`.
3. Send the same payment again with `accepted` set to the first option. Expect
   `409` with code `offer-mismatch`. Send one whose `accepted` lowers the
   amount. Expect `402` with code `payment-invalid` and a fresh
   `PAYMENT-REQUIRED` listing both options. Both are automated in
   `packages/server/src/gate-payment-options.test.ts`.
