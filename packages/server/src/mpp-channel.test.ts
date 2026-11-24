import { StellarMppError } from "@stellar/mpp";
// A top-level type import, not typeof import(...) inside the generic below:
// Semgrep cannot parse the inline form, and the security check rejects files
// it cannot read.
import type * as ChannelServer from "@stellar/mpp/channel/server";
import { Store } from "@stellar/mpp/channel/server";
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import {
  Ed25519Signer,
  Ed25519Verifier,
  type PaymentOffer,
  TollwayError,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import { Challenge, Credential } from "mppx";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemorySettlementCache } from "./cache.js";
import type * as ChannelChain from "./channel-chain.js";
import { commitmentKeyFromInstance, type OnChainChannel } from "./channel-chain.js";
import { createChannelSettler } from "./channel-settlement.js";
import {
  type ChannelRecord,
  createInMemoryChannelStore,
  createInMemoryCloseRateGuard,
} from "./channel-store.js";
import { createMockFacilitator } from "./facilitator.js";
import { createPaywall, type PaywallDeps } from "./gate.js";
import {
  createMppChannelHandler,
  type MppChannelOptions,
  parseMppChannelCredential,
} from "./mpp-channel.js";

// The mppx server, the @stellar/mpp channel method and every chain read are
// stubbed at the module boundary: nothing here reaches a network. Credentials
// and challenges are built with the real mppx encoders, so the handler's own
// decoding and HMAC check run for real. The verifyCredential stub advances
// the SDK's cumulative in the real Store.memory() the way @stellar/mpp does.
const stub = vi.hoisted(() => ({
  mppx: { channel: vi.fn(), verifyCredential: vi.fn() },
  create: vi.fn(),
  stellarChannel: vi.fn(),
  readOnChainChannel: vi.fn(),
  readChannelBalanceState: vi.fn(),
  close: vi.fn(),
}));

vi.mock("@stellar/mpp/channel/server", async (importOriginal) => {
  const actual = await importOriginal<typeof ChannelServer>();
  return {
    ...actual,
    Mppx: { create: stub.create },
    stellar: { channel: stub.stellarChannel },
    close: stub.close,
  };
});

vi.mock("./channel-chain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ChannelChain>();
  return {
    ...actual,
    readOnChainChannel: stub.readOnChainChannel,
    readChannelBalanceState: stub.readChannelBalanceState,
  };
});

const SECRET = "test-mpp-secret-key-that-must-never-leak";
const RECIPIENT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const CHANNEL = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const FUNDER = Keypair.random().publicKey();
const COMMITMENT_KEY = Keypair.random().publicKey();
const FEE_PAYER = Keypair.random();
const CLOSE_TX = "c".repeat(64);
const SIG = (n: number, variant = 0) =>
  `${n.toString(16).padStart(2, "0")}${variant.toString(16).padStart(2, "0")}`.repeat(32);

const offer: PaymentOffer = {
  resource: "/data",
  amount: "1000",
  asset: USDC,
  payTo: RECIPIENT,
  network: "testnet",
  models: ["mpp-channel"],
};

function onChain(overrides: Partial<OnChainChannel> = {}): OnChainChannel {
  return {
    balance: "10000",
    refundWaitingPeriod: 20_000,
    token: USDC,
    from: FUNDER,
    to: RECIPIENT,
    closeEffectiveAtLedger: null,
    currentLedger: 100,
    commitmentKey: COMMITMENT_KEY,
    ...overrides,
  };
}

function voucher(
  amount: string,
  signature: string,
  overrides: { action?: "voucher" | "close"; secretKey?: string; challengeAmount?: string } = {},
): string {
  const challenge = Challenge.from({
    secretKey: overrides.secretKey ?? SECRET,
    realm: "tollway",
    method: "stellar",
    intent: "channel",
    request: { amount: overrides.challengeAmount ?? offer.amount, channel: CHANNEL },
  });
  return Credential.serialize({
    challenge,
    payload: { action: overrides.action ?? "voucher", amount, signature },
  });
}

type Harness = {
  store: Store.AtomicStore;
  channels: ReturnType<typeof createInMemoryChannelStore>;
  options: MppChannelOptions;
};

function harness(overrides: Partial<MppChannelOptions> = {}): Harness {
  const store = Store.memory();
  const channels = createInMemoryChannelStore();
  return {
    store,
    channels,
    options: {
      recipient: RECIPIENT,
      currency: USDC,
      network: "testnet",
      secretKey: SECRET,
      store,
      channels,
      clock: () => 1_700_000_000_000,
      ...overrides,
    },
  };
}

/** Makes the SDK stub accept a credential the way @stellar/mpp does: advance its cumulative. */
function sdkAccepts(store: Store.AtomicStore, reference = "ref") {
  stub.mppx.verifyCredential.mockImplementation(async (credential: string) => {
    const { payload, challenge } = Credential.deserialize(credential);
    const { amount } = payload as { amount: string };
    await store.put(`stellar:channel:cumulative:${String(challenge.request.channel)}`, { amount });
    return { reference };
  });
}

async function gateFor(h: Harness, deps: Partial<PaywallDeps> = {}) {
  return createPaywall(
    {
      amount: offer.amount,
      asset: USDC,
      payTo: RECIPIENT,
      network: "testnet",
      models: ["mpp-channel"],
    },
    {
      signer: await Ed25519Signer.generate("channel-key"),
      facilitator: createMockFacilitator(),
      mppChannelHandler: createMppChannelHandler(h.options),
      ...deps,
    },
  );
}

async function register(gate: Awaited<ReturnType<typeof gateFor>>) {
  return gate({ method: "GET", url: "/data", headers: { "tollway-channel": CHANNEL } });
}

function pay(gate: Awaited<ReturnType<typeof gateFor>>, credential: string) {
  return gate({ method: "GET", url: "/data", headers: { authorization: credential } });
}

beforeEach(() => {
  vi.clearAllMocks();
  stub.create.mockReturnValue(stub.mppx);
  stub.stellarChannel.mockImplementation((parameters: unknown) => ({ parameters }));
  stub.mppx.channel.mockImplementation(() => async () => ({
    status: 402,
    challenge: new Response(null, {
      status: 402,
      headers: { "WWW-Authenticate": 'Payment id="chal", method="stellar", intent="channel"' },
    }),
  }));
  stub.readOnChainChannel.mockResolvedValue(onChain());
  stub.readChannelBalanceState.mockResolvedValue({
    balance: "10000",
    closeEffectiveAtLedger: null,
    currentLedger: 100,
  });
});

describe("channel registration and challenge (#173)", () => {
  it("checks the channel on chain, stores it with the chain's commitment key, and challenges in base units", async () => {
    const h = harness();
    const gate = await gateFor(h);
    const outcome = await register(gate);

    expect(outcome.kind).toBe("payment-required");
    if (outcome.kind === "payment-required") {
      expect(outcome.headers["www-authenticate"]).toContain('intent="channel"');
    }
    expect(stub.readOnChainChannel).toHaveBeenCalledWith(CHANNEL, { network: "testnet" });
    const record = await h.channels.get(CHANNEL);
    expect(record).toMatchObject({
      status: "open",
      payer: FUNDER,
      commitmentKey: COMMITMENT_KEY,
      payTo: RECIPIENT,
      asset: USDC,
      version: 1,
    });
    expect(stub.stellarChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: CHANNEL,
        commitmentKey: COMMITMENT_KEY,
        recipient: RECIPIENT,
        currency: USDC,
        decimals: 0,
        checkOnChainState: true,
        network: "stellar:testnet",
      }),
    );
    expect(stub.mppx.channel).toHaveBeenCalledWith({ amount: "1000", scope: "/data" });
  });

  it("does not read the chain again for a channel it already registered", async () => {
    const gate = await gateFor(harness());
    await register(gate);
    await register(gate);
    expect(stub.readOnChainChannel).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "channel-recipient-mismatch",
      { to: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" },
    ],
    ["channel-token-mismatch", { token: CHANNEL }],
    ["channel-closing", { closeEffectiveAtLedger: 90 }],
    ["channel-refund-period-too-short", { refundWaitingPeriod: 10 }],
  ] as const)("refuses a channel with %s and stores nothing", async (code, state) => {
    stub.readOnChainChannel.mockResolvedValue(onChain(state));
    const h = harness();
    const outcome = await register(await gateFor(h));
    expect(outcome).toMatchObject({ kind: "rejected", status: 402 });
    if (outcome.kind === "rejected") expect(outcome.reason.startsWith(`${code}:`)).toBe(true);
    expect(await h.channels.get(CHANNEL)).toBeUndefined();
    expect(stub.mppx.channel).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the chain cannot be read", async () => {
    stub.readOnChainChannel.mockRejectedValue(new Error("rpc down"));
    const h = harness();
    const outcome = await register(await gateFor(h));
    expect(outcome).toMatchObject({ kind: "rejected", status: 503 });
    if (outcome.kind === "rejected") expect(outcome.reason).toMatch(/^channel-state-unavailable:/);
    expect(await h.channels.get(CHANNEL)).toBeUndefined();
  });

  it("rate-limits on-chain registration checks", async () => {
    stub.readOnChainChannel.mockRejectedValue(new Error("rpc down"));
    const gate = await gateFor(harness({ registrationLimit: { max: 2, windowMs: 60_000 } }));
    await register(gate);
    await register(gate);
    const third = await register(gate);
    expect(third).toMatchObject({ kind: "rejected", status: 429 });
    expect(stub.readOnChainChannel).toHaveBeenCalledTimes(2);
  });

  it("returns the plain 402 without a channel challenge when no channel is named", async () => {
    const outcome = await (await gateFor(harness()))({ method: "GET", url: "/data", headers: {} });
    expect(outcome.kind).toBe("payment-required");
    expect(stub.readOnChainChannel).not.toHaveBeenCalled();
  });
});

describe("mpp-channel vouchers through the gate (#173)", () => {
  it("settles vouchers with receipts anchored at increasing sequences and the on-chain payer", async () => {
    const h = harness();
    sdkAccepts(h.store);
    const signer = await Ed25519Signer.generate("channel-key");
    const gate = createPaywall(
      {
        amount: "1000",
        asset: USDC,
        payTo: RECIPIENT,
        network: "testnet",
        models: ["mpp-channel"],
      },
      {
        signer,
        facilitator: createMockFacilitator(),
        mppChannelHandler: createMppChannelHandler(h.options),
      },
    );
    await register(gate);

    const first = await pay(gate, voucher("1000", SIG(1)));
    const second = await pay(gate, voucher("2000", SIG(2)));

    expect(first.kind).toBe("settled");
    expect(second.kind).toBe("settled");
    if (first.kind !== "settled" || second.kind !== "settled") return;
    expect(first.receipt.receipt).toMatchObject({
      model: "mpp-channel",
      payer: FUNDER,
      amount: "1000",
      settlement: { kind: "channel-commitment", channelId: CHANNEL, sequence: 1 },
    });
    expect(second.receipt.receipt.settlement).toEqual({
      kind: "channel-commitment",
      channelId: CHANNEL,
      sequence: 2,
    });
    expect((await verifyReceipt(first.receipt, Ed25519Verifier.forSigner(signer))).valid).toBe(
      true,
    );
    expect(stub.mppx.verifyCredential).toHaveBeenCalledWith(expect.any(String), {
      request: { amount: "1000" },
      scope: "/data",
    });
    const record = await h.channels.get(CHANNEL);
    expect(record?.latest).toMatchObject({
      sequence: 2,
      cumulativeAmount: "2000",
      signature: SIG(2),
    });
    expect(record?.pending).toBeUndefined();
  });

  it("replays the last voucher's original receipt from the cache without calling the SDK again", async () => {
    const h = harness();
    sdkAccepts(h.store);
    const gate = await gateFor(h, { cache: createInMemorySettlementCache() });
    await register(gate);
    const credential = voucher("1000", SIG(1));
    const first = await pay(gate, credential);
    const again = await pay(gate, credential);
    expect(again.kind).toBe("settled");
    if (first.kind !== "settled" || again.kind !== "settled") return;
    expect(again.replayed).toBe(true);
    expect(again.receipt).toEqual(first.receipt);
    expect(stub.mppx.verifyCredential).toHaveBeenCalledTimes(1);
  });

  it("rejects a resent voucher once the cache no longer holds it, and never pays twice", async () => {
    const h = harness();
    sdkAccepts(h.store);
    const gate = await gateFor(h);
    await register(gate);
    await pay(gate, voucher("1000", SIG(1)));
    const again = await pay(gate, voucher("1000", SIG(1)));
    expect(again).toMatchObject({ kind: "rejected", status: 402 });
    if (again.kind === "rejected") expect(again.reason).toMatch(/^voucher-already-accepted:/);
    expect(stub.mppx.verifyCredential).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a different signature at the accepted cumulative", "1000", SIG(1, 9), "commitment-conflict"],
    ["a lower cumulative", "500", SIG(5), "stale-cumulative"],
    ["an increment above the price (prepayment)", "3000", SIG(3), "wrong-increment"],
  ])("rejects %s", async (_name, amount, signature, code) => {
    const h = harness();
    sdkAccepts(h.store);
    const gate = await gateFor(h);
    await register(gate);
    await pay(gate, voucher("1000", SIG(1)));
    const outcome = await pay(gate, voucher(amount, signature));
    expect(outcome).toMatchObject({ kind: "rejected", status: 402 });
    if (outcome.kind === "rejected") expect(outcome.reason.startsWith(`${code}:`)).toBe(true);
    expect(stub.mppx.verifyCredential).toHaveBeenCalledTimes(1);
  });

  it("rejects a first voucher whose increment is below the price", async () => {
    const h = harness();
    const gate = await gateFor(h);
    await register(gate);
    const outcome = await pay(gate, voucher("999", SIG(1)));
    if (outcome.kind !== "rejected") throw new Error("expected a rejection");
    expect(outcome.reason).toMatch(/^wrong-increment:/);
  });

  it("rejects a voucher for an unregistered channel", async () => {
    const gate = await gateFor(harness());
    const outcome = await pay(gate, voucher("1000", SIG(1)));
    expect(outcome).toMatchObject({ kind: "rejected", status: 402 });
    if (outcome.kind === "rejected") expect(outcome.reason).toMatch(/^channel-not-registered:/);
  });

  it("rejects a challenge this server did not issue, and one priced differently", async () => {
    const h = harness();
    const gate = await gateFor(h);
    await register(gate);
    const forged = await pay(gate, voucher("1000", SIG(1), { secretKey: "x".repeat(40) }));
    expect(forged).toMatchObject({
      kind: "rejected",
      reason: "mpp challenge was not issued by this server",
    });
    const repriced = await pay(gate, voucher("1", SIG(1), { challengeAmount: "1" }));
    expect(repriced).toMatchObject({
      kind: "rejected",
      reason: "mpp credential amount does not match the offer",
    });
    expect(stub.mppx.verifyCredential).not.toHaveBeenCalled();
  });

  it("rejects when the SDK refuses, records nothing, and keeps the channel usable", async () => {
    const h = harness();
    const gate = await gateFor(h);
    await register(gate);
    stub.mppx.verifyCredential.mockRejectedValueOnce(
      new StellarMppError("Commitment signature verification failed."),
    );
    const refused = await pay(gate, voucher("1000", SIG(1)));
    expect(refused).toMatchObject({ kind: "rejected", status: 402 });
    if (refused.kind === "rejected") {
      expect(refused.reason).toBe(
        "mpp-channel-rejected: Commitment signature verification failed.",
      );
    }
    const record = await h.channels.get(CHANNEL);
    expect(record?.latest).toBeUndefined();
    expect(record?.pending).toBeUndefined();

    sdkAccepts(h.store);
    const next = await pay(gate, voucher("1000", SIG(1, 1)));
    expect(next.kind).toBe("settled");
  });

  it("rejects a voucher on a settling or closed channel with a distinct reason", async () => {
    const h = harness();
    const gate = await gateFor(h);
    await register(gate);
    const record = (await h.channels.get(CHANNEL)) as ChannelRecord;
    await h.channels.compareAndSet(CHANNEL, record.version, {
      ...record,
      version: record.version + 1,
      status: "settling",
      settlement: { startedAt: 1, trigger: "service", retryable: false },
    });
    const settling = await pay(gate, voucher("1000", SIG(1)));
    if (settling.kind !== "rejected") throw new Error("expected a rejection");
    expect(settling.reason).toMatch(/^channel-settling:/);

    const frozen = (await h.channels.get(CHANNEL)) as ChannelRecord;
    await h.channels.compareAndSet(CHANNEL, frozen.version, {
      ...frozen,
      version: frozen.version + 1,
      status: "closed",
    });
    const closed = await pay(gate, voucher("1000", SIG(1)));
    if (closed.kind !== "rejected") throw new Error("expected a rejection");
    expect(closed.reason).toMatch(/^channel-closed:/);
    const challenge = await register(gate);
    expect(challenge).toMatchObject({ kind: "rejected", status: 402 });
  });

  it("returns 500 when the route accepts mpp-channel but no handler is configured", async () => {
    const gate = createPaywall(
      {
        amount: "1000",
        asset: USDC,
        payTo: RECIPIENT,
        network: "testnet",
        models: ["mpp-channel"],
      },
      { signer: await Ed25519Signer.generate("k"), facilitator: createMockFacilitator() },
    );
    const outcome = await pay(gate, voucher("1000", SIG(1)));
    expect(outcome).toEqual({
      kind: "rejected",
      status: 500,
      reason: "mpp-channel handler not configured",
    });
  });

  it("rejects a channel credential on a route that only accepts mpp-charge", async () => {
    const gate = createPaywall(
      { amount: "1000", asset: USDC, payTo: RECIPIENT, network: "testnet", models: ["mpp-charge"] },
      { signer: await Ed25519Signer.generate("k"), facilitator: createMockFacilitator() },
    );
    const outcome = await pay(gate, voucher("1000", SIG(1)));
    expect(outcome).toMatchObject({ kind: "rejected", status: 400 });
  });

  it("rejects a malformed channel payload with 400", async () => {
    const h = harness();
    const gate = await gateFor(h);
    const outcome = await pay(gate, voucher("1000", "not-hex"));
    expect(outcome).toMatchObject({ kind: "rejected", status: 400 });
  });
});

describe("mpp-channel concurrency (#173)", () => {
  it("never gives two vouchers the same sequence when they settle in parallel", async () => {
    const h = harness();
    sdkAccepts(h.store);
    const handler = createMppChannelHandler(h.options);
    const gate = await gateFor(h);
    await register(gate);

    const payments = ["1000", "2000", "3000", "4000"].map((amount, i) => {
      const parsed = parseMppChannelCredential(voucher(amount, SIG(i + 1)));
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.payment;
    });
    const results = await Promise.all(
      payments.map((payment) => handler.settle({ payment, offer, payer: FUNDER, nonce: "n" })),
    );
    const sequences = results.map((result) =>
      result.settled && result.settlement.kind === "channel-commitment"
        ? result.settlement.sequence
        : -1,
    );
    expect(sequences).toEqual([1, 2, 3, 4]);
    expect((await h.channels.get(CHANNEL))?.latest).toMatchObject({
      sequence: 4,
      cumulativeAmount: "4000",
    });
  });

  it("accepts only one of two conflicting vouchers sent at once", async () => {
    const h = harness();
    sdkAccepts(h.store);
    const gate = await gateFor(h);
    await register(gate);
    const outcomes = await Promise.all([
      pay(gate, voucher("1000", SIG(1, 1))),
      pay(gate, voucher("1000", SIG(1, 2))),
    ]);
    const settled = outcomes.filter((outcome) => outcome.kind === "settled");
    expect(settled).toHaveLength(1);
    expect(stub.mppx.verifyCredential).toHaveBeenCalledTimes(1);
  });
});

describe("agent close credentials (#174)", () => {
  it("rejects a close credential when no fee payer is configured", async () => {
    const h = harness();
    const gate = await gateFor(h);
    await register(gate);
    const outcome = await pay(gate, voucher("1000", SIG(1), { action: "close" }));
    if (outcome.kind !== "rejected") throw new Error("expected a rejection");
    expect(outcome.reason).toMatch(/^close-not-supported:/);
    expect(stub.mppx.verifyCredential).not.toHaveBeenCalled();
  });

  it("closes through the SDK, records the settlement, and returns a receipt", async () => {
    const h = harness({
      feePayer: { envelopeSigner: FEE_PAYER },
      feePayerKey: FEE_PAYER.publicKey(),
    });
    sdkAccepts(h.store, CLOSE_TX);
    stub.readChannelBalanceState
      .mockResolvedValueOnce({ balance: "10000", closeEffectiveAtLedger: null, currentLedger: 100 })
      .mockResolvedValueOnce({ balance: "0", closeEffectiveAtLedger: 101, currentLedger: 101 });
    const gate = await gateFor(h);
    await register(gate);
    await pay(gate, voucher("1000", SIG(1)));

    const outcome = await pay(gate, voucher("2000", SIG(2), { action: "close" }));
    expect(outcome.kind).toBe("settled");
    if (outcome.kind === "settled") {
      expect(outcome.receipt.receipt.settlement).toEqual({
        kind: "channel-commitment",
        channelId: CHANNEL,
        sequence: 2,
      });
    }
    const record = await h.channels.get(CHANNEL);
    expect(record?.status).toBe("closed");
    expect(record?.settlement).toMatchObject({
      trigger: "agent",
      record: {
        channelId: CHANNEL,
        settledAmount: "2000",
        returnedRemainder: "8000",
        txHash: CLOSE_TX,
      },
    });
    const after = await pay(gate, voucher("3000", SIG(3)));
    if (after.kind !== "rejected") throw new Error("expected a rejection");
    expect(after.reason).toMatch(/^channel-closed:/);
  });

  it("keeps the channel settling when the close fails, since it may have been broadcast", async () => {
    const h = harness({
      feePayer: { envelopeSigner: FEE_PAYER },
      feePayerKey: FEE_PAYER.publicKey(),
    });
    const handler = createMppChannelHandler(h.options);
    await register(await gateFor(h));
    stub.mppx.verifyCredential.mockRejectedValueOnce(new Error("Transaction polling timed out"));
    const parsed = parseMppChannelCredential(voucher("1000", SIG(1), { action: "close" }));
    if (!parsed.ok) throw new Error(parsed.reason);

    await expect(
      handler.settle({ payment: parsed.payment, offer, payer: FUNDER, nonce: "n" }),
    ).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    const record = await h.channels.get(CHANNEL);
    expect(record?.status).toBe("settling");
    expect(record?.pending).toBeUndefined();
    expect(record?.settlement?.lastError).toContain("polling timed out");
  });

  it("caps agent closes with the shared close rate guard", async () => {
    const guard = createInMemoryCloseRateGuard({ maxCloses: 1, windowMs: 60_000 });
    await guard.tryAcquire(FEE_PAYER.publicKey(), 1_700_000_000_000);
    const h = harness({
      feePayer: { envelopeSigner: FEE_PAYER },
      feePayerKey: FEE_PAYER.publicKey(),
      closeRateGuard: guard,
    });
    const gate = await gateFor(h);
    await register(gate);
    const outcome = await pay(gate, voucher("1000", SIG(1), { action: "close" }));
    expect(outcome).toMatchObject({ kind: "rejected", status: 429 });
    expect((await h.channels.get(CHANNEL))?.status).toBe("open");
  });
});

describe("reconcile after a crash (#173)", () => {
  async function crashedChannel(h: Harness): Promise<void> {
    await register(await gateFor(h));
    const record = (await h.channels.get(CHANNEL)) as ChannelRecord;
    await h.channels.compareAndSet(CHANNEL, record.version, {
      ...record,
      version: record.version + 1,
      pending: {
        sequence: 1,
        cumulativeAmount: "1000",
        signature: SIG(1),
        acceptedAt: 5,
        action: "voucher",
      },
    });
  }

  it("blocks the channel while a voucher is pending", async () => {
    const h = harness();
    await crashedChannel(h);
    const outcome = await pay(await gateFor(h), voucher("1000", SIG(1)));
    if (outcome.kind !== "rejected") throw new Error("expected a rejection");
    expect(outcome.reason).toMatch(/^channel-pending-reconciliation:/);
  });

  it("commits the pending voucher when the SDK had accepted it", async () => {
    const h = harness();
    await crashedChannel(h);
    await h.store.put(`stellar:channel:cumulative:${CHANNEL}`, { amount: "1000" });
    const handler = createMppChannelHandler(h.options);
    expect(await handler.reconcile(CHANNEL)).toEqual({ outcome: "committed", sequence: 1 });
    expect((await h.channels.get(CHANNEL))?.latest?.cumulativeAmount).toBe("1000");
  });

  it("discards the pending voucher when the SDK never accepted it", async () => {
    const h = harness();
    await crashedChannel(h);
    const handler = createMppChannelHandler(h.options);
    expect(await handler.reconcile(CHANNEL)).toEqual({ outcome: "discarded", sequence: 1 });
    const record = await h.channels.get(CHANNEL);
    expect(record?.pending).toBeUndefined();
    expect(record?.latest).toBeUndefined();
  });
});

describe("handler construction and stored records", () => {
  it("refuses a store without an atomic update and a fee payer without its key", () => {
    const h = harness();
    expect(() =>
      createMppChannelHandler({
        ...h.options,
        store: { ...Store.memory(), update: undefined } as never,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createMppChannelHandler({ ...h.options, feePayer: { envelopeSigner: FEE_PAYER } }),
    ).toThrow(/feePayerKey/);
  });

  it("treats a corrupt stored record as an error, not a default", async () => {
    const h = harness();
    const corrupt = { channelId: CHANNEL, version: 1, status: "open" } as unknown as ChannelRecord;
    await h.channels.compareAndSet(CHANNEL, 0, corrupt);
    const handler = createMppChannelHandler(h.options);
    const parsed = parseMppChannelCredential(voucher("1000", SIG(1)));
    if (!parsed.ok) throw new Error(parsed.reason);
    await expect(handler.verify({ payment: parsed.payment, offer })).rejects.toBeInstanceOf(
      TollwayError,
    );
  });
});

describe("parseMppChannelCredential", () => {
  it("reads the channel from the challenge and the voucher from the payload", () => {
    const credential = voucher("1000", SIG(1).toUpperCase());
    const parsed = parseMppChannelCredential(credential);
    expect(parsed).toEqual({
      ok: true,
      payment: {
        model: "mpp-channel",
        channelId: CHANNEL,
        cumulativeAmount: "1000",
        signature: SIG(1),
        action: "voucher",
        credential,
      },
    });
  });

  it("rejects garbage, a charge credential, and a zero amount", () => {
    expect(parseMppChannelCredential("Payment nope").ok).toBe(false);
    const charge = Credential.serialize({
      challenge: Challenge.from({
        secretKey: SECRET,
        realm: "tollway",
        method: "stellar",
        intent: "charge",
        request: { amount: "1", currency: USDC, recipient: RECIPIENT },
      }),
      payload: { type: "transaction", transaction: "AAAA" },
    });
    expect(parseMppChannelCredential(charge).ok).toBe(false);
    expect(parseMppChannelCredential(voucher("0", SIG(1))).ok).toBe(false);
  });
});

describe("commitmentKeyFromInstance", () => {
  const symbolKey = (name: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]);

  it("decodes DataKey::CommitmentKey bytes to a G... key", () => {
    const key = Keypair.random();
    const storage = [
      new xdr.ScMapEntry({ key: symbolKey("Token"), val: xdr.ScVal.scvU32(1) }),
      new xdr.ScMapEntry({
        key: symbolKey("CommitmentKey"),
        val: xdr.ScVal.scvBytes(key.rawPublicKey()),
      }),
    ];
    expect(commitmentKeyFromInstance(storage)).toBe(key.publicKey());
    expect(StrKey.isValidEd25519PublicKey(key.publicKey())).toBe(true);
  });

  it("returns null when the key is missing or the wrong size", () => {
    expect(commitmentKeyFromInstance([])).toBeNull();
    expect(
      commitmentKeyFromInstance([
        new xdr.ScMapEntry({
          key: symbolKey("CommitmentKey"),
          val: xdr.ScVal.scvBytes(Buffer.alloc(31)),
        }),
      ]),
    ).toBeNull();
  });
});

describe("freeze before close (#174)", () => {
  it("rejects a voucher that arrives while the service closes the channel, and closes with the frozen voucher", async () => {
    const h = harness();
    sdkAccepts(h.store);
    const gate = await gateFor(h);
    await register(gate);
    expect((await pay(gate, voucher("1000", SIG(1)))).kind).toBe("settled");

    let release = (): void => {};
    stub.close.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve(CLOSE_TX);
        }),
    );
    const settler = createChannelSettler({
      channels: h.channels,
      network: "testnet",
      feePayer: { envelopeSigner: FEE_PAYER },
      feePayerKey: FEE_PAYER.publicKey(),
      closeRateGuard: createInMemoryCloseRateGuard({ maxCloses: 10, windowMs: 60_000 }),
      clock: () => 1_700_000_000_000,
    });
    const closing = settler.settle(CHANNEL);
    await vi.waitFor(() => expect(stub.close).toHaveBeenCalledTimes(1));

    const late = await pay(gate, voucher("2000", SIG(2)));
    if (late.kind !== "rejected") throw new Error("expected a rejection");
    expect(late.reason).toMatch(/^channel-settling:/);

    release();
    const outcome = await closing;
    expect(outcome).toMatchObject({ status: "closed", record: { settledAmount: "1000" } });
    expect(stub.close).toHaveBeenCalledWith(expect.objectContaining({ amount: 1000n }));
    expect(stub.mppx.verifyCredential).toHaveBeenCalledTimes(1);
  });
});
