import type { AddressInfo } from "node:net";
import { bindBodyToResource, bodyDigest, utf8Bytes } from "@vegaforge/tollway-core";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "@vegaforge/tollway-server";
import express, { type Request } from "express";
import { describe, expect, it } from "vitest";
import {
  boundGate,
  chunked,
  decodeReceiptResource,
  PROMPT_A,
  PROMPT_B,
  payFrom,
} from "./body-binding.fixture.js";
import { expressPaywall } from "./index.js";

/** Issue #164 through the Express adapter, with and without a body parser in front. */
async function start(parser: "none" | "json-verify" | "raw") {
  const { gate, calls } = await boundGate();
  const app = express();
  if (parser === "json-verify") {
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        },
      }),
    );
  }
  if (parser === "raw") app.use(express.raw({ type: "application/json" }));
  app.post("/infer", expressPaywall(gate), async (req, res) => {
    // Report a digest of the body the handler sees (parsed JSON, or the raw
    // Buffer) rather than echoing the client's bytes back into the response.
    const seen = Buffer.isBuffer(req.body)
      ? new Uint8Array(req.body)
      : utf8Bytes(JSON.stringify(req.body));
    res.json({ digest: await bodyDigest(seen) });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    fetch(`${base}/infer`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);
  return { post, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe.each([
  "none",
  "json-verify",
  "raw",
] as const)("Express (%s parser): body binding (#164)", (parser) => {
  it("binds the digest, and the handler still gets the whole body", async () => {
    const { post, close } = await start(parser);
    try {
      const challenge = await post(PROMPT_A);
      expect(challenge.status).toBe(402);
      const paid = await post(PROMPT_A, {
        [PAYMENT_SIGNATURE_HEADER]: payFrom(challenge.headers.get(PAYMENT_REQUIRED_HEADER)),
      });
      expect(paid.status).toBe(200);
      expect(await paid.json()).toEqual({ digest: await bodyDigest(utf8Bytes(PROMPT_A)) });
      expect(decodeReceiptResource(paid.headers.get(TOLLWAY_RECEIPT_HEADER))).toBe(
        await bindBodyToResource("/infer", utf8Bytes(PROMPT_A)),
      );
    } finally {
      await close();
    }
  });

  it("does not let a payment for body A unlock body B", async () => {
    const { post, close } = await start(parser);
    try {
      const header = payFrom((await post(PROMPT_A)).headers.get(PAYMENT_REQUIRED_HEADER));
      expect((await post(PROMPT_A, { [PAYMENT_SIGNATURE_HEADER]: header })).status).toBe(200);
      expect((await post(PROMPT_B, { [PAYMENT_SIGNATURE_HEADER]: header })).status).not.toBe(200);
    } finally {
      await close();
    }
  });

  it("binds a chunked upload to the same digest as the whole body", async () => {
    const { post, close } = await start(parser);
    try {
      const challenge = await post(chunked(PROMPT_A));
      const paid = await post(chunked(PROMPT_A), {
        [PAYMENT_SIGNATURE_HEADER]: payFrom(challenge.headers.get(PAYMENT_REQUIRED_HEADER)),
      });
      expect(paid.status).toBe(200);
      expect(decodeReceiptResource(paid.headers.get(TOLLWAY_RECEIPT_HEADER))).toBe(
        await bindBodyToResource("/infer", utf8Bytes(PROMPT_A)),
      );
    } finally {
      await close();
    }
  });
});

/**
 * An upload that sends more than the limit at once and then never finishes:
 * the client is still sending when the server answers. The server must
 * answer 413 at once, without waiting for (or destroying) the rest.
 */
function oversizedUploadThatNeverEnds(): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (sent) return new Promise<void>(() => {});
      sent = true;
      controller.enqueue(new Uint8Array(2000));
      return undefined;
    },
  });
}

describe("Express: body limit (#164)", () => {
  it("answers 413 over the limit without calling the facilitator", async () => {
    const { post, calls, close } = await start("none");
    try {
      const response = await post(chunked("x".repeat(2000)), { [PAYMENT_SIGNATURE_HEADER]: "any" });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: { code: "body-too-large" } });
      expect(calls()).toBe(0);
    } finally {
      await close();
    }
  });

  it("answers 413 while the client is still uploading", async () => {
    const { post, calls, close } = await start("none");
    try {
      const response = await post(oversizedUploadThatNeverEnds(), {
        [PAYMENT_SIGNATURE_HEADER]: "any",
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: { code: "body-too-large" } });
      expect(response.headers.get("connection")).toBe("close");
      expect(calls()).toBe(0);
    } finally {
      await close();
    }
  });
});
