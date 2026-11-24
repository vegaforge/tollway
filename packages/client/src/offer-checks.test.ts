/**
 * Offer sanity checks (#209): one test per check, pass and fail, plus the
 * client wiring. A rejected offer must never reach the policy engine or the
 * settler. The x402 settler's PaymentPolicy is tested in x402-settler.test.ts,
 * where the Stellar scheme is stubbed.
 */

import {
  buildReceipt,
  createPolicyEngine,
  Ed25519Signer,
  type PaymentOffer,
  type SignedReceipt,
  signReceipt,
  TollwayError,
} from "@vegaforge/tollway-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type ClientEvent, createClient, OfferNetworkMismatchError } from "./index.js";
import {
  type OfferChecks,
  OfferRejectedError,
  runOfferChecks,
  validateOfferChecks,
} from "./offer-checks.js";

const RESOURCE = "https://api.example.com/data";
const PAYEE = "GCPAYEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_PAYEE = "GOTHER0000000000000000000000000000000000000000000000000000";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const XLM = "CXLM0000000000000000000000000000000000000000000000000000AB";

const BASE_OFFER: PaymentOffer = {
  resource: RESOURCE,
  amount: "10000",
  asset: USDC,
  payTo: PAYEE,
  network: "testnet",
  models: ["x402"],
};

/** The error runOfferChecks throws, or undefined when the offer passes. */
function rejection(
  offer: PaymentOffer,
  checks?: OfferChecks,
  requested = RESOURCE,
): OfferRejectedError | undefined {
  try {
    runOfferChecks(offer, requested, "testnet", checks);
    return undefined;
  } catch (error) {
    if (error instanceof OfferRejectedError) return error;
    throw error;
  }
}

let receipt: SignedReceipt;

beforeAll(async () => {
  const signer = await Ed25519Signer.generate("service-key");
  receipt = await signReceipt(
    buildReceipt({
      payer: "GPAYER000000000000000000000000000000000000000000000000000A",
      payee: PAYEE,
      amount: "10000",
      asset: USDC,
      resource: RESOURCE,
      model: "x402",
      settlement: { kind: "transaction", txHash: "a".repeat(64) },
      network: "testnet",
    }),
    signer,
  );
});

describe("structural check", () => {
  it("passes a well-formed offer", () => {
    expect(rejection(BASE_OFFER)).toBeUndefined();
  });

  it.each([
    ["an empty payTo", { payTo: "" }],
    ["a whitespace-only payTo", { payTo: "  " }],
    ["an empty asset", { asset: "" }],
    ["no models", { models: [] }],
    ["a decimal amount", { amount: "12.5" }],
    ["a negative amount", { amount: "-1" }],
    ["an amount with a sign", { amount: "+5" }],
    ["an empty amount", { amount: "" }],
  ])("rejects %s", (_name, change) => {
    expect(rejection({ ...BASE_OFFER, ...change } as PaymentOffer)?.checkName).toBe("structural");
  });

  it("rejects a zero amount by default", () => {
    const error = rejection({ ...BASE_OFFER, amount: "0" });
    expect(error?.checkName).toBe("structural");
    expect(error?.message).toContain("allowZeroAmount");
  });

  it("accepts a zero amount when allowZeroAmount is set", () => {
    expect(rejection({ ...BASE_OFFER, amount: "0" }, { allowZeroAmount: true })).toBeUndefined();
  });

  it("rejects an offer for a different path than the agent requested", () => {
    const error = rejection({ ...BASE_OFFER, resource: "https://api.example.com/cheap" });
    expect(error?.checkName).toBe("structural");
  });

  it("uses the receipt binding's path-and-query rule (#202) for the resource", () => {
    // The same path and query on a different origin is the same resource under
    // #202's rule; a different query string is a different one.
    expect(rejection({ ...BASE_OFFER, resource: "https://cdn.example.com/data" })).toBeUndefined();
    expect(rejection({ ...BASE_OFFER, resource: "/data" })).toBeUndefined();
    expect(rejection({ ...BASE_OFFER, resource: "/data?page=2" })?.checkName).toBe("structural");
  });
});

describe("network check", () => {
  it("passes an offer on the client's network", () => {
    expect(rejection(BASE_OFFER)).toBeUndefined();
  });

  it("rejects an offer on another network with no checks configured", () => {
    const error = rejection({ ...BASE_OFFER, network: "mainnet" });
    expect(error?.checkName).toBe("network");
    expect(error?.message).toContain("mainnet");
  });

  it("rejects a testnet offer for a mainnet client", () => {
    expect(() =>
      runOfferChecks({ ...BASE_OFFER, network: "testnet" }, RESOURCE, "mainnet"),
    ).toThrow(OfferRejectedError);
  });
});

describe("allowedAssets check", () => {
  it("passes an asset in the allowlist", () => {
    expect(rejection(BASE_OFFER, { allowedAssets: [USDC] })).toBeUndefined();
  });

  it("rejects an asset outside the allowlist", () => {
    expect(rejection(BASE_OFFER, { allowedAssets: [XLM] })?.checkName).toBe("allowedAssets");
  });

  it("does not apply when not configured", () => {
    expect(rejection({ ...BASE_OFFER, asset: XLM }, {})).toBeUndefined();
  });
});

describe("maxAmount check", () => {
  it("passes an amount equal to the ceiling", () => {
    expect(rejection(BASE_OFFER, { maxAmount: { [USDC]: "10000" } })).toBeUndefined();
  });

  it("rejects an amount over the ceiling", () => {
    const error = rejection(BASE_OFFER, { maxAmount: { [USDC]: "9999" } });
    expect(error?.checkName).toBe("maxAmount");
    expect(error?.message).toContain("9999");
  });

  it("fails closed for an asset with no entry", () => {
    const error = rejection(BASE_OFFER, { maxAmount: { [XLM]: "50000" } });
    expect(error?.checkName).toBe("maxAmount");
    expect(error?.message).toContain("fails closed");
  });

  it("does not let an Object.prototype name supply a ceiling", () => {
    const error = rejection({ ...BASE_OFFER, asset: "constructor" }, { maxAmount: {} });
    expect(error?.checkName).toBe("maxAmount");
  });

  it("does not apply when not configured", () => {
    expect(rejection({ ...BASE_OFFER, amount: "999999999" }, {})).toBeUndefined();
  });

  it("compares as bigint beyond Number.MAX_SAFE_INTEGER", () => {
    const below = "90000000000000000001";
    const ceiling = "90000000000000000002";
    expect(
      rejection({ ...BASE_OFFER, amount: below }, { maxAmount: { [USDC]: ceiling } }),
    ).toBeUndefined();
    expect(
      rejection({ ...BASE_OFFER, amount: ceiling }, { maxAmount: { [USDC]: below } })?.checkName,
    ).toBe("maxAmount");
  });
});

describe("allowedPayees check", () => {
  it("passes a payee in the allowlist", () => {
    expect(rejection(BASE_OFFER, { allowedPayees: [PAYEE] })).toBeUndefined();
  });

  it("rejects a payee outside the allowlist", () => {
    expect(rejection(BASE_OFFER, { allowedPayees: [OTHER_PAYEE] })?.checkName).toBe(
      "allowedPayees",
    );
  });

  it("matches exact strings, never a prefix", () => {
    expect(rejection(BASE_OFFER, { allowedPayees: [PAYEE.slice(0, 10)] })?.checkName).toBe(
      "allowedPayees",
    );
  });
});

describe("validateOfferChecks", () => {
  it.each([
    ["a decimal ceiling", { maxAmount: { [USDC]: "1.5" } }],
    ["a negative ceiling", { maxAmount: { [USDC]: "-1" } }],
    ["an empty asset key", { maxAmount: { "": "1" } }],
    ["an empty payee", { allowedPayees: [""] }],
    ["an empty asset", { allowedAssets: [""] }],
    ["a requireNetwork other than the client's", { requireNetwork: "mainnet" as const }],
  ])("refuses %s", (_name, checks) => {
    expect(() => validateOfferChecks(checks, "testnet")).toThrow(TypeError);
  });

  it("accepts a well-formed configuration", () => {
    expect(() =>
      validateOfferChecks(
        {
          maxAmount: { [USDC]: "1000000" },
          allowedPayees: [PAYEE],
          allowedAssets: [USDC],
          requireNetwork: "testnet",
          allowZeroAmount: false,
        },
        "testnet",
      ),
    ).not.toThrow();
  });
});

describe("OfferRejectedError", () => {
  it("is a TollwayError with code offer-rejected and names the check", () => {
    const error = new OfferRejectedError("maxAmount", "too much");
    expect(error).toBeInstanceOf(TollwayError);
    expect(error.code).toBe("offer-rejected");
    expect(error.checkName).toBe("maxAmount");
  });
});

describe("createClient offerChecks", () => {
  it("refuses a malformed configuration when the client is created", () => {
    expect(() =>
      createClient({
        network: "testnet",
        settler: { settle: vi.fn() },
        offerChecks: { maxAmount: { [USDC]: "ten" } },
      }),
    ).toThrow(TypeError);
  });

  it("never reaches the policy engine or the settler for a rejected offer", async () => {
    const policy = createPolicyEngine({});
    const evaluate = vi.spyOn(policy, "evaluate");
    const settler = { settle: vi.fn() };
    const client = createClient({
      network: "testnet",
      settler,
      policy,
      offerChecks: { allowedPayees: [OTHER_PAYEE] },
    });

    await expect(client.pay({ resource: RESOURCE, offer: BASE_OFFER })).rejects.toMatchObject({
      code: "offer-rejected",
      checkName: "allowedPayees",
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(settler.settle).not.toHaveBeenCalled();
  });

  it("rejects an offer over its ceiling before the settler", async () => {
    const settler = { settle: vi.fn() };
    const client = createClient({
      network: "testnet",
      settler,
      offerChecks: { maxAmount: { [USDC]: "9999" } },
    });
    await expect(client.pay({ resource: RESOURCE, offer: BASE_OFFER })).rejects.toBeInstanceOf(
      OfferRejectedError,
    );
    expect(settler.settle).not.toHaveBeenCalled();
  });

  it("rejects a zero-amount offer unless the client opts in", async () => {
    const settler = { settle: vi.fn() };
    const client = createClient({ network: "testnet", settler });
    await expect(
      client.pay({ resource: RESOURCE, offer: { ...BASE_OFFER, amount: "0" } }),
    ).rejects.toMatchObject({ checkName: "structural" });
    expect(settler.settle).not.toHaveBeenCalled();
  });

  it("emits skip with the check name, then the error", async () => {
    const client = createClient({
      network: "testnet",
      settler: { settle: vi.fn() },
      offerChecks: { allowedAssets: [XLM] },
    });
    const events: ClientEvent[] = [];
    client.on((event) => events.push(event));

    await expect(client.pay({ resource: RESOURCE, offer: BASE_OFFER })).rejects.toBeInstanceOf(
      OfferRejectedError,
    );
    expect(events.map((event) => event.type)).toEqual(["skip", "error"]);
    expect(events[0]).toMatchObject({
      type: "skip",
      reason: expect.stringContaining("allowedAssets"),
    });
  });

  it("refuses an offer on another network with no offerChecks configured", async () => {
    // The client's own network binding (#202) refuses it first, before any
    // offer check, policy or settler.
    const settler = { settle: vi.fn() };
    const client = createClient({ network: "testnet", settler });
    await expect(
      client.pay({ resource: RESOURCE, offer: { ...BASE_OFFER, network: "mainnet" } }),
    ).rejects.toBeInstanceOf(OfferNetworkMismatchError);
    expect(settler.settle).not.toHaveBeenCalled();
  });

  it("pays an offer that passes every check", async () => {
    const settler = { settle: vi.fn().mockResolvedValue(receipt) };
    const client = createClient({
      network: "testnet",
      settler,
      offerChecks: {
        maxAmount: { [USDC]: "10000" },
        allowedPayees: [PAYEE],
        allowedAssets: [USDC],
      },
    });

    const result = await client.pay({ resource: RESOURCE, offer: BASE_OFFER });
    expect(result.receipt.receipt.id).toBe(receipt.receipt.id);
    expect(settler.settle).toHaveBeenCalledOnce();
  });
});
