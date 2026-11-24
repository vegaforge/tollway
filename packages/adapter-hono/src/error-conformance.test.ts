import {
  GATE_ERROR_CODES,
  GATE_ERRORS,
  type Gate,
  type GateErrorCode,
  type GateRejection,
  renderGateRejection,
} from "@vegaforge/tollway-server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { honoPaywall } from "./index.js";

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

describe("honoPaywall error conformance (#161)", () => {
  it.each(GATE_ERROR_CODES)("renders %s like every adapter", async (code) => {
    const rejection = rejectionFor(code);
    const expected = renderGateRejection(rejection);
    const app = new Hono();
    app.get("/paid", honoPaywall(rejectingGate(rejection)), (c) => c.json({ served: true }));
    const response = await app.request("/paid");
    expect(response.status).toBe(expected.status);
    expect(await response.json()).toEqual(expected.body);
    for (const [name, value] of Object.entries(expected.headers)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });
});
