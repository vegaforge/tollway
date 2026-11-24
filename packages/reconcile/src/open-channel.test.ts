import { describe, expect, it, vi } from "vitest";
import type { ChannelStateReader, OnChainChannelState } from "./chain.js";
import { createReconciler } from "./index.js";
import { type OpenChannelSnapshot, reconcileOpenChannel } from "./open-channel.js";

const CHANNEL = `C${"A".repeat(55)}`;
const TOKEN = `C${"B".repeat(55)}`;
const OTHER_TOKEN = `C${"C".repeat(55)}`;
const FUNDER = `G${"D".repeat(55)}`;
const RECIPIENT = `G${"E".repeat(55)}`;
const STRANGER = `G${"F".repeat(55)}`;

function snapshot(overrides: Partial<OpenChannelSnapshot> = {}): OpenChannelSnapshot {
  return {
    channelId: CHANNEL,
    network: "testnet",
    status: "open",
    counterparty: RECIPIENT,
    tokenContract: TOKEN,
    deposit: "10000",
    committed: "3000",
    funder: FUNDER,
    ...overrides,
  };
}

function state(overrides: Partial<OnChainChannelState> = {}): OnChainChannelState {
  return {
    balance: "10000",
    token: TOKEN,
    from: FUNDER,
    to: RECIPIENT,
    closeEffectiveAtLedger: null,
    currentLedger: 500,
    refundWaitingPeriod: 100,
    ...overrides,
  };
}

const kindsOf = (drift: ReturnType<typeof reconcileOpenChannel>) => drift.map((d) => d.kind);

describe("reconcileOpenChannel", () => {
  it("finds no drift when the contract matches the snapshot", () => {
    expect(reconcileOpenChannel(snapshot(), state())).toEqual([]);
  });

  describe("closed-on-chain", () => {
    it("reports a pending close with its effective ledger, the current ledger and ledgers left", () => {
      const drift = reconcileOpenChannel(
        snapshot(),
        state({ closeEffectiveAtLedger: 620, currentLedger: 500 }),
      );
      expect(drift).toEqual([
        {
          kind: "closed-on-chain",
          detail: expect.stringMatching(/ledger 620 \(current ledger 500, 120 ledgers left/),
        },
      ]);
    });

    it("says when the close has already taken effect", () => {
      const drift = reconcileOpenChannel(
        snapshot(),
        state({ closeEffectiveAtLedger: 450, currentLedger: 500 }),
      );
      expect(drift[0]?.detail).toContain("took effect at ledger 450 (current ledger 500)");
    });

    it("is not drift when the channel is already closing locally", () => {
      const drift = reconcileOpenChannel(
        snapshot({ status: "closing" }),
        state({ closeEffectiveAtLedger: 620 }),
      );
      expect(drift).toEqual([]);
    });
  });

  it("reports recipient-mismatch naming both addresses", () => {
    const drift = reconcileOpenChannel(snapshot(), state({ to: STRANGER }));
    expect(drift).toEqual([
      {
        kind: "recipient-mismatch",
        detail: `expected recipient ${RECIPIENT}, but the contract pays ${STRANGER}`,
      },
    ]);
  });

  it("reports funder-mismatch, not recipient-mismatch, for a wrong funder", () => {
    // Regression: the original code reported a wrong funder as recipient-mismatch.
    const drift = reconcileOpenChannel(snapshot(), state({ from: STRANGER }));
    expect(kindsOf(drift)).toEqual(["funder-mismatch"]);
    expect(drift[0]?.detail).toContain(`expected funder ${FUNDER}`);
  });

  it("does not check the funder when the snapshot does not name one", () => {
    const drift = reconcileOpenChannel(snapshot({ funder: undefined }), state({ from: STRANGER }));
    expect(drift).toEqual([]);
  });

  it("reports token-mismatch naming both contracts", () => {
    const drift = reconcileOpenChannel(snapshot(), state({ token: OTHER_TOKEN }));
    expect(drift).toEqual([
      {
        kind: "token-mismatch",
        detail: `expected token contract ${TOKEN}, but the contract holds ${OTHER_TOKEN}`,
      },
    ]);
  });

  describe("balance-mismatch", () => {
    it("reports a balance below the deposit minus everything committed", () => {
      const drift = reconcileOpenChannel(snapshot(), state({ balance: "6500" }));
      expect(drift).toEqual([
        {
          kind: "balance-mismatch",
          detail: expect.stringContaining(
            "at least 7000 (deposit 10000 minus committed 3000), but it holds 6500; 500 left",
          ),
        },
      ]);
    });

    it("is not drift after a withdraw within the committed amount", () => {
      // Regression: the original code flagged a legitimate settle that
      // Tollway had not observed yet.
      expect(reconcileOpenChannel(snapshot(), state({ balance: "7000" }))).toEqual([]);
    });

    it("is not drift when a top-up raised the balance above the deposit", () => {
      // Regression: top_up and direct transfers raise the balance without an
      // event, so a higher balance proves nothing.
      expect(reconcileOpenChannel(snapshot(), state({ balance: "15000" }))).toEqual([]);
    });

    it("is not checked once a close is pending, since the funder may refund", () => {
      const drift = reconcileOpenChannel(
        snapshot({ status: "closing" }),
        state({ balance: "0", closeEffectiveAtLedger: 400 }),
      );
      expect(drift).toEqual([]);
    });

    it("compares as bigint beyond Number precision", () => {
      const drift = reconcileOpenChannel(
        snapshot({ deposit: "9007199254740993", committed: "0" }),
        state({ balance: "9007199254740992" }),
      );
      expect(kindsOf(drift)).toEqual(["balance-mismatch"]);
    });
  });

  it("reports malformed snapshot amounts and skips the balance rule", () => {
    const drift = reconcileOpenChannel(snapshot({ deposit: "1e4" }), state({ balance: "0" }));
    expect(kindsOf(drift)).toEqual(["malformed-record"]);
  });

  it("reports every independent drift at once", () => {
    const drift = reconcileOpenChannel(
      snapshot(),
      state({ to: STRANGER, token: OTHER_TOKEN, closeEffectiveAtLedger: 900 }),
    );
    expect(kindsOf(drift)).toEqual(["closed-on-chain", "recipient-mismatch", "token-mismatch"]);
  });
});

describe("checkOpenChannel", () => {
  function reader(result: OnChainChannelState | Error | unknown): ChannelStateReader {
    return {
      getChannelState: vi.fn(async () => {
        if (result instanceof Error) throw result;
        return result as OnChainChannelState;
      }),
    };
  }

  it("reads the state for the snapshot's channel and network", async () => {
    const channels = reader(state());
    const result = await createReconciler({ channels }).checkOpenChannel(snapshot());
    expect(result).toEqual({
      status: "ok",
      ok: true,
      subject: { kind: "channel", channelId: CHANNEL },
    });
    expect(channels.getChannelState).toHaveBeenCalledWith(CHANNEL, "testnet");
  });

  it("returns drift from the comparison", async () => {
    const result = await createReconciler({
      channels: reader(state({ to: STRANGER })),
    }).checkOpenChannel(snapshot());
    expect(result.status === "drift" ? result.drift.map((d) => d.kind) : []).toEqual([
      "recipient-mismatch",
    ]);
  });

  it("is retryable, never drift, when the read fails", async () => {
    // Regression: the original code let the RPC error escape.
    const result = await createReconciler({
      channels: reader(new Error("simulate balance timed out after 10000ms")),
    }).checkOpenChannel(snapshot());
    expect(result).toEqual({
      status: "retryable",
      ok: false,
      subject: { kind: "channel", channelId: CHANNEL },
      reason: expect.stringContaining("timed out"),
    });
  });

  it("is retryable when the reader returns a malformed state", async () => {
    const result = await createReconciler({
      channels: reader({ ...state(), balance: 10000n }),
    }).checkOpenChannel(snapshot());
    expect(result.status).toBe("retryable");
    if (result.status === "retryable") expect(result.reason).toContain("balance");
  });

  it("throws when no reader is configured", async () => {
    await expect(createReconciler().checkOpenChannel(snapshot())).rejects.toThrow(TypeError);
  });
});
