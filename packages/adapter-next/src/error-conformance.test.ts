import {
  GATE_ERROR_CODES,
  GATE_ERRORS,
  type Gate,
  type GateErrorCode,
  type GateRejection,
  renderGateRejection,
} from "@vegaforge/tollway-server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { withPaywall } from "./index.js";
import { paywallProxy } from "./proxy.js";

/**
 * Issue #161 conformance: for every gate error code, this adapter answers
 * with the status, body and headers the server's renderer defines. The same
 * table drives the Express, Fastify, Hono and Next suites, so a drift in any
 * one adapter fails here.
 */
function rejectionFor(code: GateErrorCode): GateRejection {
  const headers: Record<string, string> = {};
  for (const name of GATE_ERRORS[code].headers) {
    headers[name] = name === "retry-after" ? "7" : `value-for-${name}`;
  }
  return {
    kind: "rejected",
    status: GATE_ERRORS[code].status,
    code,
    reason: `message for ${code}`,
    ...(code === "payment-invalid"
      ? { upstreamReason: "invalid_exact_stellar_payload_wrong_amount" }
      : {}),
    headers,
  };
}

const rejectingGate =
  (rejection: GateRejection): Gate =>
  async () =>
    rejection;

describe("Next error conformance (#161)", () => {
  it.each(GATE_ERROR_CODES)("withPaywall renders %s like every adapter", async (code) => {
    const rejection = rejectionFor(code);
    const expected = renderGateRejection(rejection);
    const handler = withPaywall(rejectingGate(rejection), () => Response.json({ served: true }));
    const response = await handler(new Request("https://example.test/paid"));
    expect(response.status).toBe(expected.status);
    expect(await response.json()).toEqual(expected.body);
    for (const [name, value] of Object.entries(expected.headers)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it.each(GATE_ERROR_CODES)("paywallProxy renders %s like every adapter", async (code) => {
    const rejection = rejectionFor(code);
    const expected = renderGateRejection(rejection);
    const proxy = paywallProxy({ routes: [{ path: "/paid", gate: rejectingGate(rejection) }] });
    const response = await proxy(new NextRequest("https://example.test/paid"));
    expect(response.status).toBe(expected.status);
    expect(await response.json()).toEqual(expected.body);
    for (const [name, value] of Object.entries(expected.headers)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });
});
