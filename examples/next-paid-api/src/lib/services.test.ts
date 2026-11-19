import { bytesToBase64Url } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import { ExampleConfigError } from "./config";
import { createServices, summarizeText } from "./services";

async function freshPkcs8Key(): Promise<string> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
}

describe("startup validation", () => {
  it("fails without a receipt key outside local mock mode", async () => {
    await expect(
      createServices({ TOLLWAY_MODE: "testnet", OZ_API_KEY: "oz-key" }),
    ).rejects.toBeInstanceOf(ExampleConfigError);
  });

  it("fails on a malformed receipt key and does not echo it", async () => {
    const malformed = bytesToBase64Url(new Uint8Array(20).fill(9));
    const failure = createServices({ TOLLWAY_RECEIPT_KEY: malformed });
    await expect(failure).rejects.toBeInstanceOf(ExampleConfigError);
    await expect(failure).rejects.toThrow(/TOLLWAY_RECEIPT_KEY is malformed/);
    await expect(failure).rejects.not.toThrow(malformed);
  });

  it("fails in deployed mode without Redis configuration", async () => {
    await expect(
      createServices({ TOLLWAY_DEPLOYED: "true", TOLLWAY_RECEIPT_KEY: await freshPkcs8Key() }),
    ).rejects.toThrow(/REDIS_URL is not set/);
  });

  it("signs with the configured key, so every instance shares one keyId", async () => {
    const key = await freshPkcs8Key();
    const first = await createServices({ TOLLWAY_RECEIPT_KEY: key });
    const second = await createServices({ TOLLWAY_RECEIPT_KEY: key });
    expect(first.signer.keyId).toBe(second.signer.keyId);
  });
});

describe("summarizeText", () => {
  it("keeps the first sentence", () => {
    expect(summarizeText("Tollway charges agents. It settles on Stellar.")).toBe(
      "Tollway charges agents.",
    );
  });
});
