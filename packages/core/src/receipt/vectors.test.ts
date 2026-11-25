import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from "../encoding.js";
import { canonicalBytes, canonicalJson, type JsonValue } from "./canonical.js";
import { EcdsaP256Verifier } from "./ecdsa.js";
import { Ed25519Signer, Ed25519Verifier } from "./signer.js";

/**
 * Loads the published canonical / Ed25519 vectors and checks every one of
 * them against the implementation. If this test drifts, a verifier in
 * another language that pins to the same vectors is going to fail against
 * Tollway's receipts, so the drift must be a deliberate, called-out change
 * in the release note, not an accident.
 *
 * The signing key is the RFC 8032 section 7.1 TEST 2 key: published,
 * insecure, deterministic. Nothing in this test material is a real signing
 * secret.
 */

type VectorFile = {
  schema: {
    version: 2;
    specification: string;
    encoding: string;
    signingAlgorithm: "Ed25519";
    es256TestKey: { x: string; y: string; d: string; kid: string; alg: "ES256" };
    signingTestKey: {
      description: string;
      private: string;
      public: string;
      publicHex: string;
    };
  };
  vectors: Array<{
    name: string;
    input: JsonValue;
    canonicalJson: string;
    canonicalHex: string;
    signatureBase64url: string;
  }>;
  es256Vectors: Array<{
    name: string;
    input: JsonValue;
    canonicalHex: string;
    signatureBase64url: string;
  }>;
};

/**
 * The repository root, found by walking up to `pnpm-workspace.yaml`. A fixed
 * `../../../..` breaks when the package is copied elsewhere, as Stryker does
 * with its mutation sandbox (issue #247).
 */
function repositoryRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("pnpm-workspace.yaml not found above this test");
    dir = parent;
  }
  return dir;
}

const VECTOR_PATH = join(repositoryRoot(), "docs/receipt-vectors/canonical-and-ed25519.json");

function readVectorText(): string {
  return readFileSync(VECTOR_PATH, "utf8");
}

function loadVectors(): VectorFile {
  return JSON.parse(readVectorText()) as VectorFile;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("docs/receipt-vectors/canonical-and-ed25519.json", () => {
  const file = loadVectors();

  it("has schema version 2", () => {
    expect(file.schema.version).toBe(2);
    expect(file.schema.signingAlgorithm).toBe("Ed25519");
  });

  it("is plain ASCII, with every other character escaped, so no editor can normalise it", () => {
    const nonAscii = [...readVectorText()].filter((character) => character.charCodeAt(0) > 0x7f);
    expect(nonAscii).toEqual([]);
  });

  it("keeps U+FB33 in the key-order vector, where UTF-16 and code point order differ", () => {
    const vector = file.vectors.find((candidate) => candidate.name === "utf16-key-order");
    expect(vector?.canonicalHex).toContain("efacb3");
    const keys = Object.keys(vector?.input ?? {});
    expect(keys).toContain(String.fromCodePoint(0xfb33));
  });

  it("every vector's canonical bytes match canonicalJson and canonicalBytes", () => {
    for (const vector of file.vectors) {
      const asText = canonicalJson(vector.input);
      const asBytes = canonicalBytes(vector.input);
      expect(asText, `vector ${vector.name}: canonicalJson`).toBe(vector.canonicalJson);
      expect(hex(asBytes), `vector ${vector.name}: canonicalHex`).toBe(vector.canonicalHex);
      // The canonical text and the canonical bytes must agree.
      expect(hex(utf8Bytes(asText)), `vector ${vector.name}: utf-8 roundtrip`).toBe(
        vector.canonicalHex,
      );
    }
  });

  it("every vector's Ed25519 signature verifies with the published test key", async () => {
    const signer = await Ed25519Signer.fromPrivateKey(file.schema.signingTestKey.private);
    expect(bytesToBase64Url(signer.publicKey)).toBe(file.schema.signingTestKey.public);

    const verifier = new Ed25519Verifier({
      [signer.keyId]: signer.publicKey,
    });
    for (const vector of file.vectors) {
      const message = canonicalBytes(vector.input);
      const signature = base64UrlToBytes(vector.signatureBase64url);
      const ok = await verifier.verify({
        message,
        signature,
        keyId: signer.keyId,
        algorithm: signer.algorithm,
      });
      expect(ok, `vector ${vector.name}: signature verifies`).toBe(true);
    }
  });

  it("re-signing an input with the test key reproduces the vector's signature (Ed25519 is deterministic)", async () => {
    const signer = await Ed25519Signer.fromPrivateKey(file.schema.signingTestKey.private);
    for (const vector of file.vectors) {
      const resigned = bytesToBase64Url(await signer.sign(canonicalBytes(vector.input)));
      expect(resigned, `vector ${vector.name}: deterministic Ed25519 signature`).toBe(
        vector.signatureBase64url,
      );
    }
  });

  it("every ES256 vector verifies with the published RFC 6979 test key", async () => {
    const key = file.schema.es256TestKey;
    const verifier = new EcdsaP256Verifier({ [key.kid]: { x: key.x, y: key.y } });
    expect(file.es256Vectors.length).toBeGreaterThan(0);
    for (const vector of file.es256Vectors) {
      const message = canonicalBytes(vector.input);
      expect(hex(message), `es256 vector ${vector.name}: canonicalHex`).toBe(vector.canonicalHex);
      const ok = await verifier.verify({
        message,
        signature: base64UrlToBytes(vector.signatureBase64url),
        keyId: key.kid,
        algorithm: key.alg,
      });
      expect(ok, `es256 vector ${vector.name}: signature verifies`).toBe(true);
    }
  });
});
