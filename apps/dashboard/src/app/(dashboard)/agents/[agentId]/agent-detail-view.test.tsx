import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentDetail } from "@/data/agent-detail";

const useAgentDetailMock = vi.hoisted(() => vi.fn());

vi.mock("@/data/use-agent-detail", () => ({
  useAgentDetail: useAgentDetailMock,
}));

import { AgentDetailView } from "./agent-detail-view";

function detail(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: "agent-research-01",
    label: "research-bot",
    payerAddresses: ["GAGENT1", "GAGENT2"],
    series: [
      {
        bucket: "day",
        assets: [
          { asset: "USDC", points: [{ bucket: "2026-11-19", amount: "5000000000" }] },
          { asset: "XLM", points: [{ bucket: "2026-11-19", amount: "2000000000" }] },
        ],
      },
      {
        bucket: "hour",
        assets: [
          { asset: "USDC", points: [{ bucket: "2026-11-19T10", amount: "1000000" }] },
          { asset: "XLM", points: [{ bucket: "2026-11-19T11", amount: "700000" }] },
        ],
      },
    ],
    byModel: [
      { key: "x402", asset: "USDC", amount: "5000000000" },
      { key: "mpp-channel", asset: "XLM", amount: "2000000000" },
    ],
    byPayee: [{ key: "GSERVICE1", asset: "USDC", amount: "3000000000" }],
    policy: {
      document: {
        budgets: { daily: "5000000000", total: "10000000000" },
        perService: { GSERVICE1: { cap: "8000000000" } },
      },
      daily: {
        budget: "5000000000",
        usedByAsset: [
          { asset: "USDC", amount: "5000000000" },
          { asset: "XLM", amount: "2000000000" },
        ],
      },
      total: {
        budget: "10000000000",
        usedByAsset: [{ asset: "USDC", amount: "10000000000" }],
      },
      perService: [
        {
          payee: "GSERVICE1",
          cap: "8000000000",
          usedByAsset: [{ asset: "USDC", amount: "1000000000" }],
        },
      ],
    },
    recentStops: [
      {
        at: "2026-11-19T10:00:00.000Z",
        rule: "budget",
        detail: "daily budget exceeded for USDC",
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  useAgentDetailMock.mockReset();
});

describe("AgentDetailView", () => {
  it("renders a skeleton while loading", () => {
    useAgentDetailMock.mockReturnValue({ status: "loading" });

    render(<AgentDetailView agentId="agent-research-01" />);

    expect(screen.getByTestId("agent-detail-skeleton")).toBeInTheDocument();
  });

  it("renders an error surface without inventing data", () => {
    useAgentDetailMock.mockReturnValue({
      status: "error",
      error: new Error("hub offline"),
    });

    render(<AgentDetailView agentId="agent-research-01" />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/could not load agent detail/i);
    expect(alert).toHaveTextContent(/hub offline/i);
  });

  it("shows the identity including every payer address", () => {
    useAgentDetailMock.mockReturnValue({ status: "ready", detail: detail() });

    render(<AgentDetailView agentId="agent-research-01" />);

    expect(screen.getByText("research-bot")).toBeInTheDocument();
    expect(screen.getByText("agent-research-01")).toBeInTheDocument();
    expect(screen.getByText("GAGENT1")).toBeInTheDocument();
    expect(screen.getByText("GAGENT2")).toBeInTheDocument();
  });

  it("renders spend over time per asset without summing across assets", () => {
    useAgentDetailMock.mockReturnValue({ status: "ready", detail: detail() });

    render(<AgentDetailView agentId="agent-research-01" />);

    const usdc = screen.getByTestId("agent-series-USDC");
    const xlm = screen.getByTestId("agent-series-XLM");
    expect(usdc).toHaveTextContent("500.00 USDC");
    expect(xlm).toHaveTextContent("200.00 XLM");
    expect(screen.queryByText(/700\.00 USDC/)).not.toBeInTheDocument();
  });

  it("switches the series between hourly and daily buckets", () => {
    useAgentDetailMock.mockReturnValue({ status: "ready", detail: detail() });

    render(<AgentDetailView agentId="agent-research-01" />);

    expect(screen.getByTestId("agent-series-USDC")).toHaveTextContent("500.00 USDC");
    fireEvent.change(screen.getByLabelText(/bucket/i), { target: { value: "hour" } });
    expect(screen.getByTestId("agent-series-USDC")).toHaveTextContent("0.10 USDC");
  });

  it("shows model mix and services paid", () => {
    useAgentDetailMock.mockReturnValue({ status: "ready", detail: detail() });

    render(<AgentDetailView agentId="agent-research-01" />);

    expect(screen.getByText("x402")).toBeInTheDocument();
    expect(screen.getByText("mpp-channel")).toBeInTheDocument();
    expect(screen.getAllByText("GSERVICE1").length).toBeGreaterThan(0);
  });

  it("says so explicitly when the agent has no policy", () => {
    useAgentDetailMock.mockReturnValue({
      status: "ready",
      detail: detail({ policy: null }),
    });

    render(<AgentDetailView agentId="agent-research-01" />);

    expect(screen.getByText(/no policy governs this agent/i)).toBeInTheDocument();
    expect(screen.queryByTestId("budget-usage-daily")).not.toBeInTheDocument();
  });

  it("renders 0%, 100% and over-100% budget usage from bigint math", () => {
    const policy = detail().policy;
    if (policy === null) throw new Error("expected a policy in the fixture");

    useAgentDetailMock.mockReturnValue({
      status: "ready",
      detail: detail({
        policy: {
          ...policy,
          daily: {
            budget: "10000000000",
            usedByAsset: [{ asset: "USDC", amount: "0" }],
          },
          total: {
            budget: "10000000000",
            usedByAsset: [{ asset: "USDC", amount: "10000000000" }],
          },
          perService: [
            {
              payee: "GSERVICE1",
              cap: "1000000000",
              usedByAsset: [{ asset: "USDC", amount: "1200000000" }],
            },
          ],
        },
      }),
    });

    render(<AgentDetailView agentId="agent-research-01" />);

    expect(screen.getByTestId("budget-usage-daily")).toHaveTextContent("0.00%");
    expect(screen.getByTestId("budget-usage-total")).toHaveTextContent("100.00%");
    expect(screen.getByTestId("service-cap-GSERVICE1")).toHaveTextContent("120.00%");
  });

  it("labels the daily window as a UTC day and notes the budget unit ambiguity", () => {
    useAgentDetailMock.mockReturnValue({ status: "ready", detail: detail() });

    render(<AgentDetailView agentId="agent-research-01" />);

    expect(screen.getAllByText(/UTC day/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/unit ambiguity/i)).toBeInTheDocument();
  });

  it("lists recent policy stops and links to the filtered anomalies view", () => {
    useAgentDetailMock.mockReturnValue({ status: "ready", detail: detail() });

    render(<AgentDetailView agentId="agent-research-01" />);

    const stop = screen.getByTestId("policy-stop-0");
    expect(stop).toHaveTextContent("budget");
    expect(stop).toHaveTextContent("daily budget exceeded for USDC");
    expect(within(stop).getByRole("link")).toHaveAttribute(
      "href",
      "/anomalies?agent=agent-research-01",
    );
  });

  it("renders an explicit empty state when there are no policy stops", () => {
    useAgentDetailMock.mockReturnValue({
      status: "ready",
      detail: detail({ recentStops: [] }),
    });

    render(<AgentDetailView agentId="agent-research-01" />);

    expect(screen.getByText(/no recent policy stops/i)).toBeInTheDocument();
  });
});
