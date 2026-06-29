/**
 * Typed data layer for the receipts view.
 *
 * The receipts view (src/app/receipts/page.tsx) depends on
 * @tollway/observability, which is tracked in issue #31. Until #31 lands,
 * this module is the single seam where the UI talks to the data. Replacing
 * the body of `fetchReceipts` with a real call to the observability hub
 * (or the receipt archive surfaced by the optional shared service) is a
 * one-import change; everything downstream (the row shape, the loading /
 * error states, the table, the detail view) stays the same.
 *
 * The stub also exposes the trusted public keys for the receipts it ships,
 * keyed by the same `keyId` carried on each signature. That lets the
 * detail view actually verify a signature against an `Ed25519Verifier`
 * without depending on a key-directory service that does not exist yet.
 *
 * See docs/design.md, "One receipt format" and "Observability".
 */

import { buildReceipt, Ed25519Signer, type SignedReceipt, signReceipt } from "@tollway/core";

/**
 * One row in the receipts archive. The row is the canonical SignedReceipt
 * itself (the table de-references the fields it shows; the detail view
 * verifies the full structure) so there is one shape from data layer to UI.
 */
export type ReceiptRow = SignedReceipt;

/**
 * Snapshot returned by the data source. Wraps the rows plus the trusted
 * public keys for verification, so a future hub implementation can return
 * both in one call without breaking the seam. The map is keyId -> raw
 * Ed25519 public-key bytes; the same shape `Ed25519Verifier` accepts.
 */
export type ReceiptsSnapshot = {
  rows: ReceiptRow[];
  trustedKeys: Record<string, Uint8Array>;
};

/**
 * The single seam between the dashboard and the receipt archive.
 *
 * Today this lazily generates a small, deterministic stub the first time
 * the dashboard reads it (an Ed25519 signer + a fixed list of receipts
 * spanning x402, MPP charge, and MPP channel) and caches the result so
 * every subsequent call returns the same data; the dashboard can verify
 * signatures and render channel links without waiting on #31.
 *
 * When the hub or archive ships, swap the body for the real fetch and
 * leave the signature alone.
 */
export async function fetchReceipts(): Promise<ReceiptsSnapshot> {
  cached ??= await buildStub();
  return cached;
}

let cached: ReceiptsSnapshot | null = null;

const ISSUER_PREFIX = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const STUB_KEY_ID = "tollway-stub-2026";

async function buildStub(): Promise<ReceiptsSnapshot> {
  const signer = await Ed25519Signer.generate(STUB_KEY_ID);

  const seeds: Array<Parameters<typeof buildReceipt>[0] & { id: string; issuedAt: string }> = [
    {
      id: "rcpt-x402-stripe-01",
      issuedAt: "2026-06-29T13:55:12.000Z",
      payer: "GAGENTRESEARCHXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      payee: "GCSTRIPEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      amount: "120000",
      asset: ISSUER_PREFIX,
      resource: "/quotes/latest",
      model: "x402",
      settlement: {
        kind: "transaction",
        txHash: "ad21ce4f9e1f3b2a8e7c0d1f2a3b4c5d6e7f8091a2b3c4d5e6f70819a2b3c4d5",
      },
      network: "testnet",
    },
    {
      id: "rcpt-mppcharge-anthropic-01",
      issuedAt: "2026-06-29T13:48:00.000Z",
      payer: "GAGENTSUMMARIZERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      payee: "GANTHROPICXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      amount: "750000",
      asset: ISSUER_PREFIX,
      resource: "/v1/messages",
      model: "mpp-charge",
      settlement: {
        kind: "transaction",
        txHash: "be32df50a8203f3b9c8d1e2f3a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9d0e1f2a3",
      },
      network: "testnet",
    },
    {
      id: "rcpt-channel-openai-01",
      issuedAt: "2026-06-29T13:30:00.000Z",
      payer: "GAGENTCLASSIFIERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      payee: "GOPENAIXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      amount: "8500000",
      asset: ISSUER_PREFIX,
      resource: "/v1/chat/completions",
      model: "mpp-channel",
      settlement: { kind: "channel-commitment", channelId: "ch-openai-03", sequence: 96 },
      network: "testnet",
    },
    {
      id: "rcpt-channel-anthropic-01",
      issuedAt: "2026-06-29T12:10:00.000Z",
      payer: "GAGENTROUTERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      payee: "GANTHROPICXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      amount: "4100000",
      asset: ISSUER_PREFIX,
      resource: "/v1/messages",
      model: "mpp-channel",
      settlement: { kind: "channel-commitment", channelId: "ch-anthropic-02", sequence: 187 },
      network: "testnet",
    },
  ];

  const rows = await Promise.all(
    seeds.map(async (seed) => signReceipt(buildReceipt(seed), signer)),
  );

  return {
    rows,
    trustedKeys: { [signer.keyId]: signer.publicKey },
  };
}
