import { bindBodyToResource, utf8Bytes } from "@vegaforge/tollway-core";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  TOLLWAY_RECEIPT_HEADER,
} from "@vegaforge/tollway-server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  boundGate,
  chunked,
  decodeReceiptResource,
  PROMPT_A,
  PROMPT_B,
  payFrom,
} from "./body-binding.fixture.js";
import { honoPaywall } from "./index.js";

/** Issue #164 through the Hono adapter. */
async function build() {
  const { gate, calls } = await boundGate();
  const app = new Hono();
  app.post("/infer", honoPaywall(gate), async (c) => c.text(await c.req.text()));
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    app.request("/infer", {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...headers },
      ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
    } as RequestInit);
  return { post, calls };
}

describe("Hono: body binding (#164)", () => {
  it("binds the digest, and the handler still reads the whole body", async () => {
    const { post } = await build();
    const challenge = await post(PROMPT_A);
    expect(challenge.status).toBe(402);
    const paid = await post(PROMPT_A, {
      [PAYMENT_SIGNATURE_HEADER]: payFrom(challenge.headers.get(PAYMENT_REQUIRED_HEADER)),
    });
    expect(paid.status).toBe(200);
    expect(await paid.text()).toBe(PROMPT_A);
    expect(decodeReceiptResource(paid.headers.get(TOLLWAY_RECEIPT_HEADER))).toBe(
      await bindBodyToResource("/infer", utf8Bytes(PROMPT_A)),
    );
  });

  it("does not let a payment for body A unlock body B", async () => {
    const { post } = await build();
    const header = payFrom((await post(PROMPT_A)).headers.get(PAYMENT_REQUIRED_HEADER));
    expect((await post(PROMPT_A, { [PAYMENT_SIGNATURE_HEADER]: header })).status).toBe(200);
    const replay = await post(PROMPT_B, { [PAYMENT_SIGNATURE_HEADER]: header });
    expect(replay.status).not.toBe(200);
  });

  it("answers 413 over the limit without calling the facilitator", async () => {
    const { post, calls } = await build();
    const response = await post(chunked("x".repeat(2000)), { [PAYMENT_SIGNATURE_HEADER]: "any" });
    expect(response.status).toBe(413);
    expect(calls()).toBe(0);
  });

  it("binds a chunked upload to the same digest as the whole body", async () => {
    const { post } = await build();
    const challenge = await post(chunked(PROMPT_A));
    const paid = await post(chunked(PROMPT_A), {
      [PAYMENT_SIGNATURE_HEADER]: payFrom(challenge.headers.get(PAYMENT_REQUIRED_HEADER)),
    });
    expect(paid.status).toBe(200);
    expect(await paid.text()).toBe(PROMPT_A);
    expect(decodeReceiptResource(paid.headers.get(TOLLWAY_RECEIPT_HEADER))).toBe(
      await bindBodyToResource("/infer", utf8Bytes(PROMPT_A)),
    );
  });
});
