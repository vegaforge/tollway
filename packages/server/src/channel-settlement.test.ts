import type * as ChannelServer from "@stellar/mpp/channel/server";
import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ChannelChain from "./channel-chain.js";
import {
  type ChannelSettlerOptions,
  createChannelSettler,
  hexSignatureBytes,
  validateSettlementTriggers,
} from "./channel-settlement.js";
import {
  type ChannelRecord,
  type ChannelStore,
  createInMemoryChannelStore,
  createInMemoryCloseRateGuard,
} from "./channel-store.js";

// `close` from @stellar/mpp and every chain read are stubbed at the module
// boundary, so nothing here reaches a network.
const stub = vi.hoisted(() => ({
  close: vi.fn(),
  readChannelBalanceState: vi.fn(),
}));

vi.mock("@stellar/mpp/channel/server", async (importOriginal) => {
  const actual = await importOriginal<typeof ChannelServer>();
  return { ...actual, close: stub.close };
});

vi.mock("./channel-chain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ChannelChain>();
  return { ...actual, readChannelBalanceState: stub.readChannelBalanceState };
});

const NOW = 1_700_000_000_000;
const CHANNEL_A = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const CHANNEL_B = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const FEE_PAYER = Keypair.random();
const SIG = "ab".repeat(64);
const TX = "f".repeat(64);

function record(channelId: string, overrides: Partial<ChannelRecord> = {}): ChannelRecord {
  return {
    channelId,
    network: "testnet",
    payer: "GFUNDER",
    payTo: "GRECIPIENT",
    asset: "CTOKEN",
    commitmentKey: "GKEY",
    refundWaitingPeriod: 20_000,
    registeredAt: NOW - 1_000,
    status: "open",
    version: 1,
    latest: { sequence: 3, cumulativeAmount: "3000", signature: SIG, acceptedAt: NOW - 500 },
    ...overrides,
  };
}

async function seed(store: ChannelStore, ...records: ChannelRecord[]): Promise<void> {
  for (const entry of records) {
    await store.compareAndSet(entry.channelId, 0, entry);
  }
}

function settlerOptions(channels: ChannelStore, overrides: Partial<ChannelSettlerOptions> = {}) {
  return {
    channels,
    network: "testnet" as const,
    feePayer: { envelopeSigner: FEE_PAYER },
    feePayerKey: FEE_PAYER.publicKey(),
    closeRateGuard: createInMemoryCloseRateGuard({ maxCloses: 100, windowMs: 60_000 }),
    clock: () => NOW,
    ...overrides,
  };
}

function chainState(balance: string, closeEffectiveAtLedger: number | null) {
  return { balance, closeEffectiveAtLedger, currentLedger: 200 };
}

beforeEach(() => {
  vi.clearAllMocks();
  stub.close.mockResolvedValue(TX);
  stub.readChannelBalanceState
    .mockResolvedValueOnce(chainState("10000", null))
    .mockResolvedValue(chainState("0", 200));
});

describe("createChannelSettler.settle (#174)", () => {
  it("closes with the latest voucher and records the settlement for reconciliation", async () => {
    const channels = createInMemoryChannelStore();
    await seed(channels, record(CHANNEL_A));
    const onClosed = vi.fn();
    const settler = createChannelSettler(
      settlerOptions(channels, { maxFeeBumpStroops: 50_000, onClosed }),
    );

    const outcome = await settler.settle(CHANNEL_A);

    const expected = {
      channelId: CHANNEL_A,
      settledAmount: "3000",
      returnedRemainder: "7000",
      txHash: TX,
    };
    expect(outcome).toEqual({ status: "closed", record: expected });
    expect(stub.close).toHaveBeenCalledWith({
      channel: CHANNEL_A,
      amount: 3000n,
      signature: hexSignatureBytes(SIG),
      feePayer: { envelopeSigner: FEE_PAYER },
      network: "stellar:testnet",
      maxFeeBumpStroops: 50_000,
    });
    const stored = await channels.get(CHANNEL_A);
    expect(stored?.status).toBe("closed");
    expect(stored?.settlement).toMatchObject({
      trigger: "service",
      balanceBefore: "10000",
      record: expected,
    });
    expect(onClosed).toHaveBeenCalledWith(expected);
  });

  it("never submits a channel that has no accepted voucher", async () => {
    const channels = createInMemoryChannelStore();
    const { latest: _none, ...empty } = record(CHANNEL_A);
    await seed(channels, empty);
    const outcome = await createChannelSettler(settlerOptions(channels)).settle(CHANNEL_A);
    expect(outcome).toEqual({ status: "skipped", reason: "no-accepted-voucher" });
    expect(stub.close).not.toHaveBeenCalled();
    expect((await channels.get(CHANNEL_A))?.status).toBe("open");
  });

  it("keeps the channel settling when close throws, and never reopens it", async () => {
    const channels = createInMemoryChannelStore();
    await seed(channels, record(CHANNEL_A));
    stub.close.mockRejectedValue(new Error("Transaction polling timed out"));
    const onCloseFailed = vi.fn();
    const settler = createChannelSettler(settlerOptions(channels, { onCloseFailed }));

    expect(await settler.settle(CHANNEL_A)).toEqual({
      status: "failed",
      error: "Transaction polling timed out",
    });
    const stored = await channels.get(CHANNEL_A);
    expect(stored?.status).toBe("settling");
    expect(stored?.settlement).toMatchObject({
      retryable: false,
      lastError: "Transaction polling timed out",
    });
    expect(onCloseFailed).toHaveBeenCalledTimes(1);

    // A second attempt does nothing until resolve() has read the chain.
    expect(await settler.settle(CHANNEL_A)).toEqual({ status: "skipped", reason: "in-progress" });
    expect(stub.close).toHaveBeenCalledTimes(1);
  });

  it("does not leak the fee payer secret into an error", async () => {
    const channels = createInMemoryChannelStore();
    await seed(channels, record(CHANNEL_A));
    stub.close.mockRejectedValue(new Error("send failed"));
    const outcome = await createChannelSettler(settlerOptions(channels)).settle(CHANNEL_A);
    expect(JSON.stringify(outcome)).not.toContain(FEE_PAYER.secret());
  });

  it("produces one close when two settlers race over a shared store", async () => {
    const channels = createInMemoryChannelStore();
    await seed(channels, record(CHANNEL_A));
    stub.readChannelBalanceState.mockReset();
    stub.readChannelBalanceState.mockResolvedValue(chainState("10000", null));
    let release = (): void => {};
    stub.close.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve(TX);
        }),
    );
    const first = createChannelSettler(settlerOptions(channels));
    const second = createChannelSettler(settlerOptions(channels));

    const running = Promise.all([first.settle(CHANNEL_A), second.settle(CHANNEL_A)]);
    await vi.waitFor(() => expect(stub.close).toHaveBeenCalledTimes(1));
    release();
    const outcomes = await running;

    expect(stub.close).toHaveBeenCalledTimes(1);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["closed", "skipped"]);
  });

  it("caps closes per fee payer per window", async () => {
    const channels = createInMemoryChannelStore();
    await seed(channels, record(CHANNEL_A), record(CHANNEL_B));
    const settler = createChannelSettler(
      settlerOptions(channels, {
        closeRateGuard: createInMemoryCloseRateGuard({ maxCloses: 1, windowMs: 60_000 }),
      }),
    );
    expect((await settler.settle(CHANNEL_A)).status).toBe("closed");
    expect(await settler.settle(CHANNEL_B)).toEqual({ status: "rate-limited" });
    expect(stub.close).toHaveBeenCalledTimes(1);
    expect((await channels.get(CHANNEL_B))?.status).toBe("open");
  });

  it("reports an already closed channel without sending anything", async () => {
    const channels = createInMemoryChannelStore();
    const settler = createChannelSettler(settlerOptions(channels));
    await seed(channels, record(CHANNEL_A));
    await settler.settle(CHANNEL_A);
    const again = await settler.settle(CHANNEL_A);
    expect(again.status).toBe("already-closed");
    expect(stub.close).toHaveBeenCalledTimes(1);
  });

  it("reports a chain that does not look closed afterwards", async () => {
    const channels = createInMemoryChannelStore();
    await seed(channels, record(CHANNEL_A));
    stub.readChannelBalanceState.mockReset();
    stub.readChannelBalanceState.mockResolvedValue(chainState("10000", null));
    const onCloseAnomaly = vi.fn();
    await createChannelSettler(settlerOptions(channels, { onCloseAnomaly })).settle(CHANNEL_A);
    expect(onCloseAnomaly).toHaveBeenCalledWith(expect.objectContaining({ channelId: CHANNEL_A }));
  });
});

describe("createChannelSettler.resolve (#174)", () => {
  async function failedClose(): Promise<{
    channels: ChannelStore;
    settler: ReturnType<typeof createChannelSettler>;
  }> {
    const channels = createInMemoryChannelStore();
    await seed(channels, record(CHANNEL_A));
    stub.close.mockRejectedValueOnce(new Error("timed out"));
    const settler = createChannelSettler(settlerOptions(channels));
    await settler.settle(CHANNEL_A);
    stub.readChannelBalanceState.mockReset();
    return { channels, settler };
  }

  it("marks the channel closed when the chain shows it closed and empty", async () => {
    const { channels, settler } = await failedClose();
    stub.readChannelBalanceState.mockResolvedValue(chainState("0", 150));
    expect(await settler.resolve(CHANNEL_A)).toEqual({ status: "closed" });
    expect((await channels.get(CHANNEL_A))?.status).toBe("closed");
  });

  it("allows a retry when the close never reached the chain, and the retry closes", async () => {
    const { channels, settler } = await failedClose();
    stub.readChannelBalanceState.mockResolvedValue(chainState("10000", null));
    expect(await settler.resolve(CHANNEL_A)).toEqual({
      status: "retryable",
      reason: "close-not-on-chain",
    });
    expect((await channels.get(CHANNEL_A))?.status).toBe("settling");

    stub.close.mockResolvedValueOnce(TX);
    expect((await settler.settle(CHANNEL_A)).status).toBe("closed");
  });

  it("allows a retry during a funder dispute", async () => {
    const { settler } = await failedClose();
    stub.readChannelBalanceState.mockResolvedValue(chainState("10000", 300));
    expect(await settler.resolve(CHANNEL_A)).toEqual({
      status: "retryable",
      reason: "funder-dispute",
    });
  });

  it("does nothing for a channel that is not settling", async () => {
    const channels = createInMemoryChannelStore();
    await seed(channels, record(CHANNEL_A));
    expect(await createChannelSettler(settlerOptions(channels)).resolve(CHANNEL_A)).toEqual({
      status: "not-settling",
    });
  });
});

describe("createChannelSettler.evaluate triggers (#174)", () => {
  async function evaluateWith(triggers: ChannelSettlerOptions["triggers"], entry: ChannelRecord) {
    const channels = createInMemoryChannelStore();
    await seed(channels, entry);
    return createChannelSettler(settlerOptions(channels, { triggers })).evaluate();
  }

  it("closes when the accrued cumulative reaches the amount", async () => {
    const report = await evaluateWith({ minCumulative: "3000" }, record(CHANNEL_A));
    expect(report.results).toEqual([
      { channelId: CHANNEL_A, outcome: expect.objectContaining({ status: "closed" }) },
    ]);
  });

  it("leaves a channel below the amount alone", async () => {
    const report = await evaluateWith({ minCumulative: "3001" }, record(CHANNEL_A));
    expect(report.results).toEqual([]);
    expect(stub.close).not.toHaveBeenCalled();
  });

  it("closes at a fraction of the on-chain balance using integer arithmetic", async () => {
    stub.readChannelBalanceState.mockReset();
    stub.readChannelBalanceState.mockResolvedValue(chainState("10000", null));
    // 3000 * 10 >= 10000 * 3 fires; at 3001 tenths it would not.
    expect(
      (
        await evaluateWith(
          { balanceFraction: { numerator: 3, denominator: 10 } },
          record(CHANNEL_A),
        )
      ).results,
    ).toHaveLength(1);
    vi.clearAllMocks();
    stub.readChannelBalanceState.mockResolvedValue(chainState("10001", null));
    expect(
      (
        await evaluateWith(
          { balanceFraction: { numerator: 3, denominator: 10 } },
          record(CHANNEL_A),
        )
      ).results,
    ).toHaveLength(0);
  });

  it("closes an idle channel", async () => {
    expect((await evaluateWith({ idleMs: 500 }, record(CHANNEL_A))).results).toHaveLength(1);
    vi.clearAllMocks();
    expect((await evaluateWith({ idleMs: 501 }, record(CHANNEL_A))).results).toHaveLength(0);
  });

  it("closes a channel past its maximum age", async () => {
    expect(
      (await evaluateWith({ maxChannelAgeMs: 1_000 }, record(CHANNEL_A))).results,
    ).toHaveLength(1);
    vi.clearAllMocks();
    expect(
      (await evaluateWith({ maxChannelAgeMs: 1_001 }, record(CHANNEL_A))).results,
    ).toHaveLength(0);
  });

  it("skips channels with no voucher, a pending voucher, or not open", async () => {
    const channels = createInMemoryChannelStore();
    const { latest: _none, ...empty } = record(CHANNEL_A);
    await seed(
      channels,
      empty,
      record(CHANNEL_B, {
        pending: {
          sequence: 4,
          cumulativeAmount: "4000",
          signature: SIG,
          acceptedAt: NOW,
          action: "voucher",
        },
      }),
    );
    const report = await createChannelSettler(
      settlerOptions(channels, { triggers: { idleMs: 1 } }),
    ).evaluate();
    expect(report).toEqual({ results: [], errors: [] });
    expect(stub.close).not.toHaveBeenCalled();
  });

  it("reports a channel whose trigger could not be checked", async () => {
    stub.readChannelBalanceState.mockReset();
    stub.readChannelBalanceState.mockRejectedValue(new Error("rpc down"));
    const report = await evaluateWith(
      { balanceFraction: { numerator: 1, denominator: 2 } },
      record(CHANNEL_A),
    );
    expect(report.errors).toEqual([{ channelId: CHANNEL_A, error: "rpc down" }]);
  });

  it.each([
    [{ minCumulative: "0" }],
    [{ minCumulative: "1.5" }],
    [{ balanceFraction: { numerator: 0, denominator: 10 } }],
    [{ balanceFraction: { numerator: 11, denominator: 10 } }],
    [{ balanceFraction: { numerator: 1.5, denominator: 10 } }],
    [{ idleMs: -1 }],
    [{ maxChannelAgeMs: 0 }],
  ])("throws at construction for invalid triggers %j", (triggers) => {
    expect(() => validateSettlementTriggers(triggers)).toThrow(TypeError);
    expect(() =>
      createChannelSettler(settlerOptions(createInMemoryChannelStore(), { triggers })),
    ).toThrow(TypeError);
  });
});

describe("createChannelSettler.start and stop", () => {
  it("runs passes on a timer and waits for a running pass on stop", async () => {
    vi.useFakeTimers();
    try {
      const channels = createInMemoryChannelStore();
      await seed(channels, record(CHANNEL_A));
      const settler = createChannelSettler(
        settlerOptions(channels, { triggers: { minCumulative: "1" } }),
      );
      settler.start({ intervalMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      await settler.stop();
      expect(stub.close).toHaveBeenCalledTimes(1);
      expect(() => settler.start({ intervalMs: 0 })).toThrow(TypeError);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("in-memory channel store and close rate guard", () => {
  it("writes only on the expected version", async () => {
    const store = createInMemoryChannelStore();
    const entry = record(CHANNEL_A);
    expect(await store.compareAndSet(CHANNEL_A, 0, entry)).toBe(true);
    expect(await store.compareAndSet(CHANNEL_A, 0, entry)).toBe(false);
    expect(await store.compareAndSet(CHANNEL_A, 1, { ...entry, version: 3 })).toBe(false);
    expect(
      await store.compareAndSet(CHANNEL_A, 1, { ...entry, version: 2, status: "settling" }),
    ).toBe(true);
    const read = await store.get(CHANNEL_A);
    if (read) read.status = "closed";
    expect((await store.get(CHANNEL_A))?.status).toBe("settling");
  });

  it("frees the guard once the window has passed", async () => {
    const guard = createInMemoryCloseRateGuard({ maxCloses: 1, windowMs: 100 });
    expect(await guard.tryAcquire("fee", 0)).toBe(true);
    expect(await guard.tryAcquire("fee", 99)).toBe(false);
    expect(await guard.tryAcquire("other", 99)).toBe(true);
    expect(await guard.tryAcquire("fee", 100)).toBe(true);
    expect(() => createInMemoryCloseRateGuard({ maxCloses: 0, windowMs: 1 })).toThrow();
  });
});
