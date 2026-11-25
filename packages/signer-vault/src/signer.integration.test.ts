import {
  buildReceipt,
  createKeySetVerifier,
  Ed25519Verifier,
  signReceipt,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import { beforeAll, describe, expect, it } from "vitest";
import { createVaultTransitSigner } from "./signer.js";

/**
 * Opt-in integration test against a real Vault. Skipped unless enabled:
 *
 *   docker run --rm -d --name tollway-vault -p 8200:8200 \
 *     -e VAULT_DEV_ROOT_TOKEN_ID=dev-root hashicorp/vault server -dev
 *   TOLLWAY_VAULT_INTEGRATION=true VAULT_ADDR=http://127.0.0.1:8200 \
 *     VAULT_TOKEN=dev-root pnpm --filter @vegaforge/tollway-signer-vault test
 *
 * The test mounts Transit at a fresh path and creates an Ed25519 key, so it
 * needs a token allowed to do that (the dev server's root token is).
 */
const RUN = process.env.TOLLWAY_VAULT_INTEGRATION === "true";
const ADDRESS = process.env.VAULT_ADDR ?? "http://127.0.0.1:8200";
const TOKEN = process.env.VAULT_TOKEN ?? "";
const MOUNT = `tollway-test-${Date.now()}`;
const KEY = "receipts";

async function vault(method: string, path: string, body?: unknown): Promise<void> {
  const response = await fetch(`${ADDRESS}/v1/${path}`, {
    method,
    headers: { "X-Vault-Token": TOKEN, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(
      `Vault ${method} ${path} answered ${response.status}: ${await response.text()}`,
    );
  }
}

describe.skipIf(!RUN)("createVaultTransitSigner (integration)", () => {
  beforeAll(async () => {
    await vault("POST", `sys/mounts/${MOUNT}`, { type: "transit" });
    await vault("POST", `${MOUNT}/keys/${KEY}`, { type: "ed25519" });
  });

  it("signs a receipt that verifies, and keeps its version across a rotation", async () => {
    const signer = await createVaultTransitSigner({
      address: ADDRESS,
      token: TOKEN,
      mount: MOUNT,
      keyName: KEY,
    });
    expect(signer.keyVersion).toBe(1);

    await vault("POST", `${MOUNT}/keys/${KEY}/rotate`);

    const receipt = buildReceipt({
      payer: "GPAYER",
      payee: "GPAYEE",
      amount: "1000000",
      asset: "USDC:GA5Z",
      resource: "/quotes/latest",
      model: "x402",
      settlement: { kind: "transaction", txHash: "abc123" },
      network: "testnet",
    });

    const runs = 20;
    const started = performance.now();
    let signed = await signReceipt(receipt, signer);
    for (let i = 1; i < runs; i++) signed = await signReceipt(receipt, signer);
    const perSign = (performance.now() - started) / runs;
    console.info(`Vault Transit sign round trip: ${perSign.toFixed(2)} ms on average`);

    expect(
      await verifyReceipt(signed, new Ed25519Verifier({ [signer.keyId]: signer.publicKey })),
    ).toMatchObject({ valid: true });
    const keySet = createKeySetVerifier({
      document: { keys: [{ ...signer.publicJwk(), status: { state: "active" } }] },
    });
    expect(await verifyReceipt(signed, keySet)).toMatchObject({ valid: true });

    const rotated = await createVaultTransitSigner({
      address: ADDRESS,
      token: TOKEN,
      mount: MOUNT,
      keyName: KEY,
    });
    expect(rotated.keyVersion).toBe(2);
    expect(rotated.keyId).not.toBe(signer.keyId);
  });
});
