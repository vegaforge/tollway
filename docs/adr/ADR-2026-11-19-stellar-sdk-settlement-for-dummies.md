# ADR for Dummies: Real Stellar payments for MPP and the agent client, and a cache that cleans up after itself

- **Status:** Accepted 2026-11-19
- **Date:** 2026-11-19
- **Technical ADR:** [ADR-2026-11-19-stellar-sdk-settlement](ADR-2026-11-19-stellar-sdk-settlement.md)

## The idea

Until now, three pieces of Tollway only worked with pretend payments: MPP
"charge" payments on the service side, MPP payment channels, and the agent
side of x402. This change connects each of them to the official Stellar
libraries so they can move real testnet money. It also stops a memory list of
past payments from growing forever.

## What people see

1. A service owner turns on MPP charge for a route by adding one handler. An
   agent that asks for the route without paying gets a "payment required"
   answer that both x402 and MPP agents understand.
2. An MPP agent pays, the service checks the payment, sends the money
   straight from the agent to the service on Stellar, and hands back a
   Tollway receipt with the transaction id. If the agent's request is
   retried, the payment is not taken twice.
3. An agent developer gives the Tollway client an "x402 settler" with their
   signing key. The client then pays x402 routes on Stellar by itself, and
   refuses to sign if the service asks for more than was approved.
4. A channel user points Tollway at a payment channel they already set up on
   Stellar. Tollway signs many small promises off chain and settles them
   with a single on-chain transaction at the end.
5. A service that runs for weeks no longer keeps every past payment in
   memory: old entries are thrown away as new ones arrive, and the list has
   a size limit.

## Important limitation

Tollway does not create payment channels; it expects one that is already
deployed and funded. The agent-side x402 settler talks the newer x402 wire
format, which Tollway's own gate adopts in a separate change (#43). Closing a
channel that was never used is a refund, which belongs to the recovery work
in #38.

## What changes

- The MPP charge handler is real, and the gate understands MPP's own
  headers.
- A real Stellar channel adapter and a real x402 settler exist.
- The in-memory payment memory has a size cap and cleans up expired entries.

## What does not change

- x402 payments on the service side behave exactly as before.
- Tollway still never holds anyone's money: every payment goes directly from
  payer to payee.
- The receipt format and the four web framework adapters are untouched.
