import * as upstream from "@x402/stellar";
import { describe, expect, it } from "vitest";
import * as local from "./stellar-caip2.js";

describe("CAIP-2 network ids", () => {
  it("equal the ones @x402/stellar exports", () => {
    expect(local.STELLAR_PUBNET_CAIP2).toBe(upstream.STELLAR_PUBNET_CAIP2);
    expect(local.STELLAR_TESTNET_CAIP2).toBe(upstream.STELLAR_TESTNET_CAIP2);
    expect(local.STELLAR_WILDCARD_CAIP2).toBe(upstream.STELLAR_WILDCARD_CAIP2);
  });
});
