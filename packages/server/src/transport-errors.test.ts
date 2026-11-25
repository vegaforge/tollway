import { TollwayError } from "@vegaforge/tollway-core";
import { FacilitatorTimeoutError } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { isNetworkFailure, isPreSendFailure } from "./transport-errors.js";

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

/**
 * What each runtime's fetch throws when nothing listens on the port, as
 * captured from Node 24, Deno 2.9, Bun 1.2 and workerd (Miniflare 4).
 */
const REFUSED_BY_RUNTIME: ReadonlyArray<[string, Error]> = [
  [
    "Node",
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:59321"), {
        code: "ECONNREFUSED",
      }),
    }),
  ],
  [
    "Deno",
    new TypeError("fetch failed", {
      cause: new Error(
        "error sending request for url (http://127.0.0.1:59321/): client error (Connect): tcp connect error: Connection refused (os error 61)",
      ),
    }),
  ],
  [
    "Bun",
    Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
      code: "ConnectionRefused",
    }),
  ],
  ["workerd", new Error("Network connection lost.")],
];

describe("isNetworkFailure", () => {
  it.each(REFUSED_BY_RUNTIME)("recognises a failed fetch on %s", (_runtime, error) => {
    expect(isNetworkFailure(error)).toBe(true);
  });

  it.each([
    ["a browser (Chrome)", new TypeError("Failed to fetch")],
    ["a browser (Safari)", new TypeError("Load failed")],
    ["a browser (Firefox)", new TypeError("NetworkError when attempting to fetch resource.")],
    [
      "a Bun reset",
      Object.assign(new Error("The socket connection was closed unexpectedly."), {
        code: "ECONNRESET",
      }),
    ],
  ])("recognises a failed fetch in %s", (_runtime, error) => {
    expect(isNetworkFailure(error)).toBe(true);
  });

  it.each([
    ["a validation error", new Error("invalid signature")],
    ["a TypeError from a bug", new TypeError("Cannot read properties of undefined")],
    ["a thrown string", "fetch failed"],
  ])("does not treat %s as a network failure", (_name, error) => {
    expect(isNetworkFailure(error)).toBe(false);
  });
});

describe("isPreSendFailure on every runtime", () => {
  it.each(["Node", "Deno", "Bun"])("treats a refused connection on %s as never sent", (runtime) => {
    const refused = REFUSED_BY_RUNTIME.find(([name]) => name === runtime)?.[1];
    expect(isPreSendFailure(refused)).toBe(true);
  });

  it("treats workerd's lost connection as possibly received", () => {
    // workerd gives the same message whether or not the request went out.
    const lost = REFUSED_BY_RUNTIME.find(([name]) => name === "workerd")?.[1];
    expect(isPreSendFailure(lost)).toBe(false);
  });
});
