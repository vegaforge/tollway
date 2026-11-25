import { Readable } from "node:stream";
import { bindBodyToResource, bodyDigest, utf8Bytes } from "@vegaforge/tollway-core";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "@vegaforge/tollway-server";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  boundGate,
  decodeReceiptResource,
  PROMPT_A,
  PROMPT_B,
  payFrom,
} from "./body-binding.fixture.js";
import { fastifyPaywall, fastifyRawBody } from "./index.js";

/** Issue #164 through the Fastify adapter. */
async function build(options: { capture?: boolean; captureLimit?: number } = {}) {
  const { gate, calls } = await boundGate();
  const app = Fastify();
  if (options.capture !== false) {
    app.addHook("preParsing", fastifyRawBody({ maxBytes: options.captureLimit ?? 4096 }));
  }
  // Report a digest of the parsed body the handler sees, not the client's bytes.
  app.post("/infer", { preHandler: fastifyPaywall(gate) }, async (request) => ({
    digest: await bodyDigest(utf8Bytes(JSON.stringify(request.body))),
  }));
  await app.ready();
  const post = (payload: string | Readable, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/infer",
      payload,
      headers: { "content-type": "application/json", ...headers },
    });
  return { post, calls };
}

function chunkedStream(text: string, size = 7): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < text.length; i += size) parts.push(Buffer.from(text.slice(i, i + size)));
  return Readable.from(parts);
}

describe("Fastify: body binding (#164)", () => {
  it("binds the digest, and the handler still gets the parsed body", async () => {
    const { post } = await build();
    const challenge = await post(PROMPT_A);
    expect(challenge.statusCode).toBe(402);
    const paid = await post(PROMPT_A, {
      [PAYMENT_SIGNATURE_HEADER]: payFrom(
        challenge.headers[PAYMENT_REQUIRED_HEADER.toLowerCase()] as string,
      ),
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toEqual({ digest: await bodyDigest(utf8Bytes(PROMPT_A)) });
    expect(
      decodeReceiptResource(paid.headers[TOLLWAY_RECEIPT_HEADER.toLowerCase()] as string),
    ).toBe(await bindBodyToResource("/infer", utf8Bytes(PROMPT_A)));
  });

  it("does not let a payment for body A unlock body B", async () => {
    const { post } = await build();
    const header = payFrom(
      (await post(PROMPT_A)).headers[PAYMENT_REQUIRED_HEADER.toLowerCase()] as string,
    );
    expect((await post(PROMPT_A, { [PAYMENT_SIGNATURE_HEADER]: header })).statusCode).toBe(200);
    expect((await post(PROMPT_B, { [PAYMENT_SIGNATURE_HEADER]: header })).statusCode).not.toBe(200);
  });

  it("answers 413 over the route's limit without calling the facilitator", async () => {
    const { post, calls } = await build();
    const response = await post(JSON.stringify({ prompt: "x".repeat(2000) }), {
      [PAYMENT_SIGNATURE_HEADER]: "any",
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: "body-too-large" } });
    expect(calls()).toBe(0);
  });

  it("answers 413 from the capture hook while streaming", async () => {
    const { post, calls } = await build({ captureLimit: 64 });
    const response = await post(chunkedStream(JSON.stringify({ prompt: "x".repeat(500) })), {
      [PAYMENT_SIGNATURE_HEADER]: "any",
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: "body-too-large" } });
    expect(calls()).toBe(0);
  });

  it("binds a chunked upload to the same digest as the whole body", async () => {
    const { post } = await build();
    const challenge = await post(chunkedStream(PROMPT_A));
    const paid = await post(chunkedStream(PROMPT_A), {
      [PAYMENT_SIGNATURE_HEADER]: payFrom(
        challenge.headers[PAYMENT_REQUIRED_HEADER.toLowerCase()] as string,
      ),
    });
    expect(paid.statusCode).toBe(200);
    expect(
      decodeReceiptResource(paid.headers[TOLLWAY_RECEIPT_HEADER.toLowerCase()] as string),
    ).toBe(await bindBodyToResource("/infer", utf8Bytes(PROMPT_A)));
  });

  it("fails closed when fastifyRawBody is not registered", async () => {
    const { post, calls } = await build({ capture: false });
    const response = await post(PROMPT_A);
    // A server misconfiguration, not an unavailable payment backend.
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "body-not-provided" } });
    expect(calls()).toBe(0);
  });
});

describe("Fastify over a real socket: body limit (#164)", () => {
  it("answers 413 while the client is still uploading, and closes the connection", async () => {
    const { gate, calls } = await boundGate();
    const app = Fastify();
    app.addHook("preParsing", fastifyRawBody({ maxBytes: 64 }));
    app.post("/infer", { preHandler: fastifyPaywall(gate) }, async () => ({ ok: true }));
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      let sent = false;
      // More than the limit at once, then an upload that never finishes.
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return new Promise<void>(() => {});
          sent = true;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ prompt: "x".repeat(500) })));
          return undefined;
        },
      });
      const response = await fetch(`${address}/infer`, {
        method: "POST",
        body,
        headers: { "content-type": "application/json", [PAYMENT_SIGNATURE_HEADER]: "any" },
        duplex: "half",
      } as RequestInit);
      expect(response.status).toBe(413);
      expect(response.headers.get("connection")).toBe("close");
      expect(await response.json()).toMatchObject({ error: { code: "body-too-large" } });
      expect(calls()).toBe(0);
    } finally {
      await app.close();
    }
  });
});
