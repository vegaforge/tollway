import { Ed25519Signer } from "@vegaforge/tollway-core";
import { beforeAll, describe, expect, it } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import { createMockFacilitator } from "./facilitator.js";
import { encodePaymentSignatureHeader } from "./headers.js";
import { createRouteTable } from "./route-table.js";

const config = {
  amount: "10000",
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet" as const,
};
let signer: Ed25519Signer;
beforeAll(async () => {
  signer = await Ed25519Signer.generate("route-table-test");
});

function table(routes: Record<string, typeof config>, cache = createInMemorySettlementCache()) {
  return createRouteTable(routes, { signer, facilitator: createMockFacilitator(), cache });
}

describe("route-table matching", () => {
  it("matches exact paths before parameter patterns and normalizes query, slash, and unreserved escapes", () => {
    const routes = table({ "GET /quotes/:symbol": config, "GET /quotes/latest": config });
    expect(routes.match("GET", "/quotes/latest?currency=usd")?.resource).toBe("/quotes/latest");
    expect(routes.match("GET", "/quotes/%6Catest/")?.resource).toBe("/quotes/latest");
  });

  it("passes unmatched methods and paths through and lists configured routes", () => {
    const routes = table({ "GET /paid": config });
    expect(routes.match("POST", "/paid")).toBeUndefined();
    expect(routes.match("GET", "/free")).toBeUndefined();
    expect(routes.list()).toMatchObject([{ method: "GET", pattern: "/paid", amount: "10000" }]);
  });

  it("rejects duplicate normalized keys, ambiguous patterns, unknown methods, and invalid amounts", () => {
    expect(() => table({ "GET /a/": config, "get /a": config })).toThrow(/duplicate route/);
    expect(() => table({ "GET /a/:x": config, "GET /a/:y": config })).toThrow(/ambiguous route/);
    expect(() => table({ "BREW /a": config })).toThrow(/unknown method/);
    expect(() => table({ "GET /a": { ...config, amount: "1.5" } })).toThrow(/invalid amount/);
  });

  it("rejects a receipt replay across routes with the same payment", async () => {
    const routes = table({ "GET /first": config, "GET /second": config });
    const signature = {
      "payment-signature": encodePaymentSignatureHeader({
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: "stellar:testnet",
          asset: config.asset,
          amount: config.amount,
          payTo: config.payTo,
          maxTimeoutSeconds: 60,
          extra: {},
        },
        payload: { transaction: "mock-signed-auth-entry" },
      }),
    };
    const firstMatch = routes.match("GET", "/first");
    const secondMatch = routes.match("GET", "/second");
    expect(firstMatch).toBeDefined();
    expect(secondMatch).toBeDefined();
    const first = await firstMatch?.gate({ method: "GET", url: "/first", headers: signature });
    expect(first?.kind).toBe("settled");
    const replay = await secondMatch?.gate({ method: "GET", url: "/second", headers: signature });
    expect(replay).toEqual({
      kind: "rejected",
      status: 409,
      code: "offer-mismatch",
      reason: "payment already settled for a different offer",
    });
  });
});

// A request path is attacker input. Trimming trailing slashes with a
// backtracking regex took quadratic time on a long run of slashes that does
// not end the path, which let one request stall the event loop.
describe("route-table path normalization cost", () => {
  it("handles a path of 50 000 slashes followed by a character in linear time", () => {
    const routes = table({ "GET /quotes/latest": config });
    const hostile = `/${"/".repeat(50_000)}x`;
    const started = performance.now();
    expect(routes.match("GET", hostile)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("still trims trailing slashes", () => {
    const routes = table({ "GET /quotes/latest": config });
    expect(routes.match("GET", "/quotes/latest///")?.resource).toBe("/quotes/latest");
  });
});
