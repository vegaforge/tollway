# `@vegaforge/tollway-demo`

Runnable flows that use Tollway end to end. Both run offline by default;
neither holds funds or needs a funded account in mock mode.

## The x402 round trip

One paid request from challenge to a verified receipt:

```bash
MOCK_MODE=true pnpm --filter @vegaforge/tollway-demo start
```

Live mode pays 0.001 testnet USDC through the OpenZeppelin Channels testnet
facilitator. It needs two testnet accounts with a USDC trustline and an API key
from [channels.openzeppelin.com/testnet/gen](https://channels.openzeppelin.com/testnet/gen).
See the root [README](../../README.md) for the variable list.

## The budget-capped agent

The Phase 3 exit criterion from `docs/design.md`: a budget-capped agent is
stopped correctly, and a drift case is flagged.

```bash
pnpm --filter @vegaforge/tollway-demo start:budget-capped
```

The scenario is `src/scenarios/budget-capped.ts`. It starts a gated Express
route with the mock facilitator and runs an agent built from `createClient`
and `createPolicyEngine`. The demo-local settler in
`src/scenarios/mock-settler.ts` performs the real 402, pay, retry exchange over
HTTP, so the gate, the policy, and the receipt path are the production ones;
only the Stellar authorization entry is a fixed transaction.

It has three phases, all on an injected clock so a run is deterministic:

1. **Budget stop.** The daily budget is exactly K times the route price
   (K = 3, price = 10 000 base units). Payments 1 to 3 settle. Payment 4 is
   refused with `PolicyBlockedError`, `rule: "budget"`, before the settler
   runs, so the facilitator receives exactly 3 verify calls and the service
   never sees request 4. The refused evaluation records nothing, so spend is
   still K payments and a smaller check that fits the remaining budget is
   allowed.
2. **Anomaly stop.** A new policy raises the daily budget and adds
   `anomaly.maxSpendPerMinute`. The burst stays inside one clock minute, so
   the request whose projected minute spend crosses the cap is refused with
   `rule: "anomaly"` at exactly the documented point.
3. **Drift.** A channel with an offline adapter commits three times, then
   closes with a settlement lower than the last commitment. The channel
   manager refuses the close with `SettlementMismatchError` and rolls the
   channel back to `open`. The stored stream and the reported settlement are
   then passed to `reconcileChannel`, which reports the `under-settled` drift
   with its shortfall. A second stream with a missing commitment reports
   `sequence-gap`. Each drift is emitted as an `anomaly.detected` event on an
   `ObservabilityHub` and printed by its local handler.

Every policy stop is also a client `skip` event. The scenario returns a typed
result the tests assert on, in `src/scenarios/budget-capped.test.ts`.

### The policies it uses

Phase 1, a daily budget of `3 * 10 000` base units:

```json
{
  "mode": "enforce",
  "budgets": { "daily": "30000" },
  "perModel": { "x402": { "enabled": true } }
}
```

Phase 2, a raised daily budget plus a per-minute anomaly stop of `25 000`
base units (two payments fit; the third projects `30 000` and is refused):

```json
{
  "mode": "enforce",
  "budgets": { "daily": "100000" },
  "anomaly": { "maxSpendPerMinute": "25000" },
  "perModel": { "x402": { "enabled": true } }
}
```

Amounts are integer strings in the asset's smallest unit. Stellar USDC has 7
decimals, so `10000` is 0.001 USDC.

Payments run sequentially. The check-then-record race for concurrent payments
is [#189](https://github.com/vegaforge/tollway/issues/189); a concurrent demo
belongs there, not here.
