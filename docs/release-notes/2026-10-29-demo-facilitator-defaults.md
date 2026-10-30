---
date: 2026-10-29
feature: The demo's live mode pays real testnet USDC, or lists what is missing and exits
scope: fix
packages: [@tollway/demo]
scenario-impact: none
---

# Demo live mode works on testnet

`MOCK_MODE=true pnpm --filter @tollway/demo start` is unchanged.

Without `MOCK_MODE`, the demo now makes a real x402 payment on Stellar
testnet:

- It calls the OpenZeppelin Channels testnet facilitator,
  `https://channels.openzeppelin.com/x402/testnet`, instead of the mainnet
  URL. `FACILITATOR_URL` still overrides it, and `STELLAR_NETWORK=mainnet`
  selects the mainnet URL.
- It sends `OZ_API_KEY` as `Authorization: Bearer <key>` on `/verify`,
  `/settle`, and `/supported`.
- It charges in USDC by Soroban contract address (`USDC_TESTNET_ADDRESS` or
  `USDC_PUBNET_ADDRESS` from `@x402/stellar`) and pays `STELLAR_RECIPIENT`,
  which must be a valid `G...` account.
- The demo agent signs the payment with `@x402/stellar`'s
  `ExactStellarScheme` using `STELLAR_SECRET_KEY`, and sends the resulting
  transaction as `PAYMENT-SIGNATURE`. It used to send a placeholder string
  that a real facilitator rejects.
- After settlement it prints the transaction hash.

If live mode is not configured, the demo prints every missing or invalid
setting and exits with code 1, without a stack trace and before any network
call. Mainnet also needs `STELLAR_RPC_URL`, because `@x402/stellar` has no
default mainnet RPC.

The opt-in facilitator integration test in `@tollway/server` now defaults to
the testnet URL and sends `OZ_API_KEY`. A new opt-in test,
`apps/demo/src/demo.live.test.ts` (`TOLLWAY_DEMO_LIVE=true`), runs the demo
against the live facilitator.

Scenario impact: no manual scenario under `docs/scenarios/` covers the
demo. Mock mode and the live-mode configuration are covered by
`apps/demo/src/demo.test.ts` and `apps/demo/src/config.test.ts`.

No publishable package changed, so there is no changeset. Decision record:
`docs/adr/ADR-2026-10-29-demo-facilitator-defaults.md`. Closes #113 (code
part).
