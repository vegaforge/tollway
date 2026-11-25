import type * as ChargeClient from "@stellar/mpp/charge/client";
import { Keypair } from "@stellar/stellar-sdk";
import {
  buildReceipt,
  createDefaultRouter,
  createPolicyEngine,
  Ed25519Signer,
  Ed25519Verifier,
  type ModelRouter,
  type SettlementModel,
  type SignedReceipt,
  signReceipt,
  TollwayError,
} from "@vegaforge/tollway-core";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { Challenge, Credential } from "mppx";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ClientEvent,
  type ClientSettler,
  createClient,
  PolicyBlockedError,
  ReceiptVerificationError,
  type TollwayClientOptions,
} from "./index.js";
import { createMppChargeSettler } from "./mpp-charge-settler.js";
import { createPaidFetch } from "./paid-fetch.js";
import { TOLLWAY_RECEIPT_HEADER } from "./receipt-header.js";
import { createKeypairSigner, createSmartAccountSigner, signerModels } from "./signer.js";
import {
  createX402Settler,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "./x402-settler.js";

// Both schemes are stubbed only where they would reach Soroban RPC; the
// stubs still sign with the signer they are given. Challenge parsing, header
// encoding, credential format and selection are the real libraries.
vi.mock("@x402/stellar/exact/client", async () => {
  const { USDC_PUBNET_ADDRESS, USDC_TESTNET_ADDRESS } =
    await vi.importActual<typeof import("@x402/stellar")>("@x402/stellar");
  const defaults: Record<string, string> = {
    "stellar:pubnet": USDC_PUBNET_ADDRESS,
    "stellar:testnet": USDC_TESTNET_ADDRESS,
  };
  return {
    ExactStellarScheme: class {
      readonly scheme = "exact";
      readonly findDefaultAsset = (asset: string, network: string) =>
        defaults[network] === asset ? { asset, decimals: 7, symbol: "USDC" } : undefined;
      constructor(
        readonly signer: { signAuthEntry: (entry: string) => Promise<{ signedAuthEntry: string }> },
      ) {}
      async createPaymentPayload(x402Version: number, requirements: PaymentRequirements) {
        const { signedAuthEntry } = await this.signer.signAuthEntry(
          Buffer.from(`auth-entry:${requirements.payTo}:${requirements.amount}`).toString("base64"),
        );
        return { x402Version, payload: { transaction: `signed-tx:${signedAuthEntry}` } };
      }
    },
  };
});

vi.mock("@stellar/mpp/charge/client", async () => {
  const actual = await vi.importActual<typeof ChargeClient>("@stellar/mpp/charge/client");
  type ChargeParameters = Parameters<typeof actual.stellar.charge>[0];
  type CreateCredentialInput = Parameters<
    ReturnType<typeof actual.stellar.charge>["createCredential"]
  >[0];
  const wrapped = (parameters: ChargeParameters) => {
    const method = actual.stellar.charge(parameters);
    return {
      ...method,
      createCredential: async (input: CreateCredentialInput) =>
        Credential.serialize({
          challenge: input.challenge,
          payload: { type: "transaction", transaction: "signed-xdr" },
          source: "did:pkh:stellar:testnet:GAGENT",
        }),
    };
  };
  return { ...actual, stellar: Object.assign(wrapped, { charge: wrapped }) };
});

const RESOURCE = "https://api.example.com/quotes/latest";
const PAYEE = Keypair.random().publicKey();
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AGENT = Keypair.random();
const signer = createKeypairSigner(AGENT, "testnet");

let serviceSigner: Ed25519Signer;
let verifier: Ed25519Verifier;
const receipts: Partial<Record<SettlementModel, SignedReceipt>> = {};

beforeAll(async () => {
  serviceSigner = await Ed25519Signer.generate("service-key");
  verifier = Ed25519Verifier.forSigner(serviceSigner);
  for (const model of ["x402", "mpp-charge"] as const) {
    receipts[model] = await signReceipt(
      buildReceipt({
        payer: AGENT.publicKey(),
        payee: PAYEE,
        amount: "10000",
        asset: USDC,
        resource: RESOURCE,
        model,
        settlement: { kind: "transaction", txHash: "a".repeat(64) },
        network: "testnet",
      }),
      serviceSigner,
    );
  }
});

const exact: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: USDC,
  amount: "10000",
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
  extra: {},
};

function x402Header(accepts: PaymentRequirements[] = [exact]): string {
  return encodePaymentRequiredHeader({ x402Version: 2, resource: { url: RESOURCE }, accepts });
}

function mppHeader(request: Record<string, unknown> = {}, intent = "charge"): string {
  return Challenge.serialize(
    Challenge.from({
      id: `challenge-${Math.random().toString(36).slice(2)}`,
      realm: "tollway",
      method: "stellar",
      intent,
      request: {
        amount: "10000",
        currency: USDC,
        recipient: PAYEE,
        methodDetails: { network: "stellar:testnet" },
        ...request,
      },
      expires: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
}

function challenge(headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: "payment required" }), { status: 402, headers });
}

function paid(model: SettlementModel, body = "paid body"): Response {
  const receipt = receipts[model];
  return new Response(body, {
    status: 200,
    headers: { [TOLLWAY_RECEIPT_HEADER]: Buffer.from(JSON.stringify(receipt)).toString("base64") },
  });
}

type Call = { url: string; method: string; headers: Headers; body: string | undefined };

/**
 * A transport that answers from `respond` and records every request with its
 * body read back as text, so a test can compare what was actually sent.
 */
function transport(respond: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const call: Call = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body === null ? undefined : await request.text(),
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  });
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

function scripted(...responses: Response[]) {
  return transport(() => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next;
  });
}

function paidClient(
  fetch: typeof globalThis.fetch,
  extra: Partial<Omit<TollwayClientOptions, "settler" | "settlers">> = {},
  settlers?: Partial<Record<SettlementModel, ClientSettler>>,
) {
  const client = createClient({
    network: "testnet",
    settlers: settlers ?? {
      x402: createX402Settler({ signer, network: "testnet", fetch }),
      "mpp-charge": createMppChargeSettler({ signer, network: "testnet", fetch }),
    },
    supportedModels: signerModels(signer),
    verifier,
    ...extra,
  });
  const events: ClientEvent[] = [];
  client.on((event) => events.push(event));
  return { client, events, paidFetch: createPaidFetch({ client, network: "testnet", fetch }) };
}

async function rejection(promise: Promise<unknown>): Promise<TollwayError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof TollwayError)) throw new Error(`expected a TollwayError, got ${error}`);
  return error;
}

describe("createPaidFetch (#201)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a non-402 response untouched and never calls a settler", async () => {
    const original = new Response("free", { status: 200 });
    const { fetch, calls } = scripted(original);
    const settle = vi.fn();
    const settleExchange = vi.fn();
    const { paidFetch } = paidClient(fetch, {}, { x402: { settle, settleExchange } });

    const response = await paidFetch(RESOURCE);

    expect(response).toBe(original);
    expect(response.receipt).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(settle).not.toHaveBeenCalled();
    expect(settleExchange).not.toHaveBeenCalled();
  });

  it("pays an x402 challenge in exactly two requests and returns the response with the receipt", async () => {
    const { fetch, calls } = scripted(
      challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header() }),
      paid("x402", '{"price":"1.23"}'),
    );
    const { paidFetch, events } = paidClient(fetch);

    const response = await paidFetch(RESOURCE);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ price: "1.23" });
    expect(response.model).toBe("x402");
    expect(response.receipt).toEqual(receipts.x402);
    expect(calls).toHaveLength(2);
    const signature = calls[1]?.headers.get(PAYMENT_SIGNATURE_HEADER);
    expect(decodePaymentSignatureHeader(signature ?? "").x402Version).toBe(2);
    expect(events.map((event) => event.type)).toContain("payment");
  });

  it("replays a POST with the identical method, headers and body", async () => {
    const { fetch, calls } = scripted(
      challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header() }),
      paid("x402", "created"),
    );
    const { paidFetch } = paidClient(fetch);

    const response = await paidFetch(RESOURCE, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent": "a1" },
      body: JSON.stringify({ query: "XLM" }),
    });

    expect(await response.text()).toBe("created");
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
    expect(calls.map((call) => call.body)).toEqual(['{"query":"XLM"}', '{"query":"XLM"}']);
    expect(calls[1]?.headers.get("content-type")).toBe("application/json");
    expect(calls[1]?.headers.get("x-agent")).toBe("a1");
  });

  it("replays a Request object's body as well", async () => {
    const { fetch, calls } = scripted(
      challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header() }),
      paid("x402"),
    );
    const { paidFetch } = paidClient(fetch);

    await paidFetch(new Request(RESOURCE, { method: "PUT", body: "payload" }));

    expect(calls.map((call) => [call.method, call.body])).toEqual([
      ["PUT", "payload"],
      ["PUT", "payload"],
    ]);
  });

  it("answers an MPP charge challenge with an Authorization credential", async () => {
    const { fetch, calls } = scripted(
      challenge({ "WWW-Authenticate": mppHeader() }),
      paid("mpp-charge", "mpp body"),
    );
    const { paidFetch } = paidClient(fetch, { router: createDefaultRouter() });

    const response = await paidFetch(RESOURCE);

    expect(await response.text()).toBe("mpp body");
    expect(response.model).toBe("mpp-charge");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.get("Authorization")).toMatch(/^Payment /);
  });

  it("lists every advertised model on one offer and lets the router pick the settler", async () => {
    const { fetch, calls } = scripted(
      challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header(), "WWW-Authenticate": mppHeader() }),
      paid("mpp-charge"),
    );
    const decide = vi.fn<ModelRouter["decide"]>(async () => ({
      model: "mpp-charge",
      reason: "offer",
    }));
    const { paidFetch } = paidClient(fetch, { router: { decide } });

    const response = await paidFetch(RESOURCE);

    expect(decide.mock.calls[0]?.[0].offer?.models).toEqual(["x402", "mpp-charge"]);
    expect(response.model).toBe("mpp-charge");
    expect(calls[1]?.headers.get("Authorization")).toMatch(/^Payment /);
    expect(calls[1]?.headers.get(PAYMENT_SIGNATURE_HEADER)).toBeNull();
  });

  it("refuses a model the router chose but no settler is configured for, without paying", async () => {
    const { fetch, calls } = scripted(challenge({ "WWW-Authenticate": mppHeader() }));
    const { paidFetch } = paidClient(
      fetch,
      { router: createDefaultRouter() },
      { x402: createX402Settler({ signer, network: "testnet", fetch }) },
    );

    const error = await rejection(paidFetch(RESOURCE));

    expect(error.code).toBe("no-viable-model");
    expect(error.message).toContain("no settler is configured for mpp-charge");
    expect(calls).toHaveLength(1);
  });

  it("refuses a 402 whose x402 and MPP terms disagree", async () => {
    const { fetch, calls } = scripted(
      challenge({
        [PAYMENT_REQUIRED_HEADER]: x402Header(),
        "WWW-Authenticate": mppHeader({ amount: "20000" }),
      }),
    );
    const { paidFetch } = paidClient(fetch);

    const error = await rejection(paidFetch(RESOURCE));

    expect(error.message).toContain("different terms");
    expect(calls).toHaveLength(1);
  });

  it("rejects a streaming body on a 402 before any payment", async () => {
    const { fetch, calls } = scripted(challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header() }));
    const settleExchange = vi.fn();
    const { paidFetch } = paidClient(fetch, {}, { x402: { settle: vi.fn(), settleExchange } });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });

    const error = await rejection(
      paidFetch(RESOURCE, { method: "POST", body, duplex: "half" } as RequestInit),
    );

    expect(error.message).toContain("cannot be replayed");
    expect(calls).toHaveLength(1);
    expect(settleExchange).not.toHaveBeenCalled();
  });

  it("rejects a malformed PAYMENT-REQUIRED header", async () => {
    const { fetch, calls } = scripted(challenge({ [PAYMENT_REQUIRED_HEADER]: "not-base64-json" }));
    const { paidFetch } = paidClient(fetch);

    const error = await rejection(paidFetch(RESOURCE));

    expect(error.code).toBe("payment-failed");
    expect(error.message).toContain("is not valid x402");
    expect(calls).toHaveLength(1);
  });

  it("rejects an x402 challenge whose amount is not an integer string", async () => {
    const { fetch } = scripted(
      challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header([{ ...exact, amount: "0.5" }]) }),
    );
    const { paidFetch } = paidClient(fetch);

    const error = await rejection(paidFetch(RESOURCE));

    expect(error.message).toContain("not an x402 V2 challenge");
  });

  it("stops before signing when the policy blocks the payment", async () => {
    const { fetch, calls } = scripted(challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header() }));
    const { paidFetch, events } = paidClient(fetch, {
      policy: createPolicyEngine({ budgets: { daily: "5000" } }),
    });

    await expect(paidFetch(RESOURCE)).rejects.toBeInstanceOf(PolicyBlockedError);
    expect(calls).toHaveLength(1);
    expect(events.map((event) => event.type)).toContain("skip");
  });

  it("surfaces a receipt that fails verification as ReceiptVerificationError", async () => {
    const forged = { ...receipts.x402, signature: { ...receipts.x402?.signature, value: "AAAA" } };
    const { fetch } = scripted(
      challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header() }),
      new Response("body", {
        status: 200,
        headers: {
          [TOLLWAY_RECEIPT_HEADER]: Buffer.from(JSON.stringify(forged)).toString("base64"),
        },
      }),
    );
    const { paidFetch } = paidClient(fetch);

    await expect(paidFetch(RESOURCE)).rejects.toBeInstanceOf(ReceiptVerificationError);
  });

  it("surfaces a settler rejection and emits an error event", async () => {
    const { fetch } = scripted(
      challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header() }),
      new Response("forbidden", { status: 403 }),
    );
    const { paidFetch, events } = paidClient(fetch);

    const error = await rejection(paidFetch(RESOURCE));

    expect(error.message).toContain("answered the signed payment with 403");
    expect(events.map((event) => event.type)).toContain("error");
  });

  it("answers a second 402 with a fresh authorization, never resending the request unpaid", async () => {
    const { fetch, calls } = scripted(
      challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header() }),
      challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header() }),
      paid("x402"),
    );
    const { paidFetch, events } = paidClient(fetch, {
      retry: { sleep: async () => undefined },
    });

    const response = await paidFetch(RESOURCE);

    expect(response.status).toBe(200);
    // Unpaid, paid and refused, paid again: one unpaid request in all.
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.headers.has(PAYMENT_SIGNATURE_HEADER))).toEqual([
      false,
      true,
      true,
    ]);
    expect(events.map((event) => event.type)).toContain("retry");
  });

  it("rejects a second 402 when retries are turned off", async () => {
    const { fetch, calls } = scripted(
      challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header() }),
      challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header() }),
    );
    const { paidFetch } = paidClient(fetch, { retry: { maxAttempts: 1 } });

    const error = await rejection(paidFetch(RESOURCE));

    expect(error.message).toContain("another 402");
    expect(calls).toHaveLength(2);
  });

  it("pays once for two identical concurrent requests, and each caller can read the body", async () => {
    const { fetch, calls } = transport((call) =>
      call.headers.has(PAYMENT_SIGNATURE_HEADER)
        ? paid("x402", "shared body")
        : challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header() }),
    );
    const { paidFetch, events } = paidClient(fetch);

    const [a, b] = await Promise.all([paidFetch(RESOURCE), paidFetch(RESOURCE)]);

    expect(await a.text()).toBe("shared body");
    expect(await b.text()).toBe("shared body");
    expect(calls.filter((call) => call.headers.has(PAYMENT_SIGNATURE_HEADER))).toHaveLength(1);
    expect(events.filter((event) => event.type === "payment")).toHaveLength(1);
    expect(events.filter((event) => event.type === "payment:deduplicated")).toHaveLength(1);
  });

  it("pays separately for concurrent POSTs with different bodies", async () => {
    const { fetch, calls } = transport((call) =>
      call.headers.has(PAYMENT_SIGNATURE_HEADER)
        ? paid("x402", `echo:${call.body}`)
        : challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header() }),
    );
    const { paidFetch } = paidClient(fetch);

    const [a, b] = await Promise.all([
      paidFetch(RESOURCE, { method: "POST", body: "one" }),
      paidFetch(RESOURCE, { method: "POST", body: "two" }),
    ]);

    expect(await a.text()).toBe("echo:one");
    expect(await b.text()).toBe("echo:two");
    expect(calls.filter((call) => call.headers.has(PAYMENT_SIGNATURE_HEADER))).toHaveLength(2);
  });

  it("tells the router which models a smart-account signer can pay", async () => {
    const smart = createSmartAccountSigner({
      contractId: USDC,
      network: "testnet",
      signAuthEntry: async (entry) => ({ signedAuthEntry: entry }),
    });
    const { fetch, calls } = scripted(challenge({ "WWW-Authenticate": mppHeader() }));
    const client = createClient({
      network: "testnet",
      settlers: { x402: createX402Settler({ signer: smart, network: "testnet", fetch }) },
      supportedModels: signerModels(smart),
      router: createDefaultRouter(),
    });
    const paidFetch = createPaidFetch({ client, network: "testnet", fetch });

    const error = await rejection(paidFetch(RESOURCE));

    expect(error.code).toBe("no-viable-model");
    expect(error.message).toContain("policy allows [x402]");
    expect(calls).toHaveLength(1);
  });

  it("refuses a settler that cannot finish an exchange, before any payment", async () => {
    const { fetch, calls } = scripted(challenge({ [PAYMENT_REQUIRED_HEADER]: x402Header() }));
    const settle = vi.fn();
    const { paidFetch } = paidClient(fetch, {}, { x402: { settle } });

    const error = await rejection(paidFetch(RESOURCE));

    expect(error.message).toContain("has no settleExchange");
    expect(settle).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});
