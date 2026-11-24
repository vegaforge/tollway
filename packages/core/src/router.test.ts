import { describe, expect, it } from "vitest";
import { TollwayError } from "./errors.js";
import { type CounterpartyQuarantine, createMemoryQuarantine } from "./quarantine.js";
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

  it("excludes mpp-channel when RouteInput.quarantined is true", async () => {
    const decision = await router.decide({
      counterparty: "GSERVICE",
      resource: "/a",
      offer: { ...offer, models: ["mpp-channel", "x402"] },
      allowedModels: ["mpp-channel", "x402"],
      quarantined: true,
    });
    expect(decision).toEqual({ model: "x402", reason: "quarantined" });
  });

  it("never routes a quarantined counterparty to mpp-channel even when offer only offers mpp-channel", async () => {
    const quarantine = createMemoryQuarantine();
    await quarantine.quarantine({
      counterparty: "GSERVICE",
      reason: "under-settled",
      drift: { kind: "under-settled", detail: "shortfall" },
    });
    const qRouter = createDefaultRouter({ quarantine });

    await expect(
      qRouter.decide({
        counterparty: "GSERVICE",
        resource: "/a",
        offer: { ...offer, models: ["mpp-channel"] },
      }),
    ).rejects.toThrow(TollwayError);

    await expect(
      qRouter.decide({
        counterparty: "GSERVICE",
        resource: "/a",
        override: "mpp-channel",
      }),
    ).rejects.toMatchObject({ code: "counterparty-quarantined" });
  });

  it("restores mpp-channel eligibility after explicit release", async () => {
    const quarantine = createMemoryQuarantine();
    await quarantine.quarantine({
      counterparty: "GSERVICE",
      reason: "under-settled",
      drift: { kind: "under-settled", detail: "shortfall" },
    });
    const qRouter = createDefaultRouter({ quarantine });

    const whileQuarantined = await qRouter.decide({
      counterparty: "GSERVICE",
      resource: "/a",
      offer: { ...offer, models: ["mpp-channel", "mpp-charge"] },
    });
    expect(whileQuarantined).toEqual({ model: "mpp-charge", reason: "quarantined" });

    await quarantine.release({ counterparty: "GSERVICE", releasedBy: "operator" });

    const afterRelease = await qRouter.decide({
      counterparty: "GSERVICE",
      resource: "/a",
      offer: { ...offer, models: ["mpp-channel"] },
    });
    expect(afterRelease).toEqual({ model: "mpp-channel", reason: "offer" });
  });

  it("fails closed when quarantine lookup throws", async () => {
    const failingQuarantine: CounterpartyQuarantine = {
      async quarantine() {
        throw new Error("unreachable");
      },
      async release() {
        throw new Error("unreachable");
      },
      async lookup() {
        throw new Error("store unavailable");
      },
      async history() {
        return [];
      },
    };
    const qRouter = createDefaultRouter({ quarantine: failingQuarantine });

    const decision = await qRouter.decide({
      counterparty: "GSERVICE",
      resource: "/a",
      offer: { ...offer, models: ["mpp-channel", "x402"] },
    });
    expect(decision).toEqual({ model: "x402", reason: "quarantined" });

    await expect(
      qRouter.decide({
        counterparty: "GSERVICE",
        resource: "/a",
        offer: { ...offer, models: ["mpp-channel"] },
      }),
    ).rejects.toThrow(TollwayError);
  });
});
