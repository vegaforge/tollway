import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { createReconciler } from "./index.js";
import {
  type OnChainChannelState,
  type OpenChannelRecord,
  startOpenChannelWatcher,
} from "./open-channel.js";

const FUNDER = Keypair.random().publicKey();
const COUNTERPARTY = Keypair.random().publicKey();
const ISSUER = Keypair.random().publicKey();
const CHANNEL_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const USDC_CONTRACT = new Asset("USDC", ISSUER).contractId(Networks.TESTNET);

function makeChannel(overrides?: Partial<OpenChannelRecord>): OpenChannelRecord {
  return {
    id: CHANNEL_ID,
    counterparty: COUNTERPARTY,
    asset: `USDC:${ISSUER}`,
    deposit: "10000",
    committed: "3000",
    status: "open",
    network: "testnet",
    ...overrides,
  };
}

function makeChainState(overrides?: Partial<OnChainChannelState>): OnChainChannelState {
  return {
    balance: 10000n,
    refundWaitingPeriod: 100,
    token: USDC_CONTRACT,
    from: FUNDER,
    to: COUNTERPARTY,
    closeEffectiveAtLedger: null,
    currentLedger: 500,
    ...overrides,
  };
}

describe("reconcileOpenChannel", () => {
  const reconciler = createReconciler();

  it("returns ok when open channel matches on-chain state and commitment stream", async () => {
    const res = await reconciler.reconcileOpenChannel(
      makeChannel(),
      [
        { channelId: CHANNEL_ID, sequence: 0, cumulativeAmount: "1000" },
        { channelId: CHANNEL_ID, sequence: 1, cumulativeAmount: "3000" },
      ],
      {
        funder: FUNDER,
        readChannelState: vi.fn().mockResolvedValue(makeChainState()),
      },
    );

    expect(res).toEqual({ ok: true, channelId: CHANNEL_ID });
  });

  it("accounts for observed withdrawals when checking on-chain balance", async () => {
    const res = await reconciler.reconcileOpenChannel(
      makeChannel({ deposit: "10000", committed: "4000" }),
      [{ channelId: CHANNEL_ID, sequence: 0, cumulativeAmount: "4000" }],
      {
        observedWithdrawn: "2500",
        readChannelState: vi.fn().mockResolvedValue(makeChainState({ balance: 7500n })),
      },
    );

    expect(res).toEqual({ ok: true, channelId: CHANNEL_ID });
  });

  it("flags unexpected-close when closeEffectiveAtLedger is set on an open channel", async () => {
    const res = await reconciler.reconcileOpenChannel(makeChannel(), [], {
      readChannelState: vi.fn().mockResolvedValue(makeChainState({ closeEffectiveAtLedger: 550 })),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.drift.map((d) => d.kind)).toContain("unexpected-close");
    }
  });

  it("flags recipient-mismatch when on-chain recipient or funder differs", async () => {
    const wrongRecipient = Keypair.random().publicKey();
    const wrongFunder = Keypair.random().publicKey();

    const res = await reconciler.reconcileOpenChannel(makeChannel(), [], {
      funder: FUNDER,
      readChannelState: vi
        .fn()
        .mockResolvedValue(makeChainState({ to: wrongRecipient, from: wrongFunder })),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.drift.filter((d) => d.kind === "recipient-mismatch")).toHaveLength(2);
    }
  });

  it("flags token-mismatch when on-chain token differs from channel asset", async () => {
    const otherToken = new Asset("EURC", ISSUER).contractId(Networks.TESTNET);

    const res = await reconciler.reconcileOpenChannel(makeChannel(), [], {
      readChannelState: vi.fn().mockResolvedValue(makeChainState({ token: otherToken })),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.drift.map((d) => d.kind)).toContain("token-mismatch");
    }
  });

  it("flags balance-mismatch when on-chain balance does not match deposit minus withdrawals", async () => {
    const res = await reconciler.reconcileOpenChannel(makeChannel({ deposit: "10000" }), [], {
      observedWithdrawn: "1000",
      readChannelState: vi.fn().mockResolvedValue(makeChainState({ balance: 5000n })),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.drift.map((d) => d.kind)).toContain("balance-mismatch");
    }
  });

  it("flags commitment stream anomalies alongside on-chain drift", async () => {
    const res = await reconciler.reconcileOpenChannel(
      makeChannel({ deposit: "1000", committed: "1500" }),
      [
        { channelId: CHANNEL_ID, sequence: 0, cumulativeAmount: "1500" },
        { channelId: CHANNEL_ID, sequence: 2, cumulativeAmount: "1200" },
      ],
      {
        readChannelState: vi.fn().mockResolvedValue(makeChainState({ balance: 1000n })),
      },
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      const kinds = res.drift.map((d) => d.kind);
      expect(kinds).toContain("sequence-gap");
      expect(kinds).toContain("non-monotonic-cumulative");
      expect(kinds).toContain("balance-mismatch");
    }
  });
});

describe("startOpenChannelWatcher", () => {
  it("tracks withdrawals from watchChannel events and calls onDrift on mismatch", async () => {
    let capturedOnEvent: ((event: unknown) => Promise<void>) | undefined;
    const stopMock = vi.fn();
    const onDrift = vi.fn();

    const stop = startOpenChannelWatcher({
      channel: makeChannel({ deposit: "10000" }),
      getCommitments: () => [{ channelId: CHANNEL_ID, sequence: 0, cumulativeAmount: "2000" }],
      onDrift,
      readChannelState: vi
        .fn()
        // After 2000 withdraw, expected balance is 8000, but chain says 7000 -> drift!
        .mockResolvedValue(makeChainState({ balance: 7000n })),
      watch: (opts) => {
        capturedOnEvent = opts.onEvent as (event: unknown) => Promise<void>;
        return stopMock;
      },
    });

    expect(capturedOnEvent).toBeDefined();
    await capturedOnEvent?.({ type: "withdraw", amount: 2000n, ledger: 505 });

    expect(onDrift).toHaveBeenCalledTimes(1);
    const drifts = onDrift.mock.calls[0]?.[0] as Array<{ kind: string }>;
    expect(drifts.map((d) => d.kind)).toContain("balance-mismatch");

    stop();
    expect(stopMock).toHaveBeenCalledTimes(1);
  });
});
