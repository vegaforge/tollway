import { Keypair } from "@stellar/stellar-sdk";
import type { SponsorBalanceReading, SponsorLowBalanceEvent } from "@vegaforge/tollway-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockFacilitator } from "./facilitator.js";
import { createHorizonSponsorBalanceReader, createSponsorMonitor } from "./sponsor-monitor.js";

const account = Keypair.random().publicKey();
const other = Keypair.random().publicKey();

function setup(values: Array<string | Error> = ["200"]) {
  const readings: SponsorBalanceReading[] = [];
  const events: SponsorLowBalanceEvent[] = [];
  const readBalance = vi.fn(async () => {
    const value = values.shift();
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error("test reader exhausted");
    return value;
  });
  const monitor = createSponsorMonitor({
    network: "testnet",
    accounts: [account],
    thresholdStroops: "100",
    hysteresisStroops: "20",
    intervalMs: 1000,
    readBalance,
    sink: {
      recordSponsorBalance(reading) {
        readings.push(reading);
      },
      emit(event) {
        events.push(event);
      },
    },
  });
  return { monitor, readings, events, readBalance };
}

afterEach(() => vi.useRealTimers());

describe("sponsor balance monitor", () => {
  it("alerts below the threshold once and re-arms strictly above threshold plus hysteresis", async () => {
    const { monitor, readings, events } = setup([
      "200",
      "100",
      "99",
      "80",
      "101",
      "120",
      "99",
      "121",
      "99",
    ]);
    for (let i = 0; i < 9; i++) await monitor.poll();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "sponsor.low_balance",
      data: {
        account,
        network: "testnet",
        balanceStroops: "99",
        thresholdStroops: "100",
        hysteresisStroops: "20",
      },
    });
    expect(readings).toHaveLength(9);
  });

  it("marks failures stale without carrying a previous balance or alerting, then recovers", async () => {
    const { monitor, readings, events } = setup(["200", new Error("Horizon unavailable"), "99"]);
    await monitor.poll();
    await monitor.poll();
    expect(readings[1]).toEqual({
      account,
      network: "testnet",
      at: expect.any(String),
      stale: true,
      error: "Horizon unavailable",
    });
    expect(readings[1]).not.toHaveProperty("balanceStroops");
    expect(events).toHaveLength(0);
    await monitor.poll();
    expect(readings[2]).toMatchObject({ stale: false, balanceStroops: "99" });
    expect(events).toHaveLength(1);
  });

  it("compares integer balances above Number.MAX_SAFE_INTEGER without rounding", async () => {
    const emit = vi.fn();
    const monitor = createSponsorMonitor({
      network: "testnet",
      accounts: [account],
      thresholdStroops: "9007199254740993",
      readBalance: async () => "9007199254740992",
      sink: { recordSponsorBalance: vi.fn(), emit },
    });
    await monitor.poll();
    expect(emit).toHaveBeenCalledOnce();
  });

  it.each([
    "1.5",
    "-1",
    "NaN",
    "",
    "1e7",
  ])("marks invalid injected reader result %j stale", async (value) => {
    const { monitor, readings, events } = setup([value]);
    await monitor.poll();
    expect(readings[0]).toMatchObject({ stale: true, error: expect.any(String) });
    expect(events).toHaveLength(0);
  });

  it("discovers only the configured network's signers, deduplicates them, and lets explicit accounts override discovery", async () => {
    const facilitator = createMockFacilitator();
    facilitator.supported = vi.fn(async () => ({
      kinds: [],
      extensions: [],
      signers: { "stellar:testnet": [account, account], "stellar:pubnet": [other] },
    }));
    const readBalance = vi.fn(async () => "200");
    const options = {
      network: "testnet" as const,
      thresholdStroops: "100",
      facilitator,
      readBalance,
      sink: { recordSponsorBalance: vi.fn(), emit: vi.fn() },
    };
    await createSponsorMonitor(options).poll();
    expect(readBalance).toHaveBeenCalledExactlyOnceWith(account, "testnet");
    readBalance.mockClear();
    vi.mocked(facilitator.supported).mockClear();
    await createSponsorMonitor({ ...options, accounts: [other, other] }).poll();
    expect(readBalance).toHaveBeenCalledExactlyOnceWith(other, "testnet");
    expect(facilitator.supported).not.toHaveBeenCalled();
  });

  it("requires explicit sponsors when the facilitator advertises no matching signer", async () => {
    const monitor = createSponsorMonitor({
      network: "testnet",
      thresholdStroops: "100",
      facilitator: createMockFacilitator(),
      sink: { recordSponsorBalance: vi.fn(), emit: vi.fn() },
    });
    await expect(monitor.poll()).rejects.toThrow(/explicit.*accounts/i);
  });

  it("reports one failed account without losing other account readings", async () => {
    const recordSponsorBalance = vi.fn();
    const emit = vi.fn();
    const monitor = createSponsorMonitor({
      network: "testnet",
      accounts: [account, other],
      thresholdStroops: "100",
      readBalance: async (id) => {
        if (id === account) throw new Error("missing");
        return "50";
      },
      sink: { recordSponsorBalance, emit },
    });
    const result = await monitor.poll();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ stale: true });
    expect(result[1]).toMatchObject({ stale: false });
    expect(emit).toHaveBeenCalledOnce();
  });

  it("never overlaps slow polls and stop waits for a read and prevents later polls", async () => {
    vi.useFakeTimers();
    let resolveRead: ((value: string) => void) | undefined;
    const readBalance = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const monitor = createSponsorMonitor({
      network: "testnet",
      accounts: [account],
      thresholdStroops: "100",
      intervalMs: 100,
      readBalance,
      sink: { recordSponsorBalance: vi.fn(), emit: vi.fn() },
    });
    const starting = monitor.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(readBalance).toHaveBeenCalledOnce();
    const polling = monitor.poll();
    const stopped = monitor.stop();
    resolveRead?.("200");
    await Promise.all([starting, polling, stopped]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(readBalance).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls on an unref'd timeout, supports restart and cancels the scheduled timeout", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(globalThis, "setTimeout");
    const { monitor, readBalance } = setup(["200", "200", "200"]);
    await monitor.start();
    const handle = timer.mock.results.at(-1)?.value as ReturnType<typeof setTimeout>;
    expect(handle.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(readBalance).toHaveBeenCalledTimes(2);
    await monitor.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(readBalance).toHaveBeenCalledTimes(2);
    await monitor.start();
    expect(readBalance).toHaveBeenCalledTimes(3);
    await monitor.stop();
    timer.mockRestore();
  });

  it("schedules polls where setTimeout returns a number, as on Workers, Deno and browsers", async () => {
    // Those runtimes have no Timeout object, so there is nothing to unref.
    const pending: Array<() => void> = [];
    vi.stubGlobal("setTimeout", (callback: () => void) => {
      pending.push(callback);
      return pending.length;
    });
    vi.stubGlobal("clearTimeout", () => {});
    try {
      const { monitor, readBalance } = setup(["200", "200"]);
      await monitor.start();
      expect(pending).toHaveLength(1);
      pending[0]?.();
      await vi.waitFor(() => expect(readBalance).toHaveBeenCalledTimes(2));
      await monitor.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { thresholdStroops: "-1" },
    { hysteresisStroops: "1.5" },
    { intervalMs: 0 },
    { intervalMs: Number.NaN },
    { accounts: ["bad"] },
  ])("rejects invalid configuration %j", (invalid) => {
    expect(() =>
      createSponsorMonitor({
        network: "testnet",
        accounts: [account],
        thresholdStroops: "100",
        sink: { recordSponsorBalance: vi.fn(), emit: vi.fn() },
        ...invalid,
      }),
    ).toThrow();
  });

  it("surfaces sink failures to the caller", async () => {
    const monitor = createSponsorMonitor({
      network: "testnet",
      accounts: [account],
      thresholdStroops: "100",
      readBalance: async () => "200",
      sink: {
        recordSponsorBalance() {
          throw new Error("store unavailable");
        },
        emit: vi.fn(),
      },
    });
    await expect(monitor.poll()).rejects.toThrow("store unavailable");
  });

  it("reports background sink failures and continues polling", async () => {
    vi.useFakeTimers();
    const recordSponsorBalance = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("store unavailable");
      })
      .mockImplementation(() => undefined);
    const onError = vi.fn();
    const monitor = createSponsorMonitor({
      network: "testnet",
      accounts: [account],
      thresholdStroops: "100",
      intervalMs: 100,
      readBalance: async () => "200",
      sink: { recordSponsorBalance, emit: vi.fn() },
      onError,
    });
    await monitor.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "store unavailable" }),
    );
    expect(recordSponsorBalance).toHaveBeenCalledTimes(3);
    await monitor.stop();
  });

  it("allows an explicit empty account list without discovery or reads", async () => {
    const facilitator = createMockFacilitator();
    const supported = vi.spyOn(facilitator, "supported");
    const readBalance = vi.fn();
    const monitor = createSponsorMonitor({
      network: "testnet",
      accounts: [],
      thresholdStroops: "100",
      facilitator,
      readBalance,
      sink: { recordSponsorBalance: vi.fn(), emit: vi.fn() },
    });
    await expect(monitor.poll()).resolves.toEqual([]);
    expect(supported).not.toHaveBeenCalled();
    expect(readBalance).not.toHaveBeenCalled();
  });
});

describe("Horizon balance boundary", () => {
  it.each([
    ["0.0000001", "1"],
    ["100.12", "1001200000"],
    ["922337203685.4775807", "9223372036854775807"],
  ])("reads native XLM %s as %s stroops", async (balance, expected) => {
    const loadAccount = vi.fn(async () => ({
      balances: [
        { asset_type: "credit_alphanum4", balance: "999" },
        { asset_type: "native", balance },
      ],
    }));
    const read = createHorizonSponsorBalanceReader(() => ({ loadAccount }));
    await expect(read(account, "testnet")).resolves.toBe(expected);
    expect(loadAccount).toHaveBeenCalledWith(account);
  });

  it.each([
    "1e7",
    "-1",
    "0.00000001",
    "",
    "NaN",
  ])("rejects malformed native balance %j", async (balance) => {
    const read = createHorizonSponsorBalanceReader(() => ({
      loadAccount: async () => ({ balances: [{ asset_type: "native", balance }] }),
    }));
    await expect(read(account, "testnet")).rejects.toThrow();
  });

  it.each([
    {},
    { balances: [] },
    { balances: [{ asset_type: "native", balance: 12 }] },
    {
      balances: [
        { asset_type: "native", balance: "1" },
        { asset_type: "native", balance: "2" },
      ],
    },
  ])("rejects missing or ambiguous native balance %j", async (response) => {
    const read = createHorizonSponsorBalanceReader(() => ({ loadAccount: async () => response }));
    await expect(read(account, "testnet")).rejects.toThrow();
  });
});
