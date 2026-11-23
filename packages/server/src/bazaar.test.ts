/**
 * Issue #154 coverage: Bazaar discovery publishing. The gate carries a
 * route-level discovery declaration onto the 402 challenge; a
 * cataloguing facilitator can recover it from the payload with the
 * upstream `extractDiscoveryInfo`.
 */

import { Ed25519Signer, TollwayError } from "@vegaforge/tollway-core";
import { validateDiscoveryExtensionSpec } from "@x402/extensions/bazaar";
import { beforeAll, describe, expect, it } from "vitest";
import { createMockFacilitator, type FacilitatorClient } from "./facilitator.js";
import { createPaywall, type PaywallConfig, type TollwayRequest } from "./gate.js";

const STELLAR_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const STELLAR_DESTINATION = "GCKFBEIYTKP5RDBQMUTAPDCAIVMOLKZYNYKRJHAEWHJDYUGSA3FDQQ3V";

let signer: Ed25519Signer;
let facilitator: FacilitatorClient;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("test-key");
  facilitator = createMockFacilitator();
});

function baseConfig(overrides: Partial<PaywallConfig> = {}): PaywallConfig {
  return {
    amount: "10000",
    asset: STELLAR_USDC,
    payTo: STELLAR_DESTINATION,
    network: "testnet",
    ...overrides,
  };
}

function unpaidRequest(): TollwayRequest {
  return { method: "GET", url: "https://api.example.com/quotes", headers: {} };
}

describe("Bazaar discovery publishing (Issue #154)", () => {
  it("routes without a discovery block publish nothing", async () => {
    const gate = createPaywall(baseConfig(), { signer, facilitator });
    const outcome = await gate(unpaidRequest());
    if (outcome.kind !== "payment-required") throw new Error("expected 402");
    expect(outcome.challenge.extensions).toBeUndefined();
  });

  it("includes a validated bazaar extension in the 402 challenge for a query route", async () => {
    const gate = createPaywall(
      baseConfig({
        discovery: {
          kind: "query",
          inputSchema: {
            type: "object",
            properties: { symbol: { type: "string" } },
            required: ["symbol"],
          },
          output: { example: { price: "1.5" } },
        },
      }),
      { signer, facilitator },
    );
    const outcome = await gate(unpaidRequest());
    if (outcome.kind !== "payment-required") throw new Error("expected 402");
    const extensions = outcome.challenge.extensions;
    expect(extensions).toBeDefined();
    if (!extensions) return;
    const bazaar = extensions.bazaar;
    expect(bazaar).toBeDefined();
    const result = validateDiscoveryExtensionSpec(bazaar as Record<string, unknown>);
    expect(result.valid).toBe(true);
  });

  it("includes a validated bazaar extension for a JSON body route", async () => {
    const gate = createPaywall(
      baseConfig({
        discovery: {
          kind: "body",
          bodyType: "json",
          inputSchema: {
            type: "object",
            properties: { prompt: { type: "string" } },
            required: ["prompt"],
          },
        },
      }),
      { signer, facilitator },
    );
    const outcome = await gate(unpaidRequest());
    if (outcome.kind !== "payment-required") throw new Error("expected 402");
    const extensions = outcome.challenge.extensions;
    expect(extensions).toBeDefined();
    if (!extensions) return;
    const bazaar = extensions.bazaar;
    expect(bazaar).toBeDefined();
    const result = validateDiscoveryExtensionSpec(bazaar as Record<string, unknown>);
    expect(result.valid).toBe(true);
  });

  it("carries the declaration shape a cataloguing facilitator can round-trip", async () => {
    // The real extractDiscoveryInfo path pulls the extension off a signed
    // PaymentPayload that the x402 client builds; that is covered by the
    // client's x402 tests. Here we assert the gate puts the declaration
    // on the 402 challenge with the fields a facilitator needs: the
    // extension key, the required `info.input.type` discriminator, and
    // the originating resource url.
    const gate = createPaywall(
      baseConfig({
        discovery: {
          kind: "query",
          inputSchema: {
            type: "object",
            properties: { symbol: { type: "string" } },
            required: ["symbol"],
          },
        },
      }),
      { signer, facilitator },
    );
    const outcome = await gate(unpaidRequest());
    if (outcome.kind !== "payment-required") throw new Error("expected 402");
    expect(outcome.challenge.resource.url).toBe("https://api.example.com/quotes");
    const ext = outcome.challenge.extensions?.bazaar as
      | { info?: { input?: { type?: string } } }
      | undefined;
    expect(ext?.info?.input?.type).toBe("http");
  });

  it("refuses a malformed discovery declaration at createPaywall time", () => {
    expect(() =>
      createPaywall(
        baseConfig({
          discovery: {
            kind: "body",
            // @ts-expect-error - deliberately invalid bodyType to exercise
            // the construction-time validation.
            bodyType: "binary",
          },
        }),
        { signer, facilitator },
      ),
    ).toThrow(TollwayError);
  });
});
