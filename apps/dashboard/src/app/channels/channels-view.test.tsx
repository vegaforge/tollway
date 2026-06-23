import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenChannelRow } from "@/data/open-channels";

const useOpenChannelsMock = vi.hoisted(() => vi.fn());

vi.mock("@/data/use-open-channels", () => ({
  useOpenChannels: useOpenChannelsMock,
}));

import { ChannelsView } from "./channels-view";

function row(overrides: Partial<OpenChannelRow> = {}): OpenChannelRow {
  return {
    id: overrides.id ?? "ch-1",
    counterparty: overrides.counterparty ?? "GCOUNTER",
    deposit: overrides.deposit ?? "10000000000",
    committed: overrides.committed ?? "0",
    sequence: overrides.sequence ?? 0,
    status: overrides.status ?? "open",
    asset: overrides.asset ?? "USDC",
  };
}

afterEach(() => {
  useOpenChannelsMock.mockReset();
});

describe("ChannelsView", () => {
  it("renders the skeleton while loading", () => {
    useOpenChannelsMock.mockReturnValue({ status: "loading" });

    render(<ChannelsView />);

    expect(screen.getByTestId("channels-skeleton")).toBeInTheDocument();
  });

  it("renders an error surface when the data source rejects", () => {
    useOpenChannelsMock.mockReturnValue({
      status: "error",
      error: new Error("hub offline"),
    });

    render(<ChannelsView />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/could not load open channels/i);
    expect(alert).toHaveTextContent(/hub offline/i);
  });

  it("renders the empty message when there are no rows", () => {
    useOpenChannelsMock.mockReturnValue({ status: "ready", rows: [] });

    render(<ChannelsView />);

    expect(screen.getByText(/no open channels/i)).toBeInTheDocument();
  });

  it("renders a status pill for every ChannelStatus value", () => {
    useOpenChannelsMock.mockReturnValue({
      status: "ready",
      rows: [
        row({ id: "ch-a", status: "open" }),
        row({ id: "ch-b", status: "closing" }),
        row({ id: "ch-c", status: "closed" }),
        row({ id: "ch-d", status: "recovering" }),
        row({ id: "ch-e", status: "recovered" }),
      ],
    });

    render(<ChannelsView />);

    expect(screen.getByTestId("status-pill-open")).toBeInTheDocument();
    expect(screen.getByTestId("status-pill-closing")).toBeInTheDocument();
    expect(screen.getByTestId("status-pill-closed")).toBeInTheDocument();
    expect(screen.getByTestId("status-pill-recovering")).toBeInTheDocument();
    expect(screen.getByTestId("status-pill-recovered")).toBeInTheDocument();
  });

  it("flags an open channel as nearing close when drawdown crosses the threshold", () => {
    useOpenChannelsMock.mockReturnValue({
      status: "ready",
      rows: [
        row({ id: "ch-low", committed: "100000000", deposit: "10000000000", status: "open" }), // 1%
        row({ id: "ch-high", committed: "8500000000", deposit: "10000000000", status: "open" }), // 85%
      ],
    });

    render(<ChannelsView />);

    expect(screen.getByTestId("nearing-close-ch-high")).toBeInTheDocument();
    expect(screen.queryByTestId("nearing-close-ch-low")).not.toBeInTheDocument();

    const highRow = screen.getByTestId("channel-row-ch-high");
    expect(highRow).toHaveAttribute("data-nearing-close", "true");
    const lowRow = screen.getByTestId("channel-row-ch-low");
    expect(lowRow).not.toHaveAttribute("data-nearing-close");
  });

  it("does not flag closed or closing channels as nearing close even when drawdown is high", () => {
    useOpenChannelsMock.mockReturnValue({
      status: "ready",
      rows: [
        row({
          id: "ch-closing",
          committed: "9900000000",
          deposit: "10000000000",
          status: "closing",
        }),
        row({
          id: "ch-closed",
          committed: "10000000000",
          deposit: "10000000000",
          status: "closed",
        }),
      ],
    });

    render(<ChannelsView />);

    expect(screen.queryByTestId("nearing-close-ch-closing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("nearing-close-ch-closed")).not.toBeInTheDocument();
  });

  it("respects the nearingCloseThreshold prop", () => {
    useOpenChannelsMock.mockReturnValue({
      status: "ready",
      rows: [
        row({ id: "ch-half", committed: "5000000000", deposit: "10000000000", status: "open" }), // 50%
      ],
    });

    render(<ChannelsView nearingCloseThreshold={0.4} />);

    expect(screen.getByTestId("nearing-close-ch-half")).toBeInTheDocument();
  });

  it("sorts rows by drawdown ratio descending", () => {
    useOpenChannelsMock.mockReturnValue({
      status: "ready",
      rows: [
        row({
          id: "ch-low",
          counterparty: "G_LOW",
          committed: "100000000",
          deposit: "10000000000",
        }),
        row({
          id: "ch-high",
          counterparty: "G_HIGH",
          committed: "9000000000",
          deposit: "10000000000",
        }),
        row({
          id: "ch-mid",
          counterparty: "G_MID",
          committed: "5000000000",
          deposit: "10000000000",
        }),
      ],
    });

    render(<ChannelsView />);

    const [first, second, third, ...rest] = screen
      .getAllByRole("row")
      .filter((r) => r.querySelector("td"));
    expect(rest).toHaveLength(0);
    if (!first || !second || !third) throw new Error("expected three body rows");
    expect(within(first).getByText("G_HIGH")).toBeInTheDocument();
    expect(within(second).getByText("G_MID")).toBeInTheDocument();
    expect(within(third).getByText("G_LOW")).toBeInTheDocument();
  });

  it("computes totals StatCards using ready-state data only", () => {
    useOpenChannelsMock.mockReturnValue({
      status: "ready",
      rows: [
        row({ id: "ch-a", deposit: "20000000000", committed: "10000000000", status: "open" }),
        row({ id: "ch-b", deposit: "30000000000", committed: "15000000000", status: "closing" }),
      ],
    });

    render(<ChannelsView />);

    // "Open channels" appears as both a StatCard label and the Panel title,
    // so just confirm the headline aggregates resolved correctly.
    // Two rows with deposits 2,000 and 3,000 USDC = 5,000 total.
    // Committed 1,000 and 1,500 USDC = 2,500 total. One row has status open.
    expect(screen.getByText(/5,000\.00 USDC/)).toBeInTheDocument();
    expect(screen.getByText(/2,500\.00 USDC/)).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("shows placeholder dashes in headline StatCards while loading", () => {
    useOpenChannelsMock.mockReturnValue({ status: "loading" });

    render(<ChannelsView />);

    expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(3);
  });

  it("formats amounts with seven-decimal precision and the asset code", () => {
    useOpenChannelsMock.mockReturnValue({
      status: "ready",
      rows: [row({ committed: "12345600000", deposit: "50000000000" })],
    });

    render(<ChannelsView />);

    expect(screen.getAllByText(/1,234\.56 USDC/)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/5,000\.00 USDC/)[0]).toBeInTheDocument();
  });

  it("handles a deposit of 0 without throwing", () => {
    useOpenChannelsMock.mockReturnValue({
      status: "ready",
      rows: [row({ id: "ch-zero", deposit: "0", committed: "0" })],
    });

    expect(() => render(<ChannelsView />)).not.toThrow();
    expect(screen.queryByTestId("nearing-close-ch-zero")).not.toBeInTheDocument();
  });
});
