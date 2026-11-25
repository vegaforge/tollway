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

  it("keeps ignoring traffic when no threshold is configured", async () => {
    const decision = await router.decide({
      counterparty: "GSERVICE",
      resource: "/a",
      offer: { ...offer, models: ["x402", "mpp-channel"] },
      allowedModels: ["x402", "mpp-channel"],
      traffic: { requestsPerMinute: 10_000, windowSeconds: 3600 },
    });
    expect(decision).toEqual({ model: "x402", reason: "offer" });
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

describe("createDefaultRouter traffic promotion", () => {
  const channelThreshold = { requestsPerMinute: 100, minWindowSeconds: 300 };
  const trafficRouter = createDefaultRouter({ channelThreshold });
  const channelOffer = {
    ...offer,
    models: ["mpp-charge", "x402", "mpp-channel"],
  } satisfies PaymentOffer;
  const busyTraffic = { requestsPerMinute: 120, windowSeconds: 300 };

  const scenarios: readonly {
    name: string;
    input: Parameters<ReturnType<typeof createDefaultRouter>["decide"]>[0];
    expected: { model: string; reason: string };
  }[] = [
    {
      name: "promotes a busy counterparty whose offer accepts channels",
      input: {
        counterparty: "GSERVICE",
        resource: "/a",
        offer: channelOffer,
        traffic: busyTraffic,
      },
      expected: { model: "mpp-channel", reason: "traffic" },
    },
    {
      name: "promotes a busy counterparty when policy allows channels",
      input: {
        counterparty: "GSERVICE",
        resource: "/a",
        allowedModels: ["x402", "mpp-channel"],
        traffic: busyTraffic,
      },
      expected: { model: "mpp-channel", reason: "traffic" },
    },
    {
      name: "does not promote below the request-rate threshold",
      input: {
        counterparty: "GSERVICE",
        resource: "/a",
        offer: channelOffer,
        traffic: { requestsPerMinute: 99, windowSeconds: 300 },
      },
      expected: { model: "x402", reason: "offer" },
    },
    {
      name: "does not promote over a window shorter than the minimum",
      input: {
        counterparty: "GSERVICE",
        resource: "/a",
        offer: channelOffer,
        traffic: { requestsPerMinute: 500, windowSeconds: 299 },
      },
      expected: { model: "x402", reason: "offer" },
    },
    {
      name: "does not promote when the offer excludes channels",
      input: {
        counterparty: "GSERVICE",
        resource: "/a",
        offer: { ...offer, models: ["x402"] },
        traffic: busyTraffic,
      },
      expected: { model: "x402", reason: "offer" },
    },
    {
      name: "does not promote when policy excludes channels",
      input: {
        counterparty: "GSERVICE",
        resource: "/a",
        offer: channelOffer,
        allowedModels: ["x402"],
        traffic: busyTraffic,
      },
      expected: { model: "x402", reason: "offer" },
    },
    {
      name: "does not promote a quarantined counterparty",
      input: {
        counterparty: "GSERVICE",
        resource: "/a",
        offer: channelOffer,
        traffic: busyTraffic,
        quarantined: true,
      },
      expected: { model: "x402", reason: "quarantined" },
    },
    {
      name: "keeps an explicit override ahead of traffic promotion",
      input: {
        counterparty: "GSERVICE",
        resource: "/a",
        offer: channelOffer,
        traffic: busyTraffic,
        override: "mpp-charge",
      },
      expected: { model: "mpp-charge", reason: "override" },
    },
  ];

  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await expect(trafficRouter.decide(scenario.input)).resolves.toEqual(scenario.expected);
    });
  }

  it.each([
    ["requestsPerMinute", 0],
    ["requestsPerMinute", -1],
    ["requestsPerMinute", 1.5],
    ["requestsPerMinute", Number.NaN],
    ["requestsPerMinute", Number.POSITIVE_INFINITY],
    ["minWindowSeconds", 0],
    ["minWindowSeconds", -1],
    ["minWindowSeconds", 1.5],
    ["minWindowSeconds", Number.NaN],
    ["minWindowSeconds", Number.POSITIVE_INFINITY],
  ] as const)("rejects an invalid channelThreshold %s=%s", (field, value) => {
    expect(() =>
      createDefaultRouter({
        channelThreshold: { requestsPerMinute: 100, minWindowSeconds: 300, [field]: value },
      }),
    ).toThrowError(TollwayError);
  });
});
