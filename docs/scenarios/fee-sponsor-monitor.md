# Observe a fee sponsor without moving funds

1. Run `MOCK_MODE=true pnpm --filter @vegaforge/tollway-demo start`. Before the
   payment, the demo prints an offline sponsor reading of `1000000000` stroops.
2. In a service, wire `createSponsorMonitor({ network, accounts, thresholdStroops,
   hysteresisStroops, sink: hub })` to an observability hub and call `start()`.
   Use only actual fee-payer G... accounts. Call `stop()` on shutdown.
3. Inject a reader returning, in order, balances above threshold, below it, below
   it again, above threshold plus hysteresis, and below threshold again. Expect
   exactly two `sponsor.low_balance` events. This is automated in
   `packages/server/src/sponsor-monitor.test.ts`.
4. Make the reader reject. The latest hub reading becomes stale with an error
   and no balance. `renderFeeSponsorMetrics(hub)` emits stale=1 and omits that
   balance sample. It never fabricates zero. Hub and renderer tests cover this.
5. For a live test, configure the demo's documented Stellar and OpenZeppelin
   settings plus `FEE_SPONSOR_ACCOUNTS`. Confirm the sponsor with your operator;
   a `/supported` signer alone does not prove it pays fees. The live reading uses
   Horizon. Neither the monitor nor this scenario funds or signs for the sponsor.
