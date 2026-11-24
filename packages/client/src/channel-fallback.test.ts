import {
  buildReceipt,
  ChannelOpenFailedError,
  createPolicyEngine,
  Ed25519Signer,
  type PaymentOffer,
  type SignedReceipt,
  signReceipt,
  TollwayError,
} from "@vegaforge/tollway-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ClientEvent,
  type ClientSettler,
  createClient,
  PolicyBlockedError,
  type SettleRequest,
  type SettlerEvent,
} from "./index.js";

const PAYEE = "GSERVICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const OTHER_PAYEE = "GOTHERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const OFFER: PaymentOffer = {
  resource: "/quotes/latest",
  amount: "10000",
  asset: "USDC:GA5Z",
  payTo: PAYEE,
  network: "testnet",
  models: ["mpp-channel", "x402"],
};

let signer: Ed25519Signer;

beforeAll(async () => {
  signer = await Ed25519Signer.generate("test-service-key");
});

/** A receipt the test service signs for exactly this settlement. */
function receiptFor(input: SettleRequest): Promise<SignedReceipt> {
  return signReceipt(
    buildReceipt({
      payer: "GPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      payee: input.offer.payTo,
      amount: input.offer.amount,
      asset: input.offer.asset,
      resource: input.offer.resource,
      model: input.model,
      settlement:
        input.model === "mpp-channel"
          ? { kind: "channel-commitment", channelId: "CCHAN1", sequence: 0 }
          : { kind: "transaction", txHash: `tx-${input.model}` },
      network: input.offer.network,
    }),
    signer,
  );
}

/** An x402 settler that pays whatever it is asked to. */
function x402Settler() {
  const settle = vi.fn(receiptFor);
  const settler: ClientSettler = { settle };
  return { settler, settle };
}

/** A channel settler whose open fails with `error` until `heal()` is called. */
function channelSettler(error: Error) {
  let healed = false;
  const settle = vi.fn(async (input: SettleRequest) => {
    if (!healed) throw error;
    return receiptFor(input);
  });
  const settler: ClientSettler = { settle };
  const heal = (): void => {
    healed = true;
  };
  return { settler, settle, heal };
}

function openFailed(submission: "not-submitted" | "failed" | "ambiguous" = "not-submitted") {
  return new ChannelOpenFailedError({
    counterparty: PAYEE,
    asset: OFFER.asset,
    submission,
    ...(submission === "ambiguous" ? { channelId: "CORPHAN", txHash: "tx-open-maybe" } : {}),
    cause: new Error("insufficient balance"),
  });
}

function recordEvents(client: { on(handler: (event: ClientEvent) => void): void }) {
  const events: ClientEvent[] = [];
  client.on((event) => events.push(event));
  return events;
}

const channelPay = { resource: OFFER.resource, offer: OFFER, model: "mpp-channel" as const };

describe("x402 fallback when a channel open fails (#183)", () => {
  it("pays by x402 once, and reports the fallback and the model that paid", async () => {
    const channel = channelSettler(openFailed());
    const x402 = x402Settler();
    const policy = createPolicyEngine({});
    const record = vi.spyOn(policy, "record");
    const client = createClient({
      network: "testnet",
      settler: channel.settler,
      policy,
      fallback: { x402: x402.settler },
    });
    const events = recordEvents(client);

    const result = await client.pay(channelPay);

    expect(result.model).toBe("x402");
    expect(result.receipt.receipt.model).toBe("x402");
    expect(x402.settle).toHaveBeenCalledTimes(1);
    expect(x402.settle).toHaveBeenCalledWith({
      resource: OFFER.resource,
      offer: OFFER,
      model: "x402",
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ model: "x402" });
    const types = events.map((event) => event.type);
    expect(types).toContain("fallback");
    expect(types.indexOf("fallback")).toBeLessThan(types.indexOf("payment"));
    expect(events.find((event) => event.type === "fallback")).toMatchObject({
      from: "mpp-channel",
      to: "x402",
    });
    expect(events.find((event) => event.type === "payment")).toMatchObject({ model: "x402" });
  });

  it("throws the open failure unchanged without a fallback configured", async () => {
    const channel = channelSettler(openFailed());
    const client = createClient({ network: "testnet", settler: channel.settler });

    await expect(client.pay(channelPay)).rejects.toBeInstanceOf(ChannelOpenFailedError);
  });

  it("does not fall back when the offer does not accept x402", async () => {
    const channel = channelSettler(openFailed());
    const x402 = x402Settler();
    const client = createClient({
      network: "testnet",
      settler: channel.settler,
      fallback: { x402: x402.settler },
    });

    await expect(
      client.pay({ ...channelPay, offer: { ...OFFER, models: ["mpp-channel"] } }),
    ).rejects.toBeInstanceOf(ChannelOpenFailedError);
    expect(x402.settle).not.toHaveBeenCalled();
  });

  it.each([
    ["a voucher-stage failure", new TollwayError("payment-failed", "voucher response lost")],
    ["a plain error", new Error("socket hang up")],
    ["a receipt verification failure", new TollwayError("receipt-verification-failed", "bad")],
  ])("never falls back after %s, which may already have paid", async (_name, error) => {
    const channel = channelSettler(error);
    const x402 = x402Settler();
    const client = createClient({
      network: "testnet",
      settler: channel.settler,
      fallback: { x402: x402.settler },
    });

    await expect(client.pay(channelPay)).rejects.toBe(error);
    expect(x402.settle).not.toHaveBeenCalled();
  });

  it("asks the policy again for x402, and reports its block instead of the channel error", async () => {
    const channel = channelSettler(openFailed());
    const x402 = x402Settler();
    const client = createClient({
      network: "testnet",
      settler: channel.settler,
      policy: createPolicyEngine({ perModel: { x402: { enabled: false } } }),
      fallback: { x402: x402.settler },
    });

    await expect(client.pay(channelPay)).rejects.toBeInstanceOf(PolicyBlockedError);
    expect(x402.settle).not.toHaveBeenCalled();
  });

  it("reports an open that may have landed, with whatever ids are known", async () => {
    const onOrphanedChannel = vi.fn();
    const client = createClient({
      network: "testnet",
      settler: channelSettler(openFailed("ambiguous")).settler,
      fallback: { x402: x402Settler().settler, onOrphanedChannel },
    });

    await client.pay(channelPay);

    expect(onOrphanedChannel).toHaveBeenCalledTimes(1);
    expect(onOrphanedChannel.mock.calls[0]?.[0]).toMatchObject({
      counterparty: PAYEE,
      asset: OFFER.asset,
      channelId: "CORPHAN",
      txHash: "tx-open-maybe",
    });
  });

  it.each([
    "not-submitted",
    "failed",
  ] as const)("does not report an orphan when the open was %s", async (submission) => {
    const onOrphanedChannel = vi.fn();
    const client = createClient({
      network: "testnet",
      settler: channelSettler(openFailed(submission)).settler,
      fallback: { x402: x402Settler().settler, onOrphanedChannel },
    });

    await client.pay(channelPay);
    expect(onOrphanedChannel).not.toHaveBeenCalled();
  });

  it("still pays when the orphan callback throws", async () => {
    const client = createClient({
      network: "testnet",
      settler: channelSettler(openFailed("ambiguous")).settler,
      fallback: {
        x402: x402Settler().settler,
        onOrphanedChannel: () => {
          throw new Error("alerting down");
        },
      },
    });

    await expect(client.pay(channelPay)).resolves.toMatchObject({ model: "x402" });
  });
});

describe("channel cooldown after a failed open (#183)", () => {
  function setup(options: { cooldownMs?: number; maxCooldownMs?: number; maxTracked?: number }) {
    let now = Date.now();
    const channel = channelSettler(openFailed());
    const x402 = x402Settler();
    const client = createClient({
      network: "testnet",
      settler: channel.settler,
      clock: () => now,
      fallback: { x402: x402.settler, ...options },
    });
    return {
      client,
      channel,
      x402,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("pays by x402 directly until the cooldown ends, without trying the channel", async () => {
    const { client, channel, x402, advance } = setup({ cooldownMs: 1_000 });
    const events = recordEvents(client);

    await client.pay(channelPay);
    advance(999);
    await client.pay(channelPay);

    expect(channel.settle).toHaveBeenCalledTimes(1);
    expect(x402.settle).toHaveBeenCalledTimes(2);
    expect(events.filter((event) => event.type === "fallback")).toHaveLength(2);
  });

  it("lets one request try the channel after the cooldown and doubles the wait when it fails", async () => {
    const { client, channel, advance } = setup({ cooldownMs: 1_000, maxCooldownMs: 10_000 });

    await client.pay(channelPay); // fails, rests 1s
    advance(1_000);
    await client.pay(channelPay); // tries again, fails, rests 2s
    expect(channel.settle).toHaveBeenCalledTimes(2);

    advance(1_999);
    await client.pay(channelPay);
    expect(channel.settle).toHaveBeenCalledTimes(2);

    advance(1);
    await client.pay(channelPay);
    expect(channel.settle).toHaveBeenCalledTimes(3);
  });

  it("caps the wait at maxCooldownMs", async () => {
    const { client, channel, advance } = setup({ cooldownMs: 1_000, maxCooldownMs: 1_500 });

    await client.pay(channelPay); // rests 1s
    advance(1_000);
    await client.pay(channelPay); // would rest 2s, capped at 1.5s
    advance(1_500);
    await client.pay(channelPay);

    expect(channel.settle).toHaveBeenCalledTimes(3);
  });

  it("sends only one request to the channel when the cooldown ends, and clears it on success", async () => {
    const { client, channel, x402, advance } = setup({ cooldownMs: 1_000 });
    await client.pay(channelPay);
    advance(1_000);
    channel.heal();

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    channel.settle.mockImplementationOnce(async (input) => {
      await held;
      return receiptFor(input);
    });

    // Different idempotency keys, so the two calls are separate purchases.
    const probe = client.pay({ ...channelPay, idempotencyKey: "a" });
    const during = client.pay({ ...channelPay, idempotencyKey: "b" });
    await expect(during).resolves.toMatchObject({ model: "x402" });
    release();
    await expect(probe).resolves.toMatchObject({ model: "mpp-channel" });

    expect(channel.settle).toHaveBeenCalledTimes(2);
    expect(x402.settle).toHaveBeenCalledTimes(2);

    // The success cleared the cooldown, so the next request uses the channel.
    await expect(client.pay(channelPay)).resolves.toMatchObject({ model: "mpp-channel" });
  });

  it("frees the slot when the request trying the channel fails some other way", async () => {
    const { client, channel, advance } = setup({ cooldownMs: 1_000 });
    await client.pay(channelPay);
    advance(1_000);
    channel.settle.mockRejectedValueOnce(new TollwayError("payment-failed", "voucher refused"));

    await expect(client.pay(channelPay)).rejects.toThrow("voucher refused");
    channel.heal();
    await expect(client.pay(channelPay)).resolves.toMatchObject({ model: "mpp-channel" });
  });

  it("forgets the oldest counterparty once maxTracked is reached", async () => {
    const { client, channel } = setup({ cooldownMs: 60_000, maxTracked: 1 });
    const other = { ...channelPay, offer: { ...OFFER, payTo: OTHER_PAYEE } };

    await client.pay(channelPay);
    await client.pay(other);
    // PAYEE's cooldown was evicted, so it tries the channel again.
    await client.pay(channelPay);

    expect(channel.settle).toHaveBeenCalledTimes(3);
  });

  it.each([
    [{ cooldownMs: 0 }, /cooldownMs/],
    [{ cooldownMs: Number.NaN }, /cooldownMs/],
    [{ cooldownMs: 2_000, maxCooldownMs: 1_000 }, /maxCooldownMs/],
    [{ maxTracked: 0 }, /maxTracked/],
    [{ maxTracked: 1.5 }, /maxTracked/],
  ])("refuses fallback options %j", (options, message) => {
    expect(() =>
      createClient({
        network: "testnet",
        settler: x402Settler().settler,
        fallback: { x402: x402Settler().settler, ...options },
      }),
    ).toThrow(message);
  });
});

describe("settler events on the client stream (#187)", () => {
  it("puts a settler's channel events on the client's on() stream", () => {
    let emit: ((event: SettlerEvent) => void) | undefined;
    const settler: ClientSettler = {
      settle: vi.fn(),
      subscribe(forward) {
        emit = forward;
      },
    };
    const client = createClient({ network: "testnet", settler });
    const events = recordEvents(client);

    emit?.({ type: "channel:opened", channelId: "CCHAN1" });
    emit?.({ type: "channel:closed", channelId: "CCHAN1" });

    expect(events).toEqual([
      { type: "channel:opened", channelId: "CCHAN1" },
      { type: "channel:closed", channelId: "CCHAN1" },
    ]);
  });

  it("subscribes the fallback settler too", () => {
    const subscribe = vi.fn();
    createClient({
      network: "testnet",
      settler: x402Settler().settler,
      fallback: { x402: { settle: vi.fn(), subscribe } },
    });
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
