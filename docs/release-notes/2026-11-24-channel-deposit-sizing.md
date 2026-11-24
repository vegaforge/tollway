---
date: 2026-11-24
feature: Channel deposits sized from headroom, and a minimum-deposit fix
scope: fix
packages: ["@vegaforge/tollway-core", "@vegaforge/tollway-channels"]
scenario-impact: none
---

# Channel deposits sized from headroom

A channel's deposit was whatever the caller passed, and the policy's minimum
deposit was checked against the wrong number. This release fixes the check and
adds the two inputs a caller needs to size a deposit.

## What changed

- **Fix: `minChannelDeposit` no longer blocks channel payments.** The rule
  compared each per-request channel price with the minimum deposit. A price
  below the minimum was blocked, and no deposit was ever checked. The rule now
  applies only to channel opens. A channel payment's trace entry reads
  `not-applicable`. Four existing tests asserted the old behavior, two in
  the policy tests and two in the trace tests. They now assert the fixed behavior.
- **`PolicyEngine.headroom(asset, payee)`.** Returns the tightest remaining
  amount across the daily budget, the total budget and the payee's per-service
  lifetime cap, `dailyCap` and rolling `window`, as an integer string, and names
  the ceiling in `limitedBy`. Read-only.
- **`PolicyEngine.evaluateChannelOpen({ payee, asset, deposit })`.** Checks a
  deposit against `minChannelDeposit` and the headroom. Returns `allowed`,
  `wouldBlock`, the blocking `rule`, and a `detail`. Records no spend. Dry-run
  mode reports the would-be block and allows it.
- **`sizeDeposit` in `@vegaforge/tollway-channels`.** A pure function. It sizes
  a deposit to predicted demand over a horizon, applies a safety factor in basis
  points, rounds demand up, and clamps the result to the minimum and to the
  tighter of the caller's maximum and the headroom. It returns `open: false` when
  there is no predicted demand or the headroom is below the minimum, with a reason
  fit for a log line.

Both `PolicyEngine` methods are optional, so engines written before this release
still satisfy the interface.

## Behavior to know about

- A channel with zero predicted demand is not opened. The function does not
  fall back to the minimum deposit, because a channel that locks funds nobody will
  spend is not worth opening.
- Requests per minute are rounded to a millionth before sizing. Amounts are
  `bigint` throughout, and the result is exact for any integer price up to
  `2^127 - 1`.
- A deposit is not spend. An open records none, and unspent funds return to the
  funder on close.

`sizeDeposit` is not wired into `ChannelManager.open`. The caller sizes the
deposit, then opens the channel.

See [docs/design.md](../design.md), "The channel lifecycle manager", and the
policy documentation, "Channel opens and headroom".
