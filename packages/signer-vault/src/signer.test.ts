import {
  buildReceipt,
  createKeySetVerifier,
  Ed25519Verifier,
  signReceipt,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVaultTransitSigner,
  parseVaultSignature,
  type VaultTransitSignerOptions,
  vaultKeyId,
} from "./signer.js";
import { VaultTransitError } from "./vault.js";

const TOKEN = "hvs.super-secret-token";
const ADDRESS = "https://vault.test:8200";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  return Uint8Array.from(binary, (char: string) => char.charCodeAt(0));
}

type FakeVersion = { privateKey: CryptoKey; publicKey: Uint8Array };

/**
 * A fake Transit engine that really signs, with one Ed25519 key per version,
 * so a receipt it signs verifies with the real verifiers.
 */
class FakeTransit {
  readonly versions: FakeVersion[] = [];
  readonly requests: { url: string; method: string; headers: Headers; body: unknown }[] = [];
  type = "ed25519";
  /** When set, the sign endpoint lies about the version it used. */
  reportVersion: number | undefined;
  failWith: { status: number; errors: string[] } | undefined;

  async rotate(): Promise<void> {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    this.versions.push({ privateKey: pair.privateKey, publicKey });
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ url, method: init?.method ?? "GET", headers, body });
    if (this.failWith) {
      return Response.json({ errors: this.failWith.errors }, { status: this.failWith.status });
    }
    if (headers.get("X-Vault-Token") !== TOKEN) {
      return Response.json({ errors: ["permission denied"] }, { status: 403 });
    }
    if (url === `${ADDRESS}/v1/transit/keys/receipts`) {
      const keys = Object.fromEntries(
        this.versions.map((version, index) => [
          String(index + 1),
          { public_key: toBase64(version.publicKey), name: "ed25519" },
        ]),
      );
      return Response.json({
        request_id: "req-keys",
        data: { type: this.type, latest_version: this.versions.length, keys },
      });
    }
    if (url === `${ADDRESS}/v1/transit/sign/receipts`) {
      const { input: message, key_version: keyVersion } = body as {
        input: string;
        key_version: number;
      };
      const version = this.versions[keyVersion - 1];
      if (!version) return Response.json({ errors: ["no such version"] }, { status: 400 });
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          "Ed25519",
          version.privateKey,
          fromBase64(message) as BufferSource,
        ),
      );
      const reported = this.reportVersion ?? keyVersion;
      return Response.json({
        request_id: "req-sign",
        data: { signature: `vault:v${reported}:${toBase64(signature)}`, key_version: reported },
      });
    }
    return Response.json({ errors: [] }, { status: 404 });
  };
}

let transit: FakeTransit;

beforeEach(async () => {
  transit = new FakeTransit();
  await transit.rotate();
});

function options(overrides: Partial<VaultTransitSignerOptions> = {}): VaultTransitSignerOptions {
  return {
    address: ADDRESS,
    token: TOKEN,
    keyName: "receipts",
    fetch: transit.fetch,
    ...overrides,
  };
}

const RECEIPT = buildReceipt({
  payer: "GPAYER",
  payee: "GPAYEE",
  amount: "1000000",
  asset: "USDC:GA5Z",
  resource: "/quotes/latest",
  model: "x402",
  settlement: { kind: "transaction", txHash: "abc123" },
  network: "testnet",
});

describe("createVaultTransitSigner", () => {
  it("resolves the latest version at creation and puts it in the keyId", async () => {
    await transit.rotate();
    const signer = await createVaultTransitSigner(options());
    expect(signer.keyVersion).toBe(2);
    expect(signer.keyId).toBe("vault-transit:transit/receipts:v2");
    expect(signer.keyId).toBe(vaultKeyId("transit", "receipts", 2));
    expect(signer.algorithm).toBe("Ed25519");
    expect(signer.publicKey).toEqual(transit.versions[1]?.publicKey);
  });

  it("pins an explicit version", async () => {
    await transit.rotate();
    const signer = await createVaultTransitSigner(options({ keyVersion: 1 }));
    expect(signer.keyVersion).toBe(1);
    expect(signer.publicKey).toEqual(transit.versions[0]?.publicKey);
  });

  it("signs with the pinned version even after Vault rotates the key", async () => {
    const signer = await createVaultTransitSigner(options());
    await transit.rotate();
    const signed = await signReceipt(RECEIPT, signer);
    const sign = transit.requests.find((request) => request.url.endsWith("/sign/receipts"));
    expect(sign?.body).toMatchObject({ key_version: 1 });
    expect(
      await verifyReceipt(signed, new Ed25519Verifier({ [signer.keyId]: signer.publicKey })),
    ).toMatchObject({ valid: true });
  });

  it("produces receipts the Ed25519 verifier and the key-set verifier accept", async () => {
    const signer = await createVaultTransitSigner(options());
    const signed = await signReceipt(RECEIPT, signer);
    expect(signed.signature.keyId).toBe(signer.keyId);

    expect(
      await verifyReceipt(signed, new Ed25519Verifier({ [signer.keyId]: signer.publicKey })),
    ).toMatchObject({ valid: true });
    const keySet = createKeySetVerifier({
      document: { keys: [{ ...signer.publicJwk(), status: { state: "active" } }] },
    });
    expect(await verifyReceipt(signed, keySet)).toMatchObject({ valid: true });
  });

  it("refuses a signature Vault made with a different version", async () => {
    const signer = await createVaultTransitSigner(options());
    transit.reportVersion = 2;
    await expect(signer.sign(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      kind: "version-mismatch",
      code: "signer-failed",
    });
  });

  it("refuses a key type other than ed25519 at creation", async () => {
    transit.type = "ecdsa-p256";
    await expect(createVaultTransitSigner(options())).rejects.toMatchObject({
      kind: "unsupported-key-type",
      code: "invalid-signing-key",
    });
  });

  it("refuses a pinned version the key does not have", async () => {
    await expect(createVaultTransitSigner(options({ keyVersion: 7 }))).rejects.toMatchObject({
      kind: "key-missing",
      requestId: "req-keys",
    });
  });

  it.each([
    [403, ["permission denied"], "permission-denied"],
    [404, [], "key-missing"],
    [503, ["Vault is sealed"], "sealed"],
    [500, ["internal error"], "server-error"],
  ] as const)("maps a %i answer to %s", async (status, errors, kind) => {
    transit.failWith = { status, errors: [...errors] };
    const error = await createVaultTransitSigner(options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VaultTransitError);
    expect(error).toMatchObject({ kind, status });
  });

  it("never puts the token in an error, even when Vault echoes it", async () => {
    transit.failWith = { status: 400, errors: [`bad token ${TOKEN}`] };
    const error = await createVaultTransitSigner(options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VaultTransitError);
    const text = `${(error as Error).message} ${JSON.stringify(error)}`;
    expect(text).not.toContain(TOKEN);
    expect((error as Error).message).toContain("[redacted]");
  });

  it("gives up after timeoutMs", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    await expect(
      createVaultTransitSigner(options({ fetch: hanging, timeoutMs: 20 })),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("stops when the caller's signal aborts", async () => {
    const controller = new AbortController();
    const signer = await createVaultTransitSigner(options({ signal: controller.signal }));
    controller.abort();
    await expect(signer.sign(new Uint8Array([1]))).rejects.toMatchObject({ kind: "aborted" });
  });

  it("reports an unreachable Vault as unavailable", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(createVaultTransitSigner(options({ fetch: down }))).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("sends the namespace header, and asks a token provider before every request", async () => {
    const provider = vi.fn(async () => TOKEN);
    const signer = await createVaultTransitSigner(
      options({ token: provider, namespace: "team-a" }),
    );
    await signer.sign(new Uint8Array([1]));
    expect(provider).toHaveBeenCalledTimes(2);
    expect(
      transit.requests.every((request) => request.headers.get("X-Vault-Namespace") === "team-a"),
    ).toBe(true);
  });

  it.each([
    [{ keyName: "bad/name" }, /keyName/],
    [{ keyVersion: 0 }, /keyVersion/],
    [{ timeoutMs: 0 }, /timeoutMs/],
    [{ address: "not a url" }, /address/],
    [{ mount: "../escape" }, /mount/],
    // A long run of slashes inside the mount; the trim must stay linear.
    [{ mount: `a${"/".repeat(100_000)}b` }, /mount/],
  ])("rejects bad options %o", async (overrides, message) => {
    await expect(createVaultTransitSigner(options(overrides))).rejects.toThrow(message);
  });
});

describe("parseVaultSignature", () => {
  const sixtyFour = toBase64(new Uint8Array(64).fill(7));

  it("returns the raw bytes of a well-formed signature", () => {
    expect(parseVaultSignature(`vault:v3:${sixtyFour}`, 3)).toEqual(new Uint8Array(64).fill(7));
  });

  it.each([
    ["no prefix", sixtyFour],
    ["no version", `vault:v:${sixtyFour}`],
    ["base64url alphabet", `vault:v1:${sixtyFour.replaceAll("+", "-")}-_`],
    ["wrong length", `vault:v1:${toBase64(new Uint8Array(32))}`],
  ])("rejects %s", (_name, signature) => {
    expect(() => parseVaultSignature(signature, 1)).toThrow(VaultTransitError);
  });
});
