import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url, utf8Bytes } from "../encoding.js";
import { canonicalBytes, canonicalJson, type JsonValue } from "./canonical.js";
import { Ed25519Signer, Ed25519Verifier } from "./signer.js";

/**
 * Loads the published canonical / Ed25519 vectors and checks every one of
 * them against the implementation. If this test drifts, a verifier in
 * another language that pins to the same vectors is going to fail against
 * Tollway's receipts, so the drift must be a deliberate, called-out change
 * in the release note - not an accident.
 *
 * The signing key is the RFC 8032 section 7.1 TEST 2 key: published,
 * insecure, deterministic. Nothing in this test material is a real signing
 * secret.
 */

type VectorFile = {
  schema: {
    version: 1;
    specification: string;
    signingAlgorithm: "Ed25519";
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
};

const VECTOR_PATH = fileURLToPath(
  new URL("../../../../docs/receipt-vectors/canonical-and-ed25519.json", import.meta.url),
);

function loadVectors(): VectorFile {
  const raw = readFileSync(VECTOR_PATH, "utf8");
  return JSON.parse(raw) as VectorFile;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("docs/receipt-vectors/canonical-and-ed25519.json", () => {
  const file = loadVectors();

  it("has schema version 1", () => {
    expect(file.schema.version).toBe(1);
    expect(file.schema.signingAlgorithm).toBe("Ed25519");
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
});
