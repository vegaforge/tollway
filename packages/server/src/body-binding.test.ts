import { bindBodyToResource, bodyDigest, Ed25519Signer, utf8Bytes } from "@vegaforge/tollway-core";
import fc from "fast-check";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import { createMockFacilitator, type FacilitatorClient } from "./facilitator.js";
import {
  createPaywall,
  type GateOutcome,
  type PaywallConfig,
  type TollwayRequest,
} from "./gate.js";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "./headers.js";
import { BodyTooLargeError, bytesBody, readBodyStream } from "./request-body.js";

/**
 * Issue #164: for a route that sells what is in the request body, the body
 * is part of what was paid for. A payment settled for one body must not
 * unlock a different body on the same route.
 */

const config = {
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICE",
  network: "testnet",
  resource: "/infer",
  bindBody: { maxBytes: 1024 },
} satisfies PaywallConfig;

let signer: Ed25519Signer;
beforeAll(async () => {
  signer = await Ed25519Signer.generate("body-binding");
});

function post(body: string, headers: Record<string, string> = {}): TollwayRequest {
  return {
    method: "POST",
    url: "/infer",
    headers: { "content-type": "application/json", ...headers },
    body: bytesBody(utf8Bytes(body)),
  };
}

function pay(challenge: GateOutcome): string {
  if (challenge.kind !== "payment-required")
    throw new Error(`expected a 402, got ${challenge.kind}`);
  const accepted = decodePaymentRequiredHeader(challenge.headers[PAYMENT_REQUIRED_HEADER] ?? "")
    .accepts[0];
  if (!accepted) throw new Error("no payment requirements");
  return encodePaymentSignatureHeader({
    x402Version: 2,
    accepted,
    payload: { transaction: "signed-for-a-cheap-prompt" },
  });
}

function countingFacilitator(): FacilitatorClient & { calls: () => number } {
  const inner = createMockFacilitator();
  let calls = 0;
  return {
    ...inner,
    async verify(input) {
      calls++;
      return inner.verify(input);
    },
    async settle(input) {
      calls++;
      return inner.settle(input);
    },
    calls: () => calls,
  };
}

describe("body binding (#164)", () => {
  it("does not let a payment for body A unlock body B behind a shared cache", async () => {
    const cache = createInMemorySettlementCache();
    const gate = createPaywall(config, { signer, facilitator: createMockFacilitator(), cache });
    const cheap = '{"prompt":"hi"}';
    const header = pay(await gate(post(cheap)));

    const first = await gate(post(cheap, { [PAYMENT_SIGNATURE_HEADER]: header }));
    expect(first.kind).toBe("settled");

    const replay = await gate(
      post('{"prompt":"write a novel"}', { [PAYMENT_SIGNATURE_HEADER]: header }),
    );
    expect(replay.kind).not.toBe("settled");
  });

  it("still replays the receipt for the same body", async () => {
    const cache = createInMemorySettlementCache();
    const gate = createPaywall(config, { signer, facilitator: createMockFacilitator(), cache });
    const body = '{"prompt":"hi"}';
    const header = pay(await gate(post(body)));
    await gate(post(body, { [PAYMENT_SIGNATURE_HEADER]: header }));
    const again = await gate(post(body, { [PAYMENT_SIGNATURE_HEADER]: header }));
    expect(again).toMatchObject({ kind: "settled" });
  });

  it("names the bound identity in the challenge and the receipt", async () => {
    const gate = createPaywall(config, { signer, facilitator: createMockFacilitator() });
    const body = '{"prompt":"hi"}';
    const expected = await bindBodyToResource("/infer", utf8Bytes(body));
    const challenge = await gate(post(body));
    if (challenge.kind !== "payment-required") throw new Error("expected 402");
    expect(challenge.challenge.resource.url).toBe(expected);
    const settled = await gate(post(body, { [PAYMENT_SIGNATURE_HEADER]: pay(challenge) }));
    if (settled.kind !== "settled") throw new Error(`expected settled, got ${settled.kind}`);
    expect(settled.receipt.receipt.resource).toBe(expected);
  });

  it("leaves the identity of a route without body binding unchanged", async () => {
    const { bindBody: _unused, ...plain } = config;
    const gate = createPaywall(plain, { signer, facilitator: createMockFacilitator() });
    const challenge = await gate(post('{"prompt":"hi"}'));
    if (challenge.kind !== "payment-required") throw new Error("expected 402");
    expect(challenge.challenge.resource.url).toBe("/infer");
  });

  it("answers 413 over maxBytes without calling the facilitator", async () => {
    const facilitator = countingFacilitator();
    const gate = createPaywall(config, { signer, facilitator });
    const big = "x".repeat(1025);
    const unpaid = await gate(post(big));
    expect(unpaid).toMatchObject({ kind: "rejected", status: 413 });
    const paid = await gate(post(big, { [PAYMENT_SIGNATURE_HEADER]: "anything" }));
    expect(paid).toMatchObject({ status: 413 });
    expect(facilitator.calls()).toBe(0);
  });

  it("answers 413 from Content-Length before reading the body", async () => {
    const read = vi.fn();
    const gate = createPaywall(config, { signer, facilitator: createMockFacilitator() });
    const outcome = await gate({
      method: "POST",
      url: "/infer",
      headers: { "content-length": "4096" },
      body: { read },
    });
    expect(outcome).toMatchObject({ kind: "rejected", status: 413 });
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses a compressed body with 415", async () => {
    const gate = createPaywall(config, { signer, facilitator: createMockFacilitator() });
    expect(await gate(post("{}", { "content-encoding": "gzip" }))).toMatchObject({
      kind: "rejected",
      status: 415,
    });
  });

  it("refuses a content type outside contentTypes with 415", async () => {
    const gate = createPaywall(
      { ...config, bindBody: { maxBytes: 1024, contentTypes: ["application/json"] } },
      { signer, facilitator: createMockFacilitator() },
    );
    expect(await gate(post("hi", { "content-type": "text/plain" }))).toMatchObject({
      status: 415,
    });
    expect(
      await gate(post("{}", { "content-type": "application/json; charset=utf-8" })),
    ).toMatchObject({ kind: "payment-required" });
  });

  it("fails closed when the adapter passes no body", async () => {
    const gate = createPaywall(config, { signer, facilitator: createMockFacilitator() });
    expect(await gate({ method: "POST", url: "/infer", headers: {} })).toMatchObject({
      kind: "rejected",
      status: 500,
    });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
  ])("refuses maxBytes %s when the paywall is created", (maxBytes) => {
    expect(() =>
      createPaywall(
        { ...config, bindBody: { maxBytes } },
        { signer, facilitator: createMockFacilitator() },
      ),
    ).toThrow(TypeError);
  });
});

describe("bodyDigest", () => {
  it("matches a known SHA-256 vector, base64url without padding", async () => {
    // SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(await bodyDigest(utf8Bytes("abc"))).toBe("ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    expect(await bindBodyToResource("/infer", utf8Bytes("abc"))).toBe(
      "/infer#body-sha256=ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
    );
  });
});

describe("readBodyStream", () => {
  function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  it("digests the same for any chunking of the same bytes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 512 }),
        fc.array(fc.nat({ max: 512 }), { maxLength: 8 }),
        async (bytes, cuts) => {
          const points = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))].sort(
            (a, b) => a - b,
          );
          const chunks: Uint8Array[] = [];
          let start = 0;
          for (const point of [...points, bytes.length]) {
            chunks.push(bytes.slice(start, point));
            start = point;
          }
          const read = await readBodyStream(streamOf(chunks), 1024);
          expect(await bodyDigest(read)).toBe(await bodyDigest(bytes));
        },
      ),
    );
  });

  it("stops reading as soon as the limit is passed", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(100));
      },
    });
    await expect(readBodyStream(endless, 250)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulled).toBeLessThanOrEqual(4);
  });
});
