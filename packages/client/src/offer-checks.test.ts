/**
 * Unit tests for offer-checks.ts.
 *
 * One test per check, both pass and fail. The tests also verify that a
 * rejected offer never reaches the settler or policy engine by driving
 * createClient().pay() with mock settlers and policy engines.
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
import { type ClientSettler, createClient } from "./index.js";
import { OfferRejectedError, runOfferChecks } from "./offer-checks.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RESOURCE = "https://api.example.com/data";
const PAYEE = "GCPAYEEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
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

let receipt: SignedReceipt;
let _mockSettler: ClientSettler;

beforeAll(async () => {
  const signer = await Ed25519Signer.generate("key");
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
  _mockSettler = { settle: vi.fn().mockResolvedValue(receipt) };
});

// ---------------------------------------------------------------------------
// runOfferChecks – structural
// ---------------------------------------------------------------------------

describe("structural check", () => {
  it("passes a well-formed offer", () => {
    expect(() => runOfferChecks(BASE_OFFER, RESOURCE, "testnet")).not.toThrow();
  });

  it("rejects an offer with an empty payTo", () => {
    expect(() => runOfferChecks({ ...BASE_OFFER, payTo: "" }, RESOURCE, "testnet")).toThrow(
      OfferRejectedError,
    );
  });

  it("rejects an offer with a whitespace-only payTo", () => {
    expect(() => runOfferChecks({ ...BASE_OFFER, payTo: "  " }, RESOURCE, "testnet")).toThrow(
      OfferRejectedError,
    );
  });

  it("rejects an offer with an empty asset", () => {
    expect(() => runOfferChecks({ ...BASE_OFFER, asset: "" }, RESOURCE, "testnet")).toThrow(
      OfferRejectedError,
    );
  });

  it("rejects an offer with no models", () => {
    expect(() => runOfferChecks({ ...BASE_OFFER, models: [] }, RESOURCE, "testnet")).toThrow(
      OfferRejectedError,
    );
  });

  it("rejects a non-integer amount string", () => {
    const err = (() => {
      try {
        runOfferChecks({ ...BASE_OFFER, amount: "12.5" }, RESOURCE, "testnet");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OfferRejectedError);
    expect((err as OfferRejectedError).checkName).toBe("structural");
  });

  it("rejects a negative amount string", () => {
    expect(() => runOfferChecks({ ...BASE_OFFER, amount: "-1" }, RESOURCE, "testnet")).toThrow(
      OfferRejectedError,
    );
  });

  it("rejects a zero amount", () => {
    const err = (() => {
      try {
        runOfferChecks({ ...BASE_OFFER, amount: "0" }, RESOURCE, "testnet");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OfferRejectedError);
    expect((err as OfferRejectedError).checkName).toBe("structural");
    expect((err as OfferRejectedError).message).toContain("zero");
  });

  it("rejects when offer.resource differs from request resource", () => {
    const err = (() => {
      try {
        runOfferChecks(
          { ...BASE_OFFER, resource: "https://other.example.com/x" },
          RESOURCE,
          "testnet",
        );
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OfferRejectedError);
    expect((err as OfferRejectedError).checkName).toBe("structural");
  });

  it("passes when offer.resource matches request resource", () => {
    expect(() => runOfferChecks(BASE_OFFER, RESOURCE, "testnet")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runOfferChecks – network (including requireNetwork override)
// ---------------------------------------------------------------------------

describe("network check", () => {
  it("passes when offer.network matches client network", () => {
    expect(() => runOfferChecks(BASE_OFFER, RESOURCE, "testnet")).not.toThrow();
  });

  it("rejects when offer is for mainnet but client is testnet", () => {
    const err = (() => {
      try {
        runOfferChecks({ ...BASE_OFFER, network: "mainnet" }, RESOURCE, "testnet");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OfferRejectedError);
    expect((err as OfferRejectedError).checkName).toBe("network");
    expect((err as OfferRejectedError).message).toContain("mainnet");
    expect((err as OfferRejectedError).message).toContain("testnet");
  });

  it("rejects when offer is for testnet but client is mainnet", () => {
    expect(() =>
      runOfferChecks({ ...BASE_OFFER, network: "testnet" }, RESOURCE, "mainnet"),
    ).toThrow(OfferRejectedError);
  });

  it("network check applies even with no offerChecks configured", () => {
    // No checks argument — only structural + network run.
    expect(() =>
      runOfferChecks({ ...BASE_OFFER, network: "mainnet" }, RESOURCE, "testnet"),
    ).toThrow(OfferRejectedError);
  });

  it("requireNetwork in offerChecks overrides the client-level network", () => {
    // Client is testnet, offer is mainnet, but requireNetwork forces mainnet — should pass.
    expect(() =>
      runOfferChecks({ ...BASE_OFFER, network: "mainnet" }, RESOURCE, "testnet", {
        requireNetwork: "mainnet",
      }),
    ).not.toThrow();
  });

  it("requireNetwork rejects when offer does not match the override", () => {
    // Client is testnet, requireNetwork forces mainnet, offer is testnet — should fail.
    const err = (() => {
      try {
        runOfferChecks({ ...BASE_OFFER, network: "testnet" }, RESOURCE, "testnet", {
          requireNetwork: "mainnet",
        });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OfferRejectedError);
    expect((err as OfferRejectedError).checkName).toBe("network");
  });
});

// ---------------------------------------------------------------------------
// runOfferChecks – allowedAssets
// ---------------------------------------------------------------------------

describe("allowedAssets check", () => {
  it("passes when asset is in the allowlist", () => {
    expect(() =>
      runOfferChecks(BASE_OFFER, RESOURCE, "testnet", { allowedAssets: [USDC] }),
    ).not.toThrow();
  });

  it("rejects when asset is not in the allowlist", () => {
    const err = (() => {
      try {
        runOfferChecks(BASE_OFFER, RESOURCE, "testnet", { allowedAssets: [XLM] });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OfferRejectedError);
    expect((err as OfferRejectedError).checkName).toBe("allowedAssets");
  });

  it("does not apply when allowedAssets is not configured", () => {
    expect(() =>
      runOfferChecks({ ...BASE_OFFER, asset: XLM }, RESOURCE, "testnet", {}),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runOfferChecks – maxAmount
// ---------------------------------------------------------------------------

describe("maxAmount check", () => {
  it("passes when amount is within the ceiling", () => {
    expect(() =>
      runOfferChecks(BASE_OFFER, RESOURCE, "testnet", { maxAmount: { [USDC]: "10000" } }),
    ).not.toThrow();
  });

  it("rejects when amount exceeds the ceiling", () => {
    const err = (() => {
      try {
        runOfferChecks(BASE_OFFER, RESOURCE, "testnet", { maxAmount: { [USDC]: "9999" } });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OfferRejectedError);
    expect((err as OfferRejectedError).checkName).toBe("maxAmount");
    expect((err as OfferRejectedError).message).toContain("10000");
    expect((err as OfferRejectedError).message).toContain("9999");
  });

  it("passes when amount equals the ceiling exactly", () => {
    expect(() =>
      runOfferChecks(BASE_OFFER, RESOURCE, "testnet", { maxAmount: { [USDC]: "10000" } }),
    ).not.toThrow();
  });

  it("rejects (fail-closed) when asset has no entry in maxAmount", () => {
    const err = (() => {
      try {
        // maxAmount is configured but has no entry for USDC
        runOfferChecks(BASE_OFFER, RESOURCE, "testnet", { maxAmount: { [XLM]: "50000" } });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OfferRejectedError);
    expect((err as OfferRejectedError).checkName).toBe("maxAmount");
    expect((err as OfferRejectedError).message).toContain("fail-closed");
  });

  it("does not apply when maxAmount is not configured", () => {
    expect(() =>
      runOfferChecks({ ...BASE_OFFER, amount: "999999999" }, RESOURCE, "testnet", {}),
    ).not.toThrow();
  });

  it("compares amounts as bigint (handles amounts beyond Number.MAX_SAFE_INTEGER)", () => {
    const huge = "90000000000000000000";
    const ceiling = "100000000000000000000";
    expect(() =>
      runOfferChecks({ ...BASE_OFFER, amount: huge }, RESOURCE, "testnet", {
        maxAmount: { [USDC]: ceiling },
      }),
    ).not.toThrow();

    expect(() =>
      runOfferChecks({ ...BASE_OFFER, amount: ceiling }, RESOURCE, "testnet", {
        maxAmount: { [USDC]: huge },
      }),
    ).toThrow(OfferRejectedError);
  });
});

// ---------------------------------------------------------------------------
// runOfferChecks – allowedPayees
// ---------------------------------------------------------------------------

describe("allowedPayees check", () => {
  it("passes when payee is in the allowlist", () => {
    expect(() =>
      runOfferChecks(BASE_OFFER, RESOURCE, "testnet", { allowedPayees: [PAYEE] }),
    ).not.toThrow();
  });

  it("rejects when payee is not in the allowlist", () => {
    const other = "GOTHER0000000000000000000000000000000000000000000000000000";
    const err = (() => {
      try {
        runOfferChecks(BASE_OFFER, RESOURCE, "testnet", { allowedPayees: [other] });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(OfferRejectedError);
    expect((err as OfferRejectedError).checkName).toBe("allowedPayees");
  });

  it("uses exact string match, not prefix or substring", () => {
    // A prefix of PAYEE must not pass.
    expect(() =>
      runOfferChecks(BASE_OFFER, RESOURCE, "testnet", { allowedPayees: [PAYEE.slice(0, 10)] }),
    ).toThrow(OfferRejectedError);
  });

  it("does not apply when allowedPayees is not configured", () => {
    expect(() => runOfferChecks(BASE_OFFER, RESOURCE, "testnet", {})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// OfferRejectedError is a TollwayError with code "offer-rejected"
// ---------------------------------------------------------------------------

describe("OfferRejectedError", () => {
  it("is a TollwayError with code offer-rejected", () => {
    const err = new OfferRejectedError("network", "detail");
    expect(err).toBeInstanceOf(TollwayError);
    expect(err.code).toBe("offer-rejected");
    expect(err.checkName).toBe("network");
    expect(err.name).toBe("OfferRejectedError");
  });
});

// ---------------------------------------------------------------------------
// Integration: rejected offer never reaches settler or policy engine
// ---------------------------------------------------------------------------

describe("createClient: rejected offer never reaches settler or policy", () => {
  it("does not call the settler when network check fails", async () => {
    const settler = { settle: vi.fn() };
    const client = createClient({ network: "testnet", settler });

    await expect(
      client.pay({
        resource: RESOURCE,
        offer: { ...BASE_OFFER, network: "mainnet" },
      }),
    ).rejects.toBeInstanceOf(OfferRejectedError);

    expect(settler.settle).not.toHaveBeenCalled();
  });

  it("does not call the settler when maxAmount check fails", async () => {
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

  it("does not reach the policy engine when offer check fails", async () => {
    const policyEvaluate = vi.fn();
    const policy = createPolicyEngine({});
    // Spy on evaluate to verify it was not called.
    const spy = vi.spyOn(policy, "evaluate").mockImplementation(policyEvaluate);

    const settler = { settle: vi.fn() };
    const client = createClient({
      network: "testnet",
      settler,
      policy,
      offerChecks: {
        allowedPayees: ["GDIFFERENT000000000000000000000000000000000000000000000000"],
      },
    });

    await expect(client.pay({ resource: RESOURCE, offer: BASE_OFFER })).rejects.toBeInstanceOf(
      OfferRejectedError,
    );

    expect(spy).not.toHaveBeenCalled();
    expect(settler.settle).not.toHaveBeenCalled();
  });

  it("emits a skip event when the offer is rejected", async () => {
    const settler = { settle: vi.fn() };
    const client = createClient({
      network: "testnet",
      settler,
      offerChecks: { allowedAssets: [XLM] },
    });

    const events: Array<{ type: string }> = [];
    client.on((e) => events.push(e));

    await expect(client.pay({ resource: RESOURCE, offer: BASE_OFFER })).rejects.toBeInstanceOf(
      OfferRejectedError,
    );

    expect(events.some((e) => e.type === "skip")).toBe(true);
  });

  it("proceeds normally when all checks pass", async () => {
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

// ---------------------------------------------------------------------------
// x402-settler: PaymentPolicy filters disallowed options
// ---------------------------------------------------------------------------

describe("createX402Settler: PaymentPolicy filters multi-option challenges", () => {
  it("signs only the allowed-payee option when the challenge lists two options", async () => {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const { createEd25519Signer } = await import("@x402/stellar");
    const { encodePaymentRequiredHeader } = await import("@x402/core/http");
    const { createX402Settler, PAYMENT_REQUIRED_HEADER, TOLLWAY_RECEIPT_HEADER } = await import(
      "./x402-settler.js"
    );

    const agent = Keypair.random();
    const allowedPayee = Keypair.random().publicKey();
    const disallowedPayee = Keypair.random().publicKey();

    const baseReq = {
      scheme: "exact" as const,
      network: "stellar:testnet" as const,
      asset: USDC,
      amount: "10000",
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
    };

    // Two options: disallowed payee first, allowed payee second.
    const paymentRequired = {
      x402Version: 2,
      resource: { url: RESOURCE },
      accepts: [
        { ...baseReq, payTo: disallowedPayee },
        { ...baseReq, payTo: allowedPayee },
      ],
    };

    const signer2 = await Ed25519Signer.generate("key2");
    const allowedReceipt = await signReceipt(
      buildReceipt({
        payer: agent.publicKey(),
        payee: allowedPayee,
        amount: "10000",
        asset: USDC,
        resource: RESOURCE,
        model: "x402",
        settlement: { kind: "transaction", txHash: "b".repeat(64) },
        network: "testnet",
      }),
      signer2,
    );

    let calledWithPayTo: string | null = null;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (!headers?.[PAYMENT_REQUIRED_HEADER]) {
        return new Response(null, {
          status: 402,
          headers: {
            [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(paymentRequired),
          },
        });
      }
      // Parse what the settler actually signed.
      const { decodePaymentSignatureHeader } = await import("@x402/core/http");
      const decoded = decodePaymentSignatureHeader(
        headers[PAYMENT_REQUIRED_HEADER.toLowerCase()] ?? headers["PAYMENT-SIGNATURE"] ?? "",
      );
      calledWithPayTo = decoded.accepted?.payTo ?? null;
      return new Response("ok", {
        status: 200,
        headers: {
          [TOLLWAY_RECEIPT_HEADER]: Buffer.from(JSON.stringify(allowedReceipt)).toString("base64"),
        },
      });
    }) as unknown as typeof globalThis.fetch;

    const settler = createX402Settler({
      signer: createEd25519Signer(agent.secret(), "stellar:testnet"),
      network: "testnet",
      fetch: fetcher,
      offerChecks: { allowedPayees: [allowedPayee] },
    });

    await settler.settle({
      resource: RESOURCE,
      offer: { ...BASE_OFFER, payTo: allowedPayee },
      model: "x402",
    });

    // The settler must have signed the allowed option, not the disallowed one.
    expect(calledWithPayTo).toBe(allowedPayee);
  });
});
