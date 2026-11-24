import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { type OverviewSnapshot, fetchOverview } from "@/data/overview";

const useOverviewMock = vi.hoisted(() => vi.fn());
const useAnomaliesMock = vi.hoisted(() => vi.fn());

vi.mock("@/data/use-overview", () => ({ useOverview: useOverviewMock }));
vi.mock("@/data/use-anomalies", () => ({ useAnomalies: useAnomaliesMock }));

import { OverviewView } from "./overview-view";

let snapshot: OverviewSnapshot;

const EMPTY_FEED = { status: "ready", page: { events: [], nextCursor: null } };

beforeAll(async () => {
  snapshot = await fetchOverview();
  useAnomaliesMock.mockReturnValue(EMPTY_FEED);
});

afterEach(() => {
  useOverviewMock.mockReset();
  useAnomaliesMock.mockReset();
  useAnomaliesMock.mockReturnValue(EMPTY_FEED);
});

/** The StatCard whose label is `label`: its label and value share a parent. */
function statCard(label: string): HTMLElement {
  const card = screen.getByText(label).parentElement;
  if (!card) throw new Error(`no stat card labelled ${label}`);
  return card;
}

describe("OverviewView", () => {
  it("renders a skeleton while loading", () => {
    useOverviewMock.mockReturnValue({ status: "loading" });

    render(<OverviewView />);

    expect(screen.getByTestId("overview-skeleton")).toBeInTheDocument();
  });

  it("renders an alert when the overview cannot load", () => {
    useOverviewMock.mockReturnValue({ status: "error", error: new Error("hub offline") });

    render(<OverviewView />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/could not load the overview/i);
    expect(alert).toHaveTextContent(/hub offline/i);
  });

  it("shows settled spend per asset, not one sum across assets", () => {
    useOverviewMock.mockReturnValue({ status: "ready", snapshot });

    render(<OverviewView />);

    expect(within(statCard("Settled spend")).getByText("13.482 USDC")).toBeInTheDocument();
    expect(within(statCard("Settled spend")).getByText("4.25 XLM")).toBeInTheDocument();
    // The two assets are never added: 13.482 + 4.25 would read 17.732.
    expect(within(statCard("Settled spend")).queryByText(/17\.7/)).not.toBeInTheDocument();
  });

  it("shows the settled count and the failure rate over attempted payments", () => {
    useOverviewMock.mockReturnValue({ status: "ready", snapshot });

    render(<OverviewView />);

    expect(within(statCard("Payments settled")).getByText("7")).toBeInTheDocument();
    // 3 failed of 10 attempted (7 settled + 3 failed). The skipped one is not attempted.
    expect(within(statCard("Failure rate")).getByText("30.00%")).toBeInTheDocument();
    expect(statCard("Failure rate")).toHaveTextContent("3 of 10 attempted payments failed");
  });

  it("says there were no payments rather than showing 0% when nothing was attempted", () => {
    const empty: OverviewSnapshot = {
      ...snapshot,
      spend: { ...snapshot.spend, byOutcome: { settled: 0, failed: 0, skipped: 2 } },
    };
    useOverviewMock.mockReturnValue({ status: "ready", snapshot: empty });

    render(<OverviewView />);

    expect(within(statCard("Failure rate")).getByText("No payments")).toBeInTheDocument();
  });

  it("shows remaining budget for open channels per asset", () => {
    useOverviewMock.mockReturnValue({ status: "ready", snapshot });

    render(<OverviewView />);

    // The count and the remaining line share the card's value, so check the text together.
    expect(statCard("Open channels")).toHaveTextContent(/Open channels2Remaining: 515\.00 USDC/);
    expect(within(statCard("Open channels")).getByText("515.00 USDC")).toBeInTheDocument();
  });

  it("shows a model with no spend as a zero share, not a gap", () => {
    useOverviewMock.mockReturnValue({ status: "ready", snapshot });

    render(<OverviewView />);

    expect(screen.getByTestId("model-mix-mpp-channel-USDC")).toHaveTextContent("93.46%");
    expect(screen.getByTestId("model-mix-mpp-channel-XLM")).toHaveTextContent("0.00%");
  });

  it("lists the five newest receipts with a link to the archive", () => {
    useOverviewMock.mockReturnValue({ status: "ready", snapshot });

    render(<OverviewView />);

    expect(screen.getByText("rcpt-x402-v2-stripe-02")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All receipts" })).toHaveAttribute(
      "href",
      "/receipts",
    );
  });

  it("shows the anomalies strip as nothing flagged when the feed is empty", () => {
    useOverviewMock.mockReturnValue({ status: "ready", snapshot });

    render(<OverviewView />);

    expect(screen.getByText("Nothing flagged.")).toBeInTheDocument();
  });
});
