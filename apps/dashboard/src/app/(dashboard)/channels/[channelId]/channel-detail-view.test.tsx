import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { type ChannelDetail, fetchChannelDetail } from "@/data/channel-detail";

const useChannelDetailMock = vi.hoisted(() => vi.fn());

vi.mock("@/data/use-channel-detail", () => ({
  useChannelDetail: useChannelDetailMock,
}));

import { ChannelDetailView } from "./channel-detail-view";

const details: Record<string, ChannelDetail> = {};

beforeAll(async () => {
  for (const id of ["ch-openai-03", "ch-long-stream-05", "ch-drift-06"]) {
    const detail = await fetchChannelDetail(id);
    if (!detail) throw new Error(`stub channel ${id} is missing`);
    details[id] = detail;
  }
});

afterEach(() => {
  useChannelDetailMock.mockReset();
});

/** The StatCard whose label is `label`: its label and value share a parent. */
function statCard(label: string): HTMLElement {
  const card = screen.getByText(label).parentElement;
  if (!card) throw new Error(`no stat card labelled ${label}`);
  return card;
}

describe("ChannelDetailView", () => {
  it("renders the skeleton while loading", () => {
    useChannelDetailMock.mockReturnValue({ status: "loading" });

    render(<ChannelDetailView channelId="ch-openai-03" />);

    expect(screen.getByTestId("channel-detail-skeleton")).toBeInTheDocument();
  });

  it("renders an alert when the source rejects", () => {
    useChannelDetailMock.mockReturnValue({ status: "error", error: new Error("hub offline") });

    render(<ChannelDetailView channelId="ch-openai-03" />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/could not load this channel/i);
    expect(alert).toHaveTextContent(/hub offline/i);
  });

  it("renders a not-found state, not an error, for an unknown channel", () => {
    useChannelDetailMock.mockReturnValue({ status: "not-found" });

    render(<ChannelDetailView channelId="ch-missing" />);

    const notFound = screen.getByTestId("channel-not-found");
    expect(notFound).toHaveTextContent(/channel not found/i);
    expect(notFound).toHaveTextContent("ch-missing");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the header, the four headline numbers and a text summary of the chart", () => {
    useChannelDetailMock.mockReturnValue({ status: "ready", detail: details["ch-openai-03"] });

    render(<ChannelDetailView channelId="ch-openai-03" />);

    // 2,000,000,000 base units is 200 USDC at 7 decimals.
    expect(screen.getByTestId("status-pill-closing")).toBeInTheDocument();
    expect(within(statCard("Deposit")).getByText("200.00 USDC")).toBeInTheDocument();
    expect(within(statCard("Committed")).getByText("198.00 USDC")).toBeInTheDocument();
    expect(within(statCard("Remaining")).getByText("2.00 USDC")).toBeInTheDocument();
    expect(within(statCard("Drawdown")).getByText("99.00%")).toBeInTheDocument();
    // The chart's accessible description carries the same numbers as text.
    expect(
      screen.getByRole("img", { name: /cumulative commitments/i }),
    ).toHaveAccessibleDescription(
      /198\.00 USDC of 200\.00 USDC committed across 97 commitments/,
    );
  });

  it("pages a long commitment stream 25 at a time", () => {
    useChannelDetailMock.mockReturnValue({
      status: "ready",
      detail: details["ch-long-stream-05"],
    });

    render(<ChannelDetailView channelId="ch-long-stream-05" />);

    expect(screen.getByText("Page 1 of 12")).toBeInTheDocument();
    expect(screen.getByTestId("commitment-row-0")).toBeInTheDocument();
    expect(screen.queryByTestId("commitment-row-25")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("Page 2 of 12")).toBeInTheDocument();
    expect(screen.getByTestId("commitment-row-25")).toBeInTheDocument();
    expect(screen.queryByTestId("commitment-row-0")).not.toBeInTheDocument();
  });

  it("flags a sequence gap in the commitment table and names it", () => {
    useChannelDetailMock.mockReturnValue({ status: "ready", detail: details["ch-drift-06"] });

    render(<ChannelDetailView channelId="ch-drift-06" />);

    // Sequence 4 is missing, so the commitment after the gap is the flagged row.
    const flagged = screen.getByTestId("commitment-row-5");
    expect(flagged).toHaveAttribute("data-flagged", "true");
    expect(within(flagged).getByText("Sequence gap")).toBeInTheDocument();
    expect(screen.getByTestId("commitment-row-3")).not.toHaveAttribute("data-flagged");
  });

  it("lists each drift with its kind and detail", () => {
    useChannelDetailMock.mockReturnValue({ status: "ready", detail: details["ch-drift-06"] });

    render(<ChannelDetailView channelId="ch-drift-06" />);

    const drift = screen.getByTestId("reconcile-drift");
    expect(drift).toHaveTextContent("Reconciliation found 2 drifts");
    expect(drift).toHaveTextContent("under-settled");
    expect(drift).toHaveTextContent("Sequence 4 is missing from the stream.");
  });

  it("says a channel that was never reconciled is not ok", () => {
    useChannelDetailMock.mockReturnValue({ status: "ready", detail: details["ch-openai-03"] });

    render(<ChannelDetailView channelId="ch-openai-03" />);

    expect(screen.getByTestId("reconcile-never-reconciled")).toHaveTextContent(
      /not reconciled yet/i,
    );
    expect(screen.queryByTestId("reconcile-ok")).not.toBeInTheDocument();
  });

  it("reports a clean reconciliation as ok with its time", () => {
    useChannelDetailMock.mockReturnValue({
      status: "ready",
      detail: details["ch-long-stream-05"],
    });

    render(<ChannelDetailView channelId="ch-long-stream-05" />);

    expect(screen.getByTestId("reconcile-ok")).toHaveTextContent(/reconciled ok at/i);
  });
});
