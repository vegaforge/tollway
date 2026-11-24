/**
 * The x402 `payment-identifier` extension as the gate's idempotency key
 * (#153). The declaration is checked with the upstream validators from
 * `@x402/extensions/payment-identifier`, and the payments are built the way a
 * stock client builds them: `extensions` copied from the challenge, with the
 * client's id added by `appendPaymentIdentifierToExtensions`.
 */

import { Ed25519Signer } from "@vegaforge/tollway-core";
import {
  appendPaymentIdentifierToExtensions,
  isPaymentIdentifierExtension,
  isPaymentIdentifierRequired,
  PAYMENT_IDENTIFIER,
  validatePaymentIdentifier,
} from "@x402/extensions/payment-identifier";
import RedisMock from "ioredis-mock";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createInMemorySettlementCache,
  createRedisSettlementCache,
  type RedisLikeClient,
  type SettlementCache,
} from "./cache.js";
import { createMockFacilitator, type FacilitatorClient } from "./facilitator.js";
import {
  createPaywall,
  type GateOutcome,
  type PaywallConfig,
  type TollwayRequest,
} from "./gate.js";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from "./headers.js";
import { createInMemoryPaymentReceiptArchive } from "./payment-receipt-archive.js";

const config = {
  amount: "10000",
  asset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
  payTo: "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  network: "testnet",
} satisfies PaywallConfig;

const request: TollwayRequest = { method: "GET", url: "/quotes/latest", headers: {} };

const PAYMENT_ID = "pay_7d5d747be160e280504c099d984bcfe0";
const ALICE = "GALICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const MALLORY = "GMALLORYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

let signer: Ed25519Signer;
beforeAll(async () => {
  signer = await Ed25519Signer.generate("test-key");
});

/**
 * The mock facilitator, except that the payer is whoever the test says signed
 * the envelope (`<payer>|<anything>`), so one payer can re-sign a payment as a
 * new envelope. Counts every call.
 */
function facilitator() {
  const inner = createMockFacilitator();
  const calls = { verify: 0, settle: 0 };
  const client: FacilitatorClient = {
    ...inner,
    async verify(input) {
      calls.verify += 1;
      const result = await inner.verify(input);
      if (!result.valid) return result;
      const transaction = String(input.payment.payload.payload.transaction);
      return { ...result, payer: transaction.split("|")[0] ?? "" };
    },
    async settle(input) {
      calls.settle += 1;
      return inner.settle(input);
    },
  };
  return { client, calls };
}

async function challengeOf(gate: (r: TollwayRequest) => Promise<GateOutcome>) {
  const outcome = await gate(request);
  if (outcome.kind !== "payment-required") throw new Error(`expected a 402, got ${outcome.kind}`);
  return decodePaymentRequiredHeader(outcome.headers[PAYMENT_REQUIRED_HEADER] ?? "");
}

/** Pays the challenge with a fresh envelope signed by `payer`, carrying `id` when given. */
async function pay(
  gate: (r: TollwayRequest) => Promise<GateOutcome>,
  envelope: string,
  id: string | undefined,
): Promise<TollwayRequest> {
  const challenge = await challengeOf(gate);
  const accepted = challenge.accepts[0];
  if (!accepted) throw new Error("the challenge offers nothing");
  const extensions = structuredClone(challenge.extensions ?? {});
  if (id !== undefined) appendPaymentIdentifierToExtensions(extensions, id);
  return {
    ...request,
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
        x402Version: 2,
        accepted,
        payload: { transaction: envelope },
        extensions,
      }),
    },
  };
}

/** A payment header whose `payment-identifier` extension is exactly `extension`. */
function rawPayment(envelope: string, extension: unknown): TollwayRequest {
  return {
    ...request,
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader({
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
        payload: { transaction: envelope },
        extensions: { [PAYMENT_IDENTIFIER]: extension },
      }),
    },
  };
}

function settled(outcome: GateOutcome) {
  if (outcome.kind !== "settled") {
    throw new Error(`expected settled, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

describe("payment-identifier declaration", () => {
  it("declares the extension, not required, on every 402", async () => {
    const gate = createPaywall(config, { signer, facilitator: createMockFacilitator() });

    const extension = (await challengeOf(gate)).extensions?.[PAYMENT_IDENTIFIER];

    expect(isPaymentIdentifierExtension(extension)).toBe(true);
    expect(validatePaymentIdentifier(extension)).toEqual({ valid: true });
    expect(isPaymentIdentifierRequired(extension)).toBe(false);
  });

  it("declares it as required when the paywall says so", async () => {
    const gate = createPaywall(
      { ...config, paymentIdentifier: { required: true } },
      { signer, facilitator: createMockFacilitator() },
    );

    const extension = (await challengeOf(gate)).extensions?.[PAYMENT_IDENTIFIER];

    expect(validatePaymentIdentifier(extension)).toEqual({ valid: true });
    expect(isPaymentIdentifierRequired(extension)).toBe(true);
  });

  it("keeps the bazaar declaration beside it on a route that publishes discovery", async () => {
    const gate = createPaywall(
      { ...config, discovery: { kind: "query", description: "Latest quote" } },
      { signer, facilitator: createMockFacilitator() },
    );

    const extensions = (await challengeOf(gate)).extensions ?? {};

    expect(Object.keys(extensions).sort()).toEqual(["bazaar", PAYMENT_IDENTIFIER]);
  });
});

describe("payment-identifier as the idempotency key", () => {
  function makeGate(cache: SettlementCache = createInMemorySettlementCache()) {
    const { client, calls } = facilitator();
    return { gate: createPaywall(config, { signer, facilitator: client, cache }), calls };
  }

  it("returns the original receipt to a retry that re-signs the payment as a new envelope", async () => {
    const { gate, calls } = makeGate();

    const first = settled(await gate(await pay(gate, `${ALICE}|envelope-1`, PAYMENT_ID)));
    const retry = settled(await gate(await pay(gate, `${ALICE}|envelope-2`, PAYMENT_ID)));

    expect(retry.receipt).toEqual(first.receipt);
    expect(retry.replayed).toBe(true);
    expect(calls.settle).toBe(1);
  });

  it("verifies the retry before looking the id up", async () => {
    const { gate, calls } = makeGate();
    await gate(await pay(gate, `${ALICE}|envelope-1`, PAYMENT_ID));

    // An envelope the facilitator refuses: the id alone unlocks nothing.
    const outcome = await gate(await pay(gate, "", PAYMENT_ID));

    expect(outcome).toMatchObject({ kind: "rejected", status: 402 });
    expect(calls.settle).toBe(1);
  });

  it("never gives another payer the receipt for an id it reuses", async () => {
    const { gate, calls } = makeGate();
    const victim = settled(await gate(await pay(gate, `${ALICE}|envelope-1`, PAYMENT_ID)));

    const outcome = settled(await gate(await pay(gate, `${MALLORY}|envelope-9`, PAYMENT_ID)));

    // Mallory's payment is her own: it settles on its own and names her.
    expect(outcome.receipt.receipt.id).not.toBe(victim.receipt.receipt.id);
    expect(outcome.receipt.receipt.payer).toBe(MALLORY);
    expect(outcome.replayed).toBe(false);
    expect(calls.settle).toBe(2);
  });

  it("rejects the same id on a different offer with 409, without settling again", async () => {
    const cache = createInMemorySettlementCache();
    const { client, calls } = facilitator();
    const quotes = createPaywall(config, { signer, facilitator: client, cache });
    const pricier = createPaywall(
      { ...config, amount: "20000" },
      { signer, facilitator: client, cache },
    );
    await quotes(await pay(quotes, `${ALICE}|envelope-1`, PAYMENT_ID));

    const outcome = await pricier(await pay(pricier, `${ALICE}|envelope-2`, PAYMENT_ID));

    expect(outcome).toMatchObject({ kind: "rejected", status: 409, code: "offer-mismatch" });
    expect(calls.settle).toBe(1);
  });

  it("settles a payment once when two envelopes with one id arrive together", async () => {
    const { gate, calls } = makeGate();
    const [a, b] = await Promise.all([
      pay(gate, `${ALICE}|envelope-1`, PAYMENT_ID),
      pay(gate, `${ALICE}|envelope-2`, PAYMENT_ID),
    ]);

    const [first, second] = await Promise.all([gate(a), gate(b)]);

    expect(settled(first).receipt).toEqual(settled(second).receipt);
    expect(calls.settle).toBe(1);
  });

  it("replays by envelope digest too, so the same envelope sent without the id is not settled twice", async () => {
    const { gate, calls } = makeGate();
    const first = settled(await gate(await pay(gate, `${ALICE}|envelope-1`, PAYMENT_ID)));

    const again = settled(await gate(await pay(gate, `${ALICE}|envelope-1`, undefined)));

    expect(again.receipt).toEqual(first.receipt);
    expect(calls.settle).toBe(1);
  });

  it("keys on the envelope digest when there is no id, as before", async () => {
    const { gate, calls } = makeGate();

    await gate(await pay(gate, `${ALICE}|envelope-1`, undefined));
    const resigned = settled(await gate(await pay(gate, `${ALICE}|envelope-2`, undefined)));

    expect(resigned.replayed).toBe(false);
    expect(calls.settle).toBe(2);
  });
});

describe("payment-identifier with the receipt archive", () => {
  it("replays a re-signed payment from the archive after its cache entry expired", async () => {
    let now = 1_800_000_000_000;
    const clock = () => now;
    const { client, calls } = facilitator();
    const gate = createPaywall(config, {
      signer,
      facilitator: client,
      cache: createInMemorySettlementCache(30_000, { now: clock }),
      receiptArchive: createInMemoryPaymentReceiptArchive({ now: clock }),
    });
    const first = settled(await gate(await pay(gate, `${ALICE}|envelope-1`, PAYMENT_ID)));

    now += 60_000;
    const retry = settled(await gate(await pay(gate, `${ALICE}|envelope-2`, PAYMENT_ID)));

    expect(retry.receipt).toEqual(first.receipt);
    expect(retry.replayed).toBe(true);
    expect(calls.settle).toBe(1);
  });
});

describe("payment-identifier validation", () => {
  it("rejects an invalid id with 400 before verifying", async () => {
    const { client, calls } = facilitator();
    const gate = createPaywall(config, { signer, facilitator: client });

    const outcome = await gate(
      rawPayment(`${ALICE}|envelope-1`, { info: { required: false, id: "short" } }),
    );

    expect(outcome).toMatchObject({ kind: "rejected", status: 400, code: "payment-malformed" });
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).toMatch(/^invalid-payment-identifier: /);
    expect(calls.verify).toBe(0);
  });

  it("rejects an extension that is not an object with an info block", async () => {
    const gate = createPaywall(config, { signer, facilitator: facilitator().client });

    const outcome = await gate(rawPayment(`${ALICE}|envelope-1`, { id: PAYMENT_ID }));

    expect(outcome).toMatchObject({ kind: "rejected", status: 400 });
  });

  it("rejects a payment without an id when the paywall requires one", async () => {
    const { client, calls } = facilitator();
    const gate = createPaywall(
      { ...config, paymentIdentifier: { required: true } },
      { signer, facilitator: client },
    );

    const outcome = await gate(await pay(gate, `${ALICE}|envelope-1`, undefined));

    expect(outcome).toMatchObject({ kind: "rejected", status: 400 });
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).toMatch(/requires a payment identifier/);
    expect(calls.verify).toBe(0);
  });

  it("accepts a valid id when required", async () => {
    const gate = createPaywall(
      { ...config, paymentIdentifier: { required: true } },
      { signer, facilitator: facilitator().client },
    );

    settled(await gate(await pay(gate, `${ALICE}|envelope-1`, PAYMENT_ID)));
  });

  it("never compiles a schema the client sent", async () => {
    const gate = createPaywall(config, { signer, facilitator: facilitator().client });

    // A schema that would refuse every id. The gate validates the id against
    // the extension's own rules, so the client cannot change them.
    const outcome = await gate(
      rawPayment(`${ALICE}|envelope-1`, {
        info: { required: false, id: PAYMENT_ID },
        schema: { type: "object", properties: { id: { type: "string", maxLength: 1 } } },
      }),
    );

    settled(outcome);
  });
});

describe("payment-identifier with a shared Redis cache", () => {
  // ioredis-mock instances share one store, so each test uses its own prefix.
  it("replays across processes and writes the digest and id keys together", async () => {
    const client = new RedisMock() as unknown as RedisLikeClient;
    const keyPrefix = "gate-test:payment-id:";
    const { client: facilitatorClient, calls } = facilitator();
    const processA = createPaywall(config, {
      signer,
      facilitator: facilitatorClient,
      cache: createRedisSettlementCache({ client, keyPrefix }),
    });
    const processB = createPaywall(config, {
      signer,
      facilitator: facilitatorClient,
      cache: createRedisSettlementCache({ client, keyPrefix }),
    });

    const first = settled(await processA(await pay(processA, `${ALICE}|envelope-1`, PAYMENT_ID)));
    const retry = settled(await processB(await pay(processB, `${ALICE}|envelope-2`, PAYMENT_ID)));

    expect(retry.receipt).toEqual(first.receipt);
    expect(calls.settle).toBe(1);
    const idKey = `${keyPrefix}x402:payment-id:${ALICE}:${PAYMENT_ID}`;
    expect(await client.get(idKey)).not.toBeNull();
  });
});
