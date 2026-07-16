# Canonical Receipt Format

Every Tollway settlement path emits the same signed receipt shape. x402, MPP charge, and MPP channel payments can then share one accounting, dispute, analytics, and reconciliation pipeline.

The runtime schema lives in `packages/core/src/receipt/schema.ts`; receipt construction, signing, and verification live in `packages/core/src/receipt/receipt.ts`.

## Signed Receipt

```json
{
  "receipt": {
    "version": 1,
    "id": "rcpt_01hza6b4x9q6p2",
    "payer": "GAGENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "payee": "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "amount": "10000",
    "asset": "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    "resource": "https://api.example.com/quotes/latest",
    "model": "x402",
    "settlement": {
      "kind": "transaction",
      "txHash": "abc123"
    },
    "network": "testnet",
    "issuedAt": "2026-06-22T04:00:00.000Z"
  },
  "signature": {
    "keyId": "service-key-2026-06",
    "algorithm": "Ed25519",
    "value": "base64url-signature"
  }
}
```

## Receipt Fields

| Field | Type | Description |
| --- | --- | --- |
| `version` | `1` | Schema version. The current canonical receipt version is always `1`. |
| `id` | string | Unique receipt identifier. It is covered by the signature, so replayed or duplicated receipts remain distinguishable. |
| `payer` | string | Account, agent, or counterparty that paid. |
| `payee` | string | Account, service, or counterparty that received the payment. |
| `amount` | integer string | Amount in the asset's smallest unit. It is a string so 64-bit values stay exact. |
| `asset` | string | Asset identifier, such as a Stellar asset code and issuer. |
| `resource` | string | URL or stable resource identifier describing what was paid for. |
| `model` | `x402`, `mpp-charge`, or `mpp-channel` | Settlement model selected for this payment. |
| `settlement` | object | Model-specific on-chain or channel reference. See below. |
| `network` | Stellar network | Network where settlement is anchored, such as `testnet` or `mainnet`. |
| `issuedAt` | ISO datetime | Timestamp when Tollway built the receipt. |

## Settlement References

`settlement.kind` must match `model`. The schema rejects receipts that claim one model but use another model's reference shape.

### Transaction Reference

Used by `x402` and `mpp-charge`.

```json
{
  "kind": "transaction",
  "txHash": "abc123"
}
```

| Field | Type | Description |
| --- | --- | --- |
| `kind` | `transaction` | Indicates that settlement is anchored by a Stellar transaction. |
| `txHash` | string | Non-empty Stellar transaction hash returned by the facilitator or settlement path. |

### Channel Commitment Reference

Used by `mpp-channel`.

```json
{
  "kind": "channel-commitment",
  "channelId": "chan-1",
  "sequence": 41
}
```

| Field | Type | Description |
| --- | --- | --- |
| `kind` | `channel-commitment` | Indicates that the receipt points at an off-chain cumulative commitment. |
| `channelId` | string | Non-empty channel identifier. |
| `sequence` | non-negative integer | Position in the cumulative commitment stream. |

## Signing

Tollway signs only the canonical receipt body, not the outer `{ receipt, signature }` wrapper. `signReceipt()` validates the body, canonicalizes it with sorted object keys, asks the configured signer to sign those bytes, then stores the signature metadata beside the receipt.

The default implementation is Ed25519 through WebCrypto:

- `signature.keyId` identifies the signing key.
- `signature.algorithm` records the algorithm, currently `Ed25519`.
- `signature.value` is the base64url-encoded signature over the canonical receipt bytes.

Canonicalization makes object key order irrelevant. Reordering fields in the receipt body produces the same canonical bytes and therefore the same signature for the same key.

## Verification

`verifyReceipt()` first validates the signed receipt shape. It then canonicalizes the `receipt` body and asks the configured verifier to check:

- the canonical message bytes,
- the decoded signature bytes,
- the `keyId`,
- and the `algorithm`.

An unknown key, unsupported algorithm, malformed receipt, tampered field, or model/reference mismatch returns an invalid verification result.

## Swappable Signers

Receipt signing uses the `ReceiptSigner` interface:

```ts
export interface ReceiptSigner {
  readonly keyId: string;
  readonly algorithm: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}
```

Deployments can keep signing keys in process, in a KMS, behind an HSM, or in another signing service as long as they implement this interface. The verifier side follows the matching `ReceiptVerifier` interface, so hosted and self-hosted deployments can choose their own trust store.

## Key Rotation

Receipts record `signature.keyId`, which lets verifiers trust more than one public key during rotation.

A safe rotation flow is:

1. Add the new public key to every verifier's trusted key set.
2. Start signing new receipts with the new signer's `keyId`.
3. Keep the old public key available until all receipts signed by it have aged out of dispute, reconciliation, and export windows.
4. Remove the old key from the trust set only after those windows close.

Never reuse a `keyId` for different public keys. A stable `keyId` should name exactly one public key for the lifetime of stored receipts.
