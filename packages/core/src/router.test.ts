import { describe, expect, it } from "vitest";
import { TollwayError } from "./errors.js";
import { createDefaultRouter } from "./router.js";
import type { PaymentOffer } from "./types.js";

const router = createDefaultRouter();

const offer: PaymentOffer = {
  resource: "https://api.example.com/quotes/latest",
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: "GSERVICE",
  network: "testnet",
  models: ["mpp-charge", "x402"],
};

describe("createDefaultRouter", () => {
  it("defaults to x402 for an unknown counterparty", async () => {
    const decision = await router.decide({ counterparty: "GSERVICE", resource: "/a" });
    expect(decision).toEqual({ model: "x402", reason: "default" });
  });

  it("lets an explicit override win", async () => {
    const decision = await router.decide({
      counterparty: "GSERVICE",
      resource: "/a",
      offer,
      override: "mpp-channel",
    });
    expect(decision).toEqual({ model: "mpp-channel", reason: "override" });
  });

  it("picks the cheapest mutually acceptable model from an offer", async () => {
    const decision = await router.decide({ counterparty: "GSERVICE", resource: "/a", offer });
    expect(decision).toEqual({ model: "x402", reason: "offer" });
  });

  it("respects the allowed-models constraint when reading an offer", async () => {
    const decision = await router.decide({
      counterparty: "GSERVICE",
      resource: "/a",
      offer,
      allowedModels: ["mpp-charge"],
    });
    expect(decision).toEqual({ model: "mpp-charge", reason: "offer" });
  });

  it("throws when offer and policy have no model in common", async () => {
    await expect(
      router.decide({
        counterparty: "GSERVICE",
        resource: "/a",
        offer: { ...offer, models: ["mpp-channel"] },
        allowedModels: ["x402"],
      }),
    ).rejects.toThrow(TollwayError);
  });

  it("falls back to the first allowed model when x402 is disallowed", async () => {
    const decision = await router.decide({
      counterparty: "GSERVICE",
      resource: "/a",
      allowedModels: ["mpp-charge", "mpp-channel"],
    });
    expect(decision).toEqual({ model: "mpp-charge", reason: "default" });
  });
});
