# ADR for Dummies: A demo that really pays on testnet

- **Status:** Accepted 2026-10-29
- **Date:** 2026-10-29
- **Technical ADR:** [ADR-2026-10-29-demo-facilitator-defaults](ADR-2026-10-29-demo-facilitator-defaults.md)

## The idea

The demo has two modes. Mock mode pretends to pay and works. Live mode is
supposed to make a real test payment on Stellar's test network, but today it
points at the wrong server, sends no password, uses a placeholder address,
and its pretend agent sends a fake payment. This change makes live mode
either work for real or stop at once with a clear list of what to set.

## What people see

1. `MOCK_MODE=true pnpm --filter @tollway/demo start` works exactly as now.
2. Running the demo without mock mode and without setup prints, in plain
   words, which settings are missing (the facilitator API key, the account
   that receives the payment, the account that pays) and stops.
3. With those settings filled in using test-network accounts, the demo pays a
   tiny amount of test USDC, receives the paid data and a signed receipt, and
   prints the on-chain transaction id.

## Important limitation

Live mode uses test money only, and needs two test accounts with USDC and an
API key from OpenZeppelin. Getting the key and the test USDC are manual web
steps. The maintainer chose to have the demo sign real payments now,
rather than wait for the client signing work in #102.

## What changes

- The demo talks to the test-network payment service by default.
- It sends the API key the service requires.
- It uses the correct USDC address and a real receiving account.
- Missing settings produce a short message, not a crash.

## What does not change

- Mock mode, and the demo's automated test.
- Any published package. Only the demo app and one opt-in test change.
