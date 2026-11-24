import type { SponsorBalanceReading } from "@vegaforge/tollway-core";
import { describe, expect, it, vi } from "vitest";
import { createObservabilityHub, isWebhookEvent, renderFeeSponsorMetrics } from "./index.js";

const current: SponsorBalanceReading = {
  account: "GSPONSOR",
  network: "testnet",
  at: "2026-11-24T00:00:00Z",
  stale: false,
  balanceStroops: "12345678901234567",
};

describe("sponsor observations", () => {
  it("groups every metric's metadata and samples into one uninterrupted block", () => {
    const hub = createObservabilityHub();
    hub.recordSponsorBalance(current);
    hub.recordSponsorBalance({ ...current, account: "SECOND" });
    const names = renderFeeSponsorMetrics(hub)
      .trimEnd()
      .split("\n")
      .map((line) => (line.startsWith("#") ? line.split(" ")[2] : line.split("{")[0]));
    expect(names.filter((name, index) => index === 0 || name !== names[index - 1])).toEqual([
      "tollway_fee_sponsor_balance_stroops",
      "tollway_fee_sponsor_balance_stale",
    ]);
  });

  it("keeps the latest reading per network and account and copies stored and returned values", () => {
    const hub = createObservabilityHub();
    const input = { ...current };
    hub.recordSponsorBalance(input);
    input.balanceStroops = "0";
    expect(hub.getSponsorReadings()).toEqual([current]);
    const result = hub.getSponsorReadings();
    if (result[0]) result[0].account = "mutated";
    hub.recordSponsorBalance({ ...current, network: "mainnet" });
    hub.recordSponsorBalance({
      account: current.account,
      network: "testnet",
      at: "2026-11-24T00:01:00Z",
      stale: true,
      error: "offline",
    });
    expect(hub.getSponsorReadings()).toEqual([
      {
        account: current.account,
        network: "testnet",
        at: "2026-11-24T00:01:00Z",
        stale: true,
        error: "offline",
      },
      { ...current, network: "mainnet" },
    ]);
  });

  it("delivers the low-balance event to handlers and signed webhook subscriptions", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }));
    const hub = createObservabilityHub({
      fetch: fetcher,
      webhooks: [
        {
          url: "https://alerts.example/sponsor",
          events: ["sponsor.low_balance"],
          secret: "test-secret",
        },
      ],
    });
    const handler = vi.fn();
    hub.on("sponsor.low_balance", handler);
    const report = await hub.emit({
      type: "sponsor.low_balance",
      at: current.at,
      data: {
        account: current.account,
        network: "testnet",
        balanceStroops: "1",
        thresholdStroops: "100",
        hysteresisStroops: "20",
      },
    });
    expect(isWebhookEvent("sponsor.low_balance")).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
    expect(report.failures).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("Tollway-Signature")).toBe(true);
  });

  it("renders gauge metadata, exact integer text, escaped labels and no balance sample for stale readings", () => {
    const hub = createObservabilityHub();
    hub.recordSponsorBalance({ ...current, account: 'G\\"\n' });
    hub.recordSponsorBalance({
      account: "STALE",
      network: "testnet",
      at: current.at,
      stale: true,
      error: "offline",
    });
    const text = renderFeeSponsorMetrics(hub);
    expect(text).toContain("# TYPE tollway_fee_sponsor_balance_stroops gauge\n");
    expect(text).toContain(
      'tollway_fee_sponsor_balance_stroops{account="G\\\\\\"\\n",network="testnet"} 12345678901234567\n',
    );
    expect(text).toContain(
      'tollway_fee_sponsor_balance_stale{account="STALE",network="testnet"} 1\n',
    );
    expect(text).toContain(
      'tollway_fee_sponsor_balance_stale{account="G\\\\\\"\\n",network="testnet"} 0\n',
    );
    expect(text).not.toContain('tollway_fee_sponsor_balance_stroops{account="STALE"');
  });
});
