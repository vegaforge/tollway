/**
 * x402 Bazaar discovery publishing (#154), checked with the real
 * `@x402/extensions` validators and extractor, and the real x402 client.
 */

import { Ed25519Signer, TollwayError } from "@vegaforge/tollway-core";
import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import {
  type DiscoveryExtension,
  extractDiscoveryInfo,
  validateDiscoveryExtension,
} from "@x402/extensions/bazaar";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listDiscoveryResources } from "./discovery.js";
import {
  createHttpFacilitator,
  createMockFacilitator,
  type FacilitatorClient,
} from "./facilitator.js";
import { createPaywall, type PaywallConfig, type TollwayRequest } from "./gate.js";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "./headers.js";

const STELLAR_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAYEE = "GCKFBEIYTKP5RDBQMUTAPDCAIVMOLKZYNYKRJHAEWHJDYUGSA3FDQQ3V";
const FACILITATOR = "https://facilitator.example";

let signer: Ed25519Signer;
let mock: FacilitatorClient;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("test-key");
  mock = createMockFacilitator();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function config(overrides: Partial<PaywallConfig> = {}): PaywallConfig {
  return { amount: "10000", asset: STELLAR_USDC, payTo: PAYEE, network: "testnet", ...overrides };
}

const weather: PaywallConfig["discovery"] = {
  kind: "query",
  routeTemplate: "/weather/:city",
  description: "Current weather for a city",
  mimeType: "application/json",
  input: { units: "metric" },
  inputSchema: { properties: { units: { type: "string" } } },
  output: { example: { tempC: 21 } },
};

function request(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): TollwayRequest {
  return { method, url, headers };
}

async function challengeFor(
  discovery: PaywallConfig["discovery"],
  req: TollwayRequest,
  facilitator: FacilitatorClient = mock,
) {
  const gate = createPaywall(config(discovery ? { discovery } : {}), { signer, facilitator });
  const outcome = await gate(req);
  if (outcome.kind !== "payment-required") throw new Error(`expected a 402, got ${outcome.kind}`);
  return outcome.challenge;
}

describe("publishing a route through Bazaar discovery", () => {
  it("publishes nothing for a route without a discovery block", async () => {
    const challenge = await challengeFor(undefined, request("GET", "https://api.example.com/q"));
    expect(challenge.extensions).toBeUndefined();
    expect(challenge.resource).toEqual({ url: "https://api.example.com/q" });
  });

  it("publishes a query route enriched with the method and route template", async () => {
    const challenge = await challengeFor(
      weather,
      request("GET", "https://api.example.com/weather/paris?units=metric"),
    );
    const bazaar = challenge.extensions?.bazaar as DiscoveryExtension;
    expect(validateDiscoveryExtension(bazaar)).toEqual({ valid: true });
    expect(bazaar.info.input).toMatchObject({ type: "http", method: "GET" });
    expect(bazaar).toMatchObject({ routeTemplate: "/weather/:city" });
    expect(challenge.resource).toMatchObject({
      description: "Current weather for a city",
      mimeType: "application/json",
    });
  });

  it("publishes the declared path-parameter example, never the payer's own path values", async () => {
    const challenge = await challengeFor(
      { ...weather, pathParams: { city: "lisbon" } },
      request("GET", "https://api.example.com/weather/alice-home-town"),
    );
    const bazaar = challenge.extensions?.bazaar as DiscoveryExtension;
    expect(bazaar.info.input).toMatchObject({ pathParams: { city: "lisbon" } });
    expect(JSON.stringify(challenge.extensions)).not.toContain("alice-home-town");
    expect(validateDiscoveryExtension(bazaar)).toEqual({ valid: true });
  });

  it("publishes a JSON body route with the POST it was called with", async () => {
    const challenge = await challengeFor(
      {
        kind: "body",
        bodyType: "json",
        input: { prompt: "hello" },
        inputSchema: { properties: { prompt: { type: "string" } }, required: ["prompt"] },
      },
      request("POST", "https://api.example.com/complete"),
    );
    const bazaar = challenge.extensions?.bazaar as DiscoveryExtension;
    expect(validateDiscoveryExtension(bazaar)).toEqual({ valid: true });
    expect(bazaar.info.input).toMatchObject({ method: "POST", bodyType: "json" });
  });

  it.each([
    ["an unknown body type", { kind: "body", bodyType: "binary" }, /bodyType/],
    [
      "a route template that climbs out of the path",
      { kind: "query", routeTemplate: "/files/../secret" },
      /not a valid route template/,
    ],
    [
      "a route template that is a URL",
      { kind: "query", routeTemplate: "https://other.example/x" },
      /not a valid route template/,
    ],
    [
      "an example that does not match its schema",
      {
        kind: "query",
        input: { units: 5 },
        inputSchema: { properties: { units: { type: "string" } } },
      },
      /invalid Bazaar discovery declaration/,
    ],
  ])("refuses %s when the paywall is created", (_name, discovery, message) => {
    let thrown: unknown;
    try {
      // Declarations arrive from config files, so the cases include values
      // the type forbids.
      createPaywall(config({ discovery: discovery as unknown as PaywallConfig["discovery"] }), {
        signer,
        facilitator: mock,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TollwayError);
    expect(thrown).toMatchObject({ code: "invalid-discovery" });
    expect(String(thrown)).toMatch(message);
  });

  it("reaches a cataloguing facilitator: extractDiscoveryInfo reads the payload Tollway forwards", async () => {
    // The facilitator's /verify request is captured and refused, which is
    // all a catalogue needs: it reads the payload it is asked to verify.
    const sent: Array<{ paymentPayload: unknown; paymentRequirements: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith("/verify")) {
          sent.push(JSON.parse(String(init?.body)));
          return Response.json({ isValid: false, invalidReason: "test_stop" });
        }
        throw new Error(`unexpected request to ${String(url)}`);
      }),
    );
    const facilitator = createHttpFacilitator(FACILITATOR);
    const gate = createPaywall(config({ discovery: weather }), { signer, facilitator });
    const url = "https://api.example.com/weather/paris";

    const unpaid = await gate(request("GET", url));
    if (unpaid.kind !== "payment-required") throw new Error("expected a 402");
    // The real x402 client builds the payload from the 402, echoing its
    // resource and extensions; only the Stellar signing is stubbed.
    const client = x402Client.fromConfig({
      schemes: [
        {
          network: "stellar:testnet",
          client: {
            scheme: "exact",
            async createPaymentPayload(x402Version: number) {
              return { x402Version, payload: { transaction: "signed-transaction" } };
            },
          },
        },
      ],
      spendControls: {
        allowedAssets: [
          { network: "stellar:testnet", asset: STELLAR_USDC, maxAmountPerPayment: "10000" },
        ],
      },
    });
    const paymentRequired = decodePaymentRequiredHeader(
      unpaid.headers[PAYMENT_REQUIRED_HEADER] as string,
    );
    const payload = await client.createPaymentPayload(paymentRequired);
    await gate(
      request("GET", url, { [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(payload) }),
    );

    expect(sent).toHaveLength(1);
    const forwarded = sent[0] as {
      paymentPayload: Parameters<typeof extractDiscoveryInfo>[0];
      paymentRequirements: PaymentRequirements;
    };
    const discovered = extractDiscoveryInfo(
      forwarded.paymentPayload,
      forwarded.paymentRequirements,
    );
    // The catalogue lists the template, never the city this payer asked
    // for, and the declaration carries no path value from this request.
    // (The payload's resource.url is the request URL in every x402 payment,
    // with or without discovery.)
    expect(JSON.stringify(forwarded.paymentPayload.extensions)).not.toContain("paris");
    expect(discovered).toMatchObject({
      resourceUrl: "https://api.example.com/weather/:city",
      method: "GET",
      routeTemplate: "/weather/:city",
      description: "Current weather for a city",
    });
  });
});

describe("listDiscoveryResources", () => {
  const item = {
    resource: "https://api.example.com/weather/:city",
    type: "http",
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "stellar:testnet",
        amount: "10000",
        asset: STELLAR_USDC,
        payTo: PAYEE,
        maxTimeoutSeconds: 60,
      },
    ],
    lastUpdated: "2026-11-23T12:00:00Z",
    description: "Current weather for a city",
  };

  function serve(body: unknown) {
    const fetch = vi.fn(async (_url: string | URL | Request) => Response.json(body));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("lists a facilitator's catalogue through withBazaar, typed", async () => {
    const fetch = serve({
      x402Version: 2,
      items: [item],
      pagination: { limit: 20, offset: 0, total: 1 },
    });
    const catalogue = await listDiscoveryResources(FACILITATOR, {
      params: { type: "http", limit: 20 },
    });
    expect(catalogue.items[0]).toMatchObject({
      resource: item.resource,
      description: item.description,
    });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `${FACILITATOR}/discovery/resources?type=http&limit=20`,
    );
  });

  it.each([
    ["no items list", { x402Version: 2, pagination: { limit: 1, offset: 0, total: 0 } }, "items"],
    [
      "an entry without an amount",
      {
        x402Version: 2,
        items: [{ ...item, accepts: [{ ...item.accepts[0], amount: undefined }] }],
        pagination: { limit: 1, offset: 0, total: 1 },
      },
      "items.0.accepts.0.amount",
    ],
    [
      "a negative total",
      { x402Version: 2, items: [], pagination: { limit: 1, offset: 0, total: -1 } },
      "pagination.total",
    ],
  ])("refuses a catalogue with %s, naming the field", async (_name, body, path) => {
    serve(body);
    const error = await listDiscoveryResources(FACILITATOR).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TollwayError);
    expect(error).toMatchObject({ code: "facilitator-invalid-response" });
    expect(String(error)).toContain(`at ${path}:`);
  });
});
