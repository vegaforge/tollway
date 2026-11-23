import { createKeySetVerifier, Ed25519Signer } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import { renderKeySetResponse } from "./key-set-response.js";

/**
 * Issue #167 server-side coverage. The helper exists so every adapter
 * (Express, Fastify, Next, Hono) mounts the key-set endpoint the same
 * way; the test here checks the body a real verifier parses, not just
 * the shape.
 */

describe("renderKeySetResponse", () => {
  it("returns a 200 with the JWK-set content type and a cache-control header", async () => {
    const signer = await Ed25519Signer.generate("key-a");
    const response = renderKeySetResponse({
      keys: [{ ...signer.publicJwk(), status: { state: "active" as const } }],
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/jwk-set+json");
    expect(response.headers["cache-control"]).toMatch(/max-age=\d+/);
  });

  it("serialises a document that a KeySetVerifier can parse round-trip", async () => {
    const signer = await Ed25519Signer.generate("key-a");
    const response = renderKeySetResponse({
      keys: [{ ...signer.publicJwk(), status: { state: "active" as const } }],
    });
    const verifier = createKeySetVerifier({
      url: "https://example.com/keys",
      fetch: async () => ({
        status: 200,
        headers: new Headers({
          "content-type": response.headers["content-type"],
          "cache-control": response.headers["cache-control"],
        }),
        text: async () => response.body,
      }),
    });

    const message = new TextEncoder().encode('{"issuedAt":"2026-11-23T00:00:00.000Z"}');
    const signature = await signer.sign(message);
    const ok = await verifier.verify({
      message,
      signature,
      keyId: signer.keyId,
      algorithm: signer.algorithm,
    });
    expect(ok).toBe(true);
  });

  it("honours the maxAgeSeconds option", async () => {
    const signer = await Ed25519Signer.generate("key-a");
    const response = renderKeySetResponse(
      { keys: [{ ...signer.publicJwk(), status: { state: "active" as const } }] },
      { maxAgeSeconds: 3600 },
    );
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("rejects a document with a malformed key at render time", () => {
    expect(() =>
      renderKeySetResponse({
        keys: [
          {
            kty: "EC",
          } as unknown as Parameters<typeof renderKeySetResponse>[0]["keys"][number],
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "invalid-key-set" }));
  });

  it("rejects a document with a duplicate kid", async () => {
    const a = await Ed25519Signer.generate("same");
    const b = await Ed25519Signer.generate("same");
    expect(() =>
      renderKeySetResponse({
        keys: [
          { ...a.publicJwk(), status: { state: "active" as const } },
          { ...b.publicJwk(), status: { state: "active" as const } },
        ],
      }),
    ).toThrow(/duplicate kid same/);
  });

  it.each([-1, 1.5, Number.NaN])("rejects maxAgeSeconds %s", async (maxAgeSeconds) => {
    const signer = await Ed25519Signer.generate("key-a");
    expect(() =>
      renderKeySetResponse(
        { keys: [{ ...signer.publicJwk(), status: { state: "active" as const } }] },
        { maxAgeSeconds },
      ),
    ).toThrow(expect.objectContaining({ code: "invalid-key-set" }));
  });
});
