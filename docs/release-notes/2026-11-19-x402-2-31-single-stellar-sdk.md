---
date: 2026-11-19
feature: x402 2.31 everywhere and a single @stellar/stellar-sdk (16.4.1) across the workspace
scope: chore
packages: [@vegaforge/tollway-client, @vegaforge/tollway-channels]
scenario-impact: none
---

# x402 2.31 and one Stellar SDK

Every workspace that uses x402 is now on `@x402/core` and `@x402/stellar`
2.31.0, and the workspace resolves exactly one `@stellar/stellar-sdk`, 16.4.1.
Before this, three majors were installed side by side: 14.6.1 (the client and
the demo), 15.1.0 (channels) and 16.4.1 (server, through `@x402/stellar`
2.31.0). Values such as `Address`, `Keypair` and XDR objects can now pass
between packages safely. Issue #259.

## What changed

- `@vegaforge/tollway-client` moves from `@x402/core` and `@x402/stellar`
  2.16.0 to `^2.31.0`, and its development SDK from 14.6.1 to 16.4.1.
- `@vegaforge/tollway-channels` moves its SDK from 15.1.0 to 16.4.1.
- The demo moves its SDK from `^14.6.1` to `^16.4.1`. Its source needed no
  change: `StrKey` and the `USDC_*_ADDRESS` constants behave the same.
- `@stellar/mpp` stays at 0.7.1 and `mppx` at 0.8.19.
- `zod` 3.25.76 leaves the lockfile. Only `@x402/core` 2.16.0 pulled it in;
  2.31.0 depends on `zod` `^4.6.6`. This clears the last open Dependabot npm
  alert. The `toml` override from the security update now matches nothing,
  because `toml` came in only through SDK 15; it stays as a guard.

## The client's settler under 2.31

`@x402/core` 2.31 adds client spend controls to `x402Client`, on by default:
only assets the scheme's `findDefaultAsset` recognises (USDC on Stellar) are
allowed, capped at `DEFAULT_MAX_AMOUNT_PER_PAYMENT` (`"$1"`) per payment
(`dist/cjs/client/index.js`, `applySpendControls`). Left alone, the settler
would have refused every approved offer above 1 USDC and every offer in any
other asset, overriding the client's own policy engine.

`createX402Settler` now builds an `x402Client` per settlement with
`x402Client.fromConfig` and spend controls pinned to the approved offer: one
`allowedAssets` entry for the 402's asset with `maxAmountPerPayment` set to
the offer amount. The policy engine stays the spend authority, and the x402
layer still refuses anything beyond the approved offer. A client per
settlement keeps two concurrent settlements from sharing a cap. Signing
failures from `createPaymentPayload`, including a spend-control rejection,
now surface as a `TollwayError` with code `payment-failed` instead of a bare
`Error`.

The other client calls are unchanged between 2.16.0 and 2.31.0:
`encodePaymentSignatureHeader`, `decodePaymentRequiredHeader`, the
`PaymentRequired` and `PaymentRequirements` types, the `ExactStellarScheme`
client constructor (`signer`, optional `{ url }`) and `ClientStellarSigner`.

Client and channels each declare `@types/node` as a development dependency.
They use `Buffer`, `Response` and `TextDecoder`, whose types used to arrive
only through SDK 14 and 15.

## The one peer exception

`@stellar/mpp` 0.7.1, its latest release, declares `@stellar/stellar-sdk`
`^15.1.0` as a peer. No release accepts 16. Every `@x402/stellar` from 2.17.0
requires 16 (2.31.0: `^16.4.1`), and none ever accepted 15, so a single SDK
means accepting this peer mismatch. The root `package.json` records it under
`pnpm.peerDependencyRules.allowedVersions`, scoped to that peer only:
`"@stellar/mpp>@stellar/stellar-sdk": "16"`. The maintainer chose this on
#259.

The local-network suite (`tests/integration`, `integration.yml`) runs a real
MPP charge through `@stellar/mpp` on SDK 16 on every run; see
[local-network-tests.md](../local-network-tests.md). Remove the rule when an
`@stellar/mpp` release accepts SDK 16.
