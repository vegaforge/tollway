import { Ed25519Signer, type PaymentOffer } from "@vegaforge/tollway-core";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import { createMockFacilitator, type FacilitatorClient } from "./facilitator.js";
import { paymentTargets } from "./facilitator-capabilities.js";
import { createPaywall, type GateOutcome, type PaywallConfig } from "./gate.js";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "./headers.js";

/**
 * Issue #158: one route, several payment options. The challenge lists them
 * in preference order; a paid request is matched against the configured list
 * exactly, and everything after the match uses the matched option.
 */

const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const USDC_MAINNET = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const PAYEE = "GCKFBEIYTKP5RDBQMUTAPDCAIVMOLKZYNYKRJHAEWHJDYUGSA3FDQQ3V";

const request = { method: "GET", url: "/quotes/latest", headers: {} };

let signer: Ed25519Signer;
beforeAll(async () => {
  signer = await Ed25519Signer.generate("payment-options");
});

function spied(name: string) {
  const inner = createMockFacilitator();
  const verify = vi.fn(inner.verify.bind(inner));
  const settle = vi.fn(inner.settle.bind(inner));
  const client: FacilitatorClient = { ...inner, verify, settle };
  return { name, client, verify, settle };
}

function twoOptionGate(extra: Partial<Parameters<typeof createPaywall>[1]> = {}) {
  const mainnet = spied("mainnet");
  const testnet = spied("testnet");
  const config: PaywallConfig = {
    accepts: [
      {
        amount: "10000",
        asset: USDC_MAINNET,
        payTo: PAYEE,
        network: "mainnet",
        facilitator: mainnet.client,
      },
      {
        amount: "20000",
        asset: USDC_TESTNET,
        payTo: PAYEE,
        network: "testnet",
        facilitator: testnet.client,
      },
    ],
  };
  const gate = createPaywall(config, { signer, cache: createInMemorySettlementCache(), ...extra });
  return { gate, mainnet, testnet };
}

function challengeOf(outcome: GateOutcome): PaymentRequirements[] {
  if (outcome.kind !== "payment-required") throw new Error("expected a 402");
  return decodePaymentRequiredHeader(outcome.headers[PAYMENT_REQUIRED_HEADER] ?? "").accepts;
}

function paying(accepted: PaymentRequirements, transaction = "mock-envelope") {
  return {
    ...request,
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
        x402Version: 2,
        accepted,
        payload: { transaction },
      }),
    },
  };
}

describe("single-option routes", () => {
  it("produce byte-identical challenges to before #158", async () => {
    const facilitator = createMockFacilitator();
    const plain = createPaywall(
      { amount: "10000", asset: USDC_TESTNET, payTo: PAYEE, network: "testnet" },
      { signer, facilitator },
    );
    const tuned = createPaywall(
      {
        amount: "250",
        asset: USDC_TESTNET,
        payTo: PAYEE,
        network: "mainnet",
        maxTimeoutSeconds: 30,
        extra: { areFeesSponsored: true },
        resource: "/fixed",
      },
      { signer, facilitator },
    );
    const header = async (gate: typeof plain) => {
      const outcome = await gate(request);
      if (outcome.kind !== "payment-required") throw new Error("expected a 402");
      return outcome.headers[PAYMENT_REQUIRED_HEADER];
    };
    expect(await header(plain)).toBe(
      "eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnsidXJsIjoiL3F1b3Rlcy9sYXRlc3QifSwiYWNjZXB0cyI6W3sic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoic3RlbGxhcjp0ZXN0bmV0IiwiYXNzZXQiOiJDQklFTFRLNllCWkpVNVVQMldXUUVVQ1lLTFBVNkFVTloyQlE0V1dGRUlFM1VTQ0lITVhRREFNQSIsImFtb3VudCI6IjEwMDAwIiwicGF5VG8iOiJHQ0tGQkVJWVRLUDVSREJRTVVUQVBEQ0FJVk1PTEtaWU5ZS1JKSEFFV0hKRFlVR1NBM0ZEUVEzViIsIm1heFRpbWVvdXRTZWNvbmRzIjo2MCwiZXh0cmEiOnt9fV19",
    );
    expect(await header(tuned)).toBe(
      "eyJ4NDAyVmVyc2lvbiI6MiwicmVzb3VyY2UiOnsidXJsIjoiL2ZpeGVkIn0sImFjY2VwdHMiOlt7InNjaGVtZSI6ImV4YWN0IiwibmV0d29yayI6InN0ZWxsYXI6cHVibmV0IiwiYXNzZXQiOiJDQklFTFRLNllCWkpVNVVQMldXUUVVQ1lLTFBVNkFVTloyQlE0V1dGRUlFM1VTQ0lITVhRREFNQSIsImFtb3VudCI6IjI1MCIsInBheVRvIjoiR0NLRkJFSVlUS1A1UkRCUU1VVEFQRENBSVZNT0xLWllOWUtSSkhBRVdISkRZVUdTQTNGRFFRM1YiLCJtYXhUaW1lb3V0U2Vjb25kcyI6MzAsImV4dHJhIjp7ImFyZUZlZXNTcG9uc29yZWQiOnRydWV9fV19",
    );
  });

  it("are the same as a one-item accepts list", async () => {
    const facilitator = createMockFacilitator();
    const option = {
      amount: "10000",
      asset: USDC_TESTNET,
      payTo: PAYEE,
      network: "testnet",
    } as const;
    const single = await createPaywall(option, { signer, facilitator })(request);
    const listed = await createPaywall({ accepts: [option] }, { signer, facilitator })(request);
    expect(listed).toEqual(single);
  });
});

describe("several payment options", () => {
  it("lists every option in the configured preference order", async () => {
    const { gate } = twoOptionGate();
    expect(challengeOf(await gate(request))).toEqual([
      expect.objectContaining({ network: "stellar:pubnet", asset: USDC_MAINNET, amount: "10000" }),
      expect.objectContaining({ network: "stellar:testnet", asset: USDC_TESTNET, amount: "20000" }),
    ]);
  });

  it("settles option 2 with option 2's facilitator and receipts option 2's terms", async () => {
    const { gate, mainnet, testnet } = twoOptionGate();
    const [, second] = challengeOf(await gate(request));
    if (!second) throw new Error("expected two options");
    const outcome = await gate(paying(second));
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.receipt.receipt).toMatchObject({
      network: "testnet",
      asset: USDC_TESTNET,
      amount: "20000",
      payee: PAYEE,
    });
    expect(testnet.verify).toHaveBeenCalledTimes(1);
    expect(testnet.settle).toHaveBeenCalledTimes(1);
    expect(testnet.settle.mock.calls[0]?.[0].offer).toMatchObject({
      network: "testnet",
      amount: "20000",
    });
    expect(mainnet.verify).not.toHaveBeenCalled();
    expect(mainnet.settle).not.toHaveBeenCalled();
  });

  it("refuses an accepted that matches no option with a 402 and a fresh challenge", async () => {
    const { gate, mainnet, testnet } = twoOptionGate();
    const [first] = challengeOf(await gate(request));
    if (!first) throw new Error("expected an option");
    const outcome = await gate(paying({ ...first, payTo: "GOTHERPAYEE" }));
    expect(outcome).toMatchObject({ kind: "rejected", status: 402, code: "payment-invalid" });
    if (outcome.kind !== "rejected") return;
    expect(
      decodePaymentRequiredHeader(outcome.headers?.[PAYMENT_REQUIRED_HEADER] ?? "").accepts,
    ).toHaveLength(2);
    expect(mainnet.verify).not.toHaveBeenCalled();
    expect(testnet.verify).not.toHaveBeenCalled();
  });

  it.each([
    ["a smaller amount", { amount: "1" }],
    ["another asset", { asset: USDC_TESTNET }],
    ["another network", { network: "stellar:testnet" }],
    ["a longer timeout", { maxTimeoutSeconds: 3_600 }],
    ["another scheme", { scheme: "upto" }],
  ])("refuses a listed option altered to %s", async (_name, change) => {
    const { gate, mainnet, testnet } = twoOptionGate();
    const [first] = challengeOf(await gate(request));
    if (!first) throw new Error("expected an option");
    expect(await gate(paying({ ...first, ...change } as PaymentRequirements))).toMatchObject({
      status: 402,
      code: "payment-invalid",
    });
    expect(mainnet.settle).not.toHaveBeenCalled();
    expect(testnet.settle).not.toHaveBeenCalled();
  });

  it("ignores client-only fields when matching", async () => {
    const { gate } = twoOptionGate();
    const [first] = challengeOf(await gate(request));
    if (!first) throw new Error("expected an option");
    const outcome = await gate(paying({ ...first, extra: { clientNote: "hi" } }));
    expect(outcome.kind).toBe("settled");
  });

  it("never lets a payment for option 1 satisfy option 2, or another route", async () => {
    const { gate, mainnet, testnet } = twoOptionGate();
    const [first, second] = challengeOf(await gate(request));
    if (!first || !second) throw new Error("expected two options");
    expect((await gate(paying(first, "envelope-A"))).kind).toBe("settled");
    // The same signed payment, now claiming option 2.
    expect(await gate(paying(second, "envelope-A"))).toMatchObject({
      status: 409,
      code: "offer-mismatch",
    });
    expect(mainnet.settle).toHaveBeenCalledTimes(1);
    expect(testnet.settle).not.toHaveBeenCalled();
  });

  it("hands the router and the service policy the chosen option", async () => {
    const seen: PaymentOffer[] = [];
    const { gate } = twoOptionGate({
      router: {
        async decide({ offer }) {
          if (offer) seen.push(offer);
          return { model: "x402", reason: "offer" };
        },
      },
      // A spend cap that fits option 1's price but not option 2's: service
      // policy sees the matched option, so it can restrict options per payer.
      servicePolicy: { spendPerWindow: { limit: "15000" } },
    });
    const [first, second] = challengeOf(await gate(request));
    if (!first || !second) throw new Error("expected two options");
    expect((await gate(paying(first, "envelope-B"))).kind).toBe("settled");
    expect(await gate(paying(second, "envelope-C"))).toMatchObject({
      code: "service-policy:spend-exceeded",
    });
    expect(seen.map((offer) => offer.network)).toEqual(["mainnet", "testnet"]);
  });

  it("refuses at createPaywall an option with no facilitator", () => {
    expect(() =>
      createPaywall(
        {
          accepts: [
            {
              amount: "1",
              asset: USDC_MAINNET,
              payTo: PAYEE,
              network: "mainnet",
              facilitator: createMockFacilitator(),
            },
            { amount: "2", asset: USDC_TESTNET, payTo: PAYEE, network: "testnet" },
          ],
        },
        { signer },
      ),
    ).toThrow(/option 2 .*no facilitator/);
  });

  it("refuses at createPaywall an empty option list or an invalid amount", () => {
    const facilitator = createMockFacilitator();
    expect(() => createPaywall({ accepts: [] }, { signer, facilitator })).toThrow(/at least one/);
    expect(() =>
      createPaywall(
        { accepts: [{ amount: "1.5", asset: USDC_TESTNET, payTo: PAYEE, network: "testnet" }] },
        { signer, facilitator },
      ),
    ).toThrow(/amount/);
  });

  it("falls back to the gate's facilitator for an option without its own", async () => {
    const shared = spied("shared");
    const gate = createPaywall(
      {
        accepts: [
          { amount: "1", asset: USDC_MAINNET, payTo: PAYEE, network: "mainnet" },
          { amount: "2", asset: USDC_TESTNET, payTo: PAYEE, network: "testnet" },
        ],
      },
      { signer, facilitator: shared.client },
    );
    const [, second] = challengeOf(await gate(request));
    if (!second) throw new Error("expected two options");
    expect((await gate(paying(second))).kind).toBe("settled");
    expect(shared.settle).toHaveBeenCalledTimes(1);
  });

  it("gives #155's capability check one target per option", () => {
    expect(
      paymentTargets({
        accepts: [
          { amount: "1", asset: USDC_MAINNET, payTo: PAYEE, network: "mainnet", extra: { a: 1 } },
          { amount: "2", asset: USDC_TESTNET, payTo: PAYEE, network: "testnet" },
        ],
        models: ["x402"],
      }),
    ).toEqual([
      { asset: USDC_MAINNET, payTo: PAYEE, network: "mainnet", models: ["x402"], extra: { a: 1 } },
      { asset: USDC_TESTNET, payTo: PAYEE, network: "testnet", models: ["x402"] },
    ]);
  });
});
