import type * as ChargeClient from "@stellar/mpp/charge/client";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import {
  buildReceipt,
  Ed25519Signer,
  type PaymentOffer,
  type SignedReceipt,
  signReceipt,
  TollwayError,
} from "@vegaforge/tollway-core";
import { Challenge, Credential, Receipt } from "mppx";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "./index.js";
import {
  createMppChargeSettler,
  MPP_NETWORK_ID,
  type MppChargeSettlerOptions,
  offerAssetContract,
} from "./mpp-charge-settler.js";
import { TOLLWAY_RECEIPT_HEADER } from "./receipt-header.js";

// The real stellar.charge method simulates the transfer against Soroban RPC
// (and in push mode submits it), so its createCredential is stubbed at the
// module boundary. Everything else is real: the method's name, intent and
// schema, mppx's challenge selection, expiry check and credential format.
const charge = vi.hoisted(() => ({
  parameters: [] as Array<Record<string, unknown>>,
  createCredential: vi.fn(),
}));

vi.mock("@stellar/mpp/charge/client", async () => {
  const actual = await vi.importActual<typeof ChargeClient>("@stellar/mpp/charge/client");
  type ChargeParameters = Parameters<typeof actual.stellar.charge>[0];
  type CreateCredentialInput = Parameters<
    ReturnType<typeof actual.stellar.charge>["createCredential"]
  >[0];
  const wrapped = (parameters: ChargeParameters) => {
    charge.parameters.push({ ...parameters });
    const method = actual.stellar.charge(parameters);
    return {
      ...method,
      createCredential: async (input: CreateCredentialInput) => {
        charge.createCredential(input);
        return Credential.serialize({
          challenge: input.challenge,
          payload: { type: "transaction", transaction: "signed-xdr" },
          source: "did:pkh:stellar:testnet:GAGENT",
        });
      },
    };
  };
  return { ...actual, stellar: Object.assign(wrapped, { charge: wrapped }) };
});

const RESOURCE = "https://api.example.com/quotes/latest";
const PAYEE = Keypair.random().publicKey();
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AGENT = Keypair.random();
const TX_HASH = "a".repeat(64);

const offer: PaymentOffer = {
  resource: RESOURCE,
  amount: "10000",
  asset: USDC,
  payTo: PAYEE,
  network: "testnet",
  models: ["mpp-charge"],
};

type ChallengeRequest = {
  amount: string;
  currency: string;
  recipient: string;
  methodDetails?: { network: string };
};

function stellarRequest(overrides: Partial<ChallengeRequest> = {}): ChallengeRequest {
  return {
    amount: offer.amount,
    currency: USDC,
    recipient: PAYEE,
    methodDetails: { network: "stellar:testnet" },
    ...overrides,
  };
}

function challengeHeader(
  request: Record<string, unknown> = stellarRequest(),
  shape: { method?: string; intent?: string; expires?: string } = {},
): string {
  return Challenge.serialize(
    Challenge.from({
      id: `challenge-${Math.random().toString(36).slice(2)}`,
      realm: "tollway",
      method: shape.method ?? "stellar",
      intent: shape.intent ?? "charge",
      request,
      expires: shape.expires ?? new Date(Date.now() + 60_000).toISOString(),
    }),
  );
}

function challengeResponse(header: string | null = challengeHeader()): Response {
  return new Response(JSON.stringify({ error: "payment required" }), {
    status: 402,
    headers: header === null ? {} : { "WWW-Authenticate": header },
  });
}

let signedReceipt: SignedReceipt;

beforeAll(async () => {
  const signer = await Ed25519Signer.generate();
  const body = buildReceipt({
    payer: AGENT.publicKey(),
    payee: PAYEE,
    amount: offer.amount,
    asset: USDC,
    resource: RESOURCE,
    model: "mpp-charge",
    settlement: { kind: "transaction", txHash: TX_HASH },
    network: "testnet",
  });
  signedReceipt = await signReceipt(body, signer);
});

function receiptValue(receipt: unknown = signedReceipt): string {
  return Buffer.from(JSON.stringify(receipt)).toString("base64");
}

function paidResponse(
  headers: Record<string, string> = { [TOLLWAY_RECEIPT_HEADER]: receiptValue() },
): Response {
  return new Response(JSON.stringify({ quote: 1 }), { status: 200, headers });
}

type Call = { url: string; init: RequestInit | undefined };

function scriptedFetch(...responses: Response[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error("scripted fetch ran out of responses");
    return next;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function settler(fetch: typeof globalThis.fetch, extra: Partial<MppChargeSettlerOptions> = {}) {
  return createMppChargeSettler({
    secretKey: AGENT.secret(),
    network: "testnet",
    fetch,
    ...extra,
  } as MppChargeSettlerOptions);
}

async function rejection(promise: Promise<unknown>): Promise<TollwayError> {
  const error = await promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(TollwayError);
  return error as TollwayError;
}

beforeEach(() => {
  charge.parameters.length = 0;
  charge.createCredential.mockClear();
});

describe("createMppChargeSettler", () => {
  it("answers the Stellar charge challenge and returns the Tollway receipt", async () => {
    const { fetch, calls } = scriptedFetch(challengeResponse(), paidResponse());
    const receipt = await settler(fetch).settle({ resource: RESOURCE, offer, model: "mpp-charge" });

    expect(receipt).toEqual(signedReceipt);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init?.headers).toBeUndefined();
    const authorization = new Headers(calls[1]?.init?.headers).get("Authorization");
    expect(authorization).toMatch(/^Payment /);
    expect(Credential.deserialize(authorization ?? "").payload).toEqual({
      type: "transaction",
      transaction: "signed-xdr",
    });
    expect(charge.createCredential).toHaveBeenCalledTimes(1);
  });

  it("passes base-unit decimals, the mode and the RPC URL to @stellar/mpp", async () => {
    const { fetch } = scriptedFetch(challengeResponse(), paidResponse());
    await settler(fetch, { mode: "push", rpcUrl: "https://rpc.example" }).settle({
      resource: RESOURCE,
      offer,
      model: "mpp-charge",
    });
    expect(charge.parameters[0]).toMatchObject({
      decimals: 0,
      mode: "push",
      rpcUrl: "https://rpc.example",
    });
  });

  it("defaults to pull mode", async () => {
    settler(scriptedFetch().fetch);
    expect(charge.parameters[0]).toMatchObject({ mode: "pull" });
  });

  it.each([
    ["amount", stellarRequest({ amount: "10001" }), /asks for 10001/],
    ["recipient", stellarRequest({ recipient: Keypair.random().publicKey() }), /pays G/],
    [
      "currency",
      stellarRequest({ currency: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC" }),
      /charges CDLZ/,
    ],
    [
      "network",
      stellarRequest({ methodDetails: { network: "stellar:pubnet" } }),
      /network stellar:pubnet/,
    ],
    [
      "missing network",
      { amount: offer.amount, currency: USDC, recipient: PAYEE },
      /network \(none\)/,
    ],
  ])("refuses a challenge with the wrong %s and signs nothing", async (_name, request, message) => {
    const { fetch, calls } = scriptedFetch(challengeResponse(challengeHeader(request)));
    const error = await rejection(
      settler(fetch).settle({ resource: RESOURCE, offer, model: "mpp-charge" }),
    );
    expect(error.code).toBe("payment-failed");
    expect(error.message).toMatch(/does not match the offer/);
    expect(error.message).toMatch(message);
    expect(charge.createCredential).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("rejects a first response that is not a 402", async () => {
    const { fetch } = scriptedFetch(new Response("free", { status: 200 }));
    const error = await rejection(
      settler(fetch).settle({ resource: RESOURCE, offer, model: "mpp-charge" }),
    );
    expect(error.message).toMatch(/expected a 402 challenge .* got 200/);
  });

  it("rejects a 402 with no MPP challenge", async () => {
    const { fetch } = scriptedFetch(challengeResponse(null));
    const error = await rejection(
      settler(fetch).settle({ resource: RESOURCE, offer, model: "mpp-charge" }),
    );
    expect(error.message).toMatch(/no (readable MPP challenge|Stellar MPP charge challenge)/);
    expect(charge.createCredential).not.toHaveBeenCalled();
  });

  it("rejects a 402 whose only challenge is not a Stellar charge", async () => {
    const { fetch } = scriptedFetch(
      challengeResponse(challengeHeader(stellarRequest(), { method: "tempo" })),
    );
    const error = await rejection(
      settler(fetch).settle({ resource: RESOURCE, offer, model: "mpp-charge" }),
    );
    expect(error.message).toMatch(/no Stellar MPP charge challenge/);
  });

  it("refuses an expired challenge before signing", async () => {
    const { fetch } = scriptedFetch(
      challengeResponse(
        challengeHeader(stellarRequest(), { expires: new Date(Date.now() - 1000).toISOString() }),
      ),
    );
    const error = await rejection(
      settler(fetch).settle({ resource: RESOURCE, offer, model: "mpp-charge" }),
    );
    expect(error.message).toMatch(/could not create the MPP charge credential/);
    expect(charge.createCredential).not.toHaveBeenCalled();
  });

  it("rejects a second 402 after paying", async () => {
    const { fetch } = scriptedFetch(challengeResponse(), challengeResponse());
    const error = await rejection(
      settler(fetch).settle({ resource: RESOURCE, offer, model: "mpp-charge" }),
    );
    expect(error.message).toMatch(/answered the MPP credential with another 402/);
  });

  it("rejects a paid response without a receipt", async () => {
    const { fetch } = scriptedFetch(challengeResponse(), paidResponse({}));
    const error = await rejection(
      settler(fetch).settle({ resource: RESOURCE, offer, model: "mpp-charge" }),
    );
    expect(error.code).toBe("invalid-receipt");
    expect(error.message).toMatch(/sent no TOLLWAY-RECEIPT header/);
  });

  it("reads the receipt from a configured header", async () => {
    const { fetch } = scriptedFetch(
      challengeResponse(),
      paidResponse({ "X-Receipt": receiptValue() }),
    );
    const receipt = await settler(fetch, { receiptHeader: "X-Receipt" }).settle({
      resource: RESOURCE,
      offer,
      model: "mpp-charge",
    });
    expect(receipt).toEqual(signedReceipt);
  });

  it("rejects a receipt for another model or amount", async () => {
    const signer = await Ed25519Signer.generate();
    const wrong = await signReceipt(
      buildReceipt({
        payer: AGENT.publicKey(),
        payee: PAYEE,
        amount: "1",
        asset: USDC,
        resource: RESOURCE,
        model: "x402",
        settlement: { kind: "transaction", txHash: TX_HASH },
        network: "testnet",
      }),
      signer,
    );
    const { fetch } = scriptedFetch(
      challengeResponse(),
      paidResponse({ [TOLLWAY_RECEIPT_HEADER]: receiptValue(wrong) }),
    );
    const error = await rejection(
      settler(fetch).settle({ resource: RESOURCE, offer, model: "mpp-charge" }),
    );
    expect(error.code).toBe("invalid-receipt");
    expect(error.message).toMatch(/model is x402, not mpp-charge; amount is 1, not 10000/);
  });

  it("accepts an MPP receipt whose reference is the receipt's transaction", async () => {
    const mppReceipt = Receipt.serialize(
      Receipt.from({
        method: "stellar",
        reference: TX_HASH,
        status: "success",
        timestamp: new Date().toISOString(),
      }),
    );
    const { fetch } = scriptedFetch(
      challengeResponse(),
      paidResponse({ [TOLLWAY_RECEIPT_HEADER]: receiptValue(), "Payment-Receipt": mppReceipt }),
    );
    await expect(
      settler(fetch).settle({ resource: RESOURCE, offer, model: "mpp-charge" }),
    ).resolves.toEqual(signedReceipt);
  });

  it("rejects an MPP receipt that names another transaction", async () => {
    const mppReceipt = Receipt.serialize(
      Receipt.from({
        method: "stellar",
        reference: "b".repeat(64),
        status: "success",
        timestamp: new Date().toISOString(),
      }),
    );
    const { fetch } = scriptedFetch(
      challengeResponse(),
      paidResponse({ [TOLLWAY_RECEIPT_HEADER]: receiptValue(), "Payment-Receipt": mppReceipt }),
    );
    const error = await rejection(
      settler(fetch).settle({ resource: RESOURCE, offer, model: "mpp-charge" }),
    );
    expect(error.code).toBe("invalid-receipt");
    expect(error.message).toMatch(/does not name the transaction b{64}/);
  });

  it("refuses another model and another network without a request", async () => {
    const { fetch, calls } = scriptedFetch();
    const s = settler(fetch);
    expect(
      (await rejection(s.settle({ resource: RESOURCE, offer, model: "x402" }))).message,
    ).toMatch(/cannot settle model "x402"/);
    expect(
      (
        await rejection(
          s.settle({
            resource: RESOURCE,
            offer: { ...offer, network: "mainnet" },
            model: "mpp-charge",
          }),
        )
      ).message,
    ).toMatch(/configured for testnet, but the offer is on mainnet/);
    expect(calls).toHaveLength(0);
  });

  it("requires exactly one of secretKey and keypair", () => {
    expect(() =>
      createMppChargeSettler({ network: "testnet" } as unknown as MppChargeSettlerOptions),
    ).toThrow(/exactly one of secretKey or keypair/);
    expect(() =>
      createMppChargeSettler({
        network: "testnet",
        secretKey: AGENT.secret(),
        keypair: AGENT,
      } as unknown as MppChargeSettlerOptions),
    ).toThrow(/exactly one of secretKey or keypair/);
  });

  it("never patches globalThis.fetch and keeps the secret off the settler", async () => {
    const before = globalThis.fetch;
    const { fetch } = scriptedFetch(challengeResponse(), paidResponse());
    const s = settler(fetch);
    await s.settle({ resource: RESOURCE, offer, model: "mpp-charge" });
    expect(globalThis.fetch).toBe(before);
    expect(JSON.stringify(Object.entries(s))).not.toContain(AGENT.secret());
  });

  it("pays through createClient with the mpp-charge model", async () => {
    const { fetch } = scriptedFetch(challengeResponse(), paidResponse());
    const client = createClient({ network: "testnet", settler: settler(fetch) });
    const result = await client.pay({ resource: RESOURCE, offer, model: "mpp-charge" });
    expect(result.receipt).toEqual(signedReceipt);
  });
});

describe("MPP_NETWORK_ID", () => {
  it("maps Tollway networks to MPP network ids explicitly", () => {
    expect(MPP_NETWORK_ID).toEqual({ testnet: "stellar:testnet", mainnet: "stellar:pubnet" });
  });
});

describe("offerAssetContract", () => {
  it("keeps a contract address", () => {
    expect(offerAssetContract(USDC, "testnet")).toBe(USDC);
  });

  it("maps CODE:ISSUER and native to their asset contract on the offer's network", () => {
    const issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    expect(offerAssetContract(`USDC:${issuer}`, "testnet")).toBe(USDC);
    expect(offerAssetContract(`USDC:${issuer}`, "mainnet")).toBe(
      new Asset("USDC", issuer).contractId(Networks.PUBLIC),
    );
    expect(offerAssetContract("native", "testnet")).toBe(
      Asset.native().contractId(Networks.TESTNET),
    );
  });

  it("refuses an asset it cannot map", () => {
    expect(() => offerAssetContract("USDC", "testnet")).toThrow(TollwayError);
  });
});
