import { TollwayError } from "@vegaforge/tollway-core";
import { FacilitatorTimeoutError } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { isPreSendFailure } from "./transport-errors.js";

/** The shape Node fetch and createHttpFacilitator give a socket error. */
function wrapped(socket: Error): TollwayError {
  return new TollwayError("payment-failed", "facilitator /settle request failed: fetch failed", {
    cause: new TypeError("fetch failed", { cause: socket }),
  });
}

function socketError(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

describe("isPreSendFailure", () => {
  it.each([
    "ECONNREFUSED",
    "ENOTFOUND",
    "EAI_AGAIN",
  ])("treats %s anywhere in the cause chain as never sent", (code) => {
    expect(isPreSendFailure(wrapped(socketError(code)))).toBe(true);
    expect(isPreSendFailure(socketError(code))).toBe(true);
  });

  it.each([
    ["a reset after the request was written", wrapped(socketError("ECONNRESET"))],
    ["the transport deadline", wrapped(new FacilitatorTimeoutError("settle", 1_000))],
    ["a plain error", new Error("socket hang up")],
    ["a thrown string", "boom"],
    ["nothing", undefined],
  ])("treats %s as possibly received", (_name, error) => {
    expect(isPreSendFailure(error)).toBe(false);
  });
});
