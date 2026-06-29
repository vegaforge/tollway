# Receipt format reference

Every settlement path in Tollway, regardless of model, ends in exactly one canonical shape: a signed receipt. x402 per-request, MPP charge, and MPP channel commitments all converge here. Downstream accounting, dispute evidence, and analytics consume one shape instead of three. This document describes every field, the settlement-reference variants, and how signing and verification work.

Source of truth: `packages/core/src/receipt/schema.ts` (the zod schemas), `packages/core/src/receipt/receipt.ts` (`buildReceipt`, `signReceipt`, `verifyReceipt`), and `packages/core/src/receipt/signer.ts` (the signer / verifier interfaces and the default Ed25519 implementation). See also `docs/design.md`, "One receipt format".

## Shape at a glance

A signed receipt is two parts: the receipt body and a detached signature over the body's canonical bytes.

```ts
type SignedReceipt = {
  receipt: ReceiptBody;
  signature: ReceiptSignature;
};
```

A worked example:

```json
{
  "receipt": {
    "version": 1,
    "id": "5b8c4d8e-2a3a-4f1d-9d0a-3a5b6c7d8e9f",
    "payer": "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    "payee": "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "amount": "10000",
    "asset": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    "resource": "/quotes/latest",
    "model": "x402",
    "settlement": {
      "kind": "transaction",
      "txHash": "ad21ce4f9e1f3b2a8e7c0d1f2a3b4c5d6e7f8091a2b3c4d5e6f70819a2b3c4d5"
    },
    "network": "testnet",
    "issuedAt": "2026-06-29T14:00:00.000Z"
  },
  "signature": {
    "keyId": "tollway-2026-q2",
    "algorithm": "Ed25519",
    "value": "5p_aP3LE6QwrXSm2eYU7C4...m1nQ"
  }
}
```

## The receipt body

Field by field, in the order the schema declares them.

### `version: 1`

Schema version. Currently the only valid value. Bumps are breaking: a verifier that does not recognize a future version returns invalid rather than guessing the layout.

### `id: string`

Unique per receipt. The signature covers the id, so a replayed receipt is detectable as a duplicate at the same `(payer, resource, txHash)` triple. `buildReceipt` defaults this to a fresh `crypto.randomUUID()` when none is supplied.

### `payer: string`

The agent that authorized the payment. A Stellar account id (`G...`) in every Stellar settlement model today; the type is a non-empty string so non-Stellar paths can fit in if Tollway ever grows them.

### `payee: string`

The service that received the payment. Tollway never sits between counterparties: the on-chain settlement goes directly to this address.

### `amount: string`

Integer string in the asset's smallest unit. A string, not a number, because JavaScript numbers lose precision past 2<sup>53</sup>; receipts have to round-trip through JSON without rounding. The schema rejects anything that does not match `/^[0-9]+$/`.

### `asset: string`

The asset code, qualified for unambiguous identification. The canonical Stellar shape is `CODE:ISSUER` (e.g. `USDC:GA5Z...`); the type is a non-empty string so other forms (XLM, custom codes) are valid too.

### `resource: string`

The URL or stable identifier of what was paid for. For HTTP gates this is the request path the gate sees (`/quotes/latest`); for non-HTTP gates it can be any opaque resource id. The gate config can override the default (`req.url`) via `PaywallConfig.resource`.

### `model: "x402" | "mpp-charge" | "mpp-channel"`

Which settlement model produced this receipt. The schema enforces a coherence rule with the settlement reference (see below): an `x402` receipt with a `channel-commitment` reference is malformed no matter who signed it.

### `settlement: SettlementRef`

How the payment is anchored on chain. A discriminated union with two variants; see the next section.

### `network: "testnet" | "mainnet"`

Which Stellar network the settlement landed on. Receipts from testnet and mainnet should be stored and compared separately; the network is on the receipt so audit trails do not need a side channel for it.

### `issuedAt: string`

ISO 8601 timestamp of when the receipt was issued. Defaults to `new Date().toISOString()` when `buildReceipt` is called without an override.

## Settlement reference variants

```ts
type SettlementRef =
  | { kind: "transaction"; txHash: string }
  | { kind: "channel-commitment"; channelId: string; sequence: number };
```

The model determines which variant is valid:

| Model         | Settlement variant         | Why |
| ------------- | -------------------------- | --- |
| `x402`        | `transaction`              | One on-chain settlement per request. |
| `mpp-charge`  | `transaction`              | Same as x402 from a settlement-reference standpoint; the difference is in the verify / settle protocol. |
| `mpp-channel` | `channel-commitment`       | Many off-chain commitments per channel; the `sequence` pins this commitment within the cumulative stream. |

`schema.ts` enforces this with a `superRefine` that rejects mismatched combinations. A channel receipt with a `txHash` (or an x402 receipt with a `channelId` + `sequence`) fails validation before the signature is even checked.

## The signature

```ts
type ReceiptSignature = {
  keyId: string;
  algorithm: string;
  value: string;
};
```

`keyId` identifies the signing key, so keys can rotate without orphaning past receipts. `algorithm` names the signature scheme (always `"Ed25519"` today). `value` is the base64url-encoded signature over the canonical bytes of the receipt body.

### Canonical bytes

The signature covers a deterministic serialization of the receipt body: keys sorted at every nesting level, no whitespace, `undefined` properties dropped the same way `JSON.stringify` drops them. Two structurally equal values always produce the same bytes, which is what makes signatures reproducible across runtimes. See `packages/core/src/receipt/canonical.ts`.

## Signing

Signing sits behind an interface so the key can live wherever a deployment needs it: in process, in a KMS, in an HSM.

```ts
interface ReceiptSigner {
  readonly keyId: string;
  readonly algorithm: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}
```

The default implementation is `Ed25519Signer`, which uses WebCrypto and therefore runs in both Node and edge runtimes:

```ts
import { Ed25519Signer, buildReceipt, signReceipt } from "@tollway/core";

const signer = await Ed25519Signer.generate("tollway-2026-q2");

const receipt = await signReceipt(
  buildReceipt({
    payer: "GA5Z...",
    payee: "GSERVICE...",
    amount: "10000",
    asset: "USDC:GA5Z...",
    resource: "/quotes/latest",
    model: "x402",
    settlement: { kind: "transaction", txHash: "ad21..." },
    network: "testnet",
  }),
  signer,
);
```

`buildReceipt` validates the body and fills in `version`, `id`, and `issuedAt` if they are not supplied. `signReceipt` produces the canonical bytes, signs them, and returns a `SignedReceipt` with the signer's `keyId` and `algorithm` attached.

### Swapping the signer

Any object that satisfies the `ReceiptSigner` interface is a valid signer. A KMS-backed signer that delegates `sign` to AWS KMS, GCP KMS, or an HSM is a drop-in replacement; the rest of the system does not change. The only requirements are that `keyId` is stable for the lifetime of the key and `algorithm` matches what a downstream verifier knows.

## Verifying

```ts
interface ReceiptVerifier {
  verify(input: {
    message: Uint8Array;
    signature: Uint8Array;
    keyId: string;
    algorithm: string;
  }): Promise<boolean>;
}
```

`verifyReceipt(candidate, verifier)` accepts `unknown` on purpose: receipts arrive over the wire and the schema is the gate. It runs `signedReceiptSchema.safeParse(candidate)` first, then asks the verifier to check the signature.

```ts
import { Ed25519Verifier, verifyReceipt } from "@tollway/core";

const verifier = new Ed25519Verifier({
  "tollway-2026-q2": signerPublicKeyBytes,
});

const result = await verifyReceipt(incomingReceipt, verifier);
if (!result.valid) {
  throw new Error(`receipt rejected: ${result.reason}`);
}
```

`Ed25519Verifier.forSigner(signer)` is a convenience constructor for the single-key case: it builds a verifier that trusts the signer's own public key.

### Key rotation

The signature carries `keyId`, and `Ed25519Verifier` accepts a map of `keyId -> publicKey`. Rotation is therefore additive: when a new key is introduced, both the old and the new public key live in the verifier's map until every receipt signed by the old key has aged out of the window you care about (the settlement cache, the dispute window, the audit retention period). New receipts use the new `keyId`; old receipts still verify against the old key. An unknown `keyId` or a different `algorithm` returns false rather than throwing, so a verifier that does not have the key configured fails closed.

The same property makes multi-signer deployments straightforward: every Tollway instance can have its own `keyId`, and every downstream service can trust the set of instance keys it expects to see.
