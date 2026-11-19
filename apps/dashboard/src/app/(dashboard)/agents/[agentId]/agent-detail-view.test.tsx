import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { type AgentDetail, type AgentPolicyUsage, fetchAgentDetail } from "@/data/agent-detail";

const useAgentDetailMock = vi.hoisted(() => vi.fn());

vi.mock("@/data/use-agent-detail", () => ({
  useAgentDetail: useAgentDetailMock,
}));

import { AgentDetailView } from "./agent-detail-view";

// The fixture is the stub's own research-bot: two payer addresses, USDC and
// XLM, a failed payment, a policy, and two engine-produced stops.
let research: AgentDetail;

beforeAll(async () => {
  research = await fetchAgentDetail("agent-research-01", { bucket: "day", range: "7d" });
});

afterEach(() => {
  useAgentDetailMock.mockReset();
});

function ready(overrides: Partial<AgentDetail> = {}) {
  useAgentDetailMock.mockReturnValue({ status: "ready", detail: { ...research, ...overrides } });
  render(<AgentDetailView agentId="agent-research-01" />);
}

function policyWith(overrides: Partial<AgentPolicyUsage>): AgentPolicyUsage {
  if (research.policy === null) throw new Error("research-bot fixture has a policy");
  return { ...research.policy, ...overrides };
}

describe("AgentDetailView", () => {
  it("renders a skeleton while loading", () => {
    useAgentDetailMock.mockReturnValue({ status: "loading" });
    render(<AgentDetailView agentId="agent-research-01" />);

    expect(screen.getByTestId("agent-detail-skeleton")).toBeInTheDocument();
  });

  it("renders an error surface with a way back, without inventing data", () => {
    useAgentDetailMock.mockReturnValue({ status: "error", error: new Error("hub offline") });
    render(<AgentDetailView agentId="agent-research-01" />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/could not load agent detail/i);
    expect(alert).toHaveTextContent(/hub offline/i);
    expect(within(alert).getByRole("link", { name: /back to agents/i })).toHaveAttribute(
      "href",
      "/agents",
    );
  });

  it("shows the identity including every payer address", () => {
    ready();

    expect(screen.getByText("research-bot")).toBeInTheDocument();
    expect(screen.getByText("agent-research-01")).toBeInTheDocument();
    expect(screen.getByText("GAGENTRESEARCH1")).toBeInTheDocument();
    expect(screen.getByText("GAGENTRESEARCH2")).toBeInTheDocument();
  });

  it("renders one series per asset, settled only, never summed across assets", () => {
    ready();

    const usdc = screen.getByTestId("agent-series-USDC");
    const xlm = screen.getByTestId("agent-series-XLM");
    // 250 + 100 settled on the 19th; the failed 99.9999999 is not counted.
    expect(usdc).toHaveTextContent("2026-11-19350 USDC");
    expect(xlm).toHaveTextContent("2026-11-19200 XLM");
    expect(screen.queryByText(/550 USDC/)).not.toBeInTheDocument();
  });

  it("asks the data layer again when the bucket or range changes", () => {
    ready();

    expect(useAgentDetailMock).toHaveBeenLastCalledWith("agent-research-01", {
      bucket: "day",
      range: "7d",
    });
    fireEvent.change(screen.getByLabelText("Bucket"), { target: { value: "hour" } });
    expect(useAgentDetailMock).toHaveBeenLastCalledWith("agent-research-01", {
      bucket: "hour",
      range: "7d",
    });
    fireEvent.change(screen.getByLabelText("Range"), { target: { value: "30d" } });
    expect(useAgentDetailMock).toHaveBeenLastCalledWith("agent-research-01", {
      bucket: "hour",
      range: "30d",
    });
  });

  it("shows model mix and services paid per asset", () => {
    ready();

    expect(screen.getByRole("cell", { name: "x402" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "mpp-channel" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "GSERVICEBETA" })).toBeInTheDocument();
  });

  it("says so explicitly when the agent has no policy, with no budget bar", () => {
    ready({ policy: null });

    expect(screen.getByTestId("no-policy")).toHaveTextContent(/no policy governs this agent/i);
    expect(screen.queryByTestId("budget-usage-daily")).not.toBeInTheDocument();
  });

  it("renders 0%, 100% and over-100% usage from bigint math, with both units", () => {
    ready({
      policy: policyWith({
        daily: { limit: "10000000000", usedByAsset: [], windowStart: "2026-11-19T00:00:00.000Z" },
        total: {
          limit: "10000000000",
          usedByAsset: [{ asset: "USDC", amount: "10000000000" }],
          windowStart: "2026-11-01T00:00:00.000Z",
        },
        perService: [
          {
            payee: "GSERVICEALPHA",
            limit: "1000000000",
            usedByAsset: [{ asset: "USDC", amount: "1200000000" }],
            windowStart: "2026-11-01T00:00:00.000Z",
          },
        ],
      }),
    });

    expect(screen.getByTestId("budget-usage-daily")).toHaveTextContent("0.00%");
    const total = screen.getByTestId("budget-usage-total");
    expect(total).toHaveTextContent("100.00%");
    expect(total).toHaveTextContent("1,000 USDC of 1,000 USDC");
    expect(total).toHaveTextContent("10000000000 base units");
    expect(total).not.toHaveTextContent(/over limit/i);
    const cap = screen.getByTestId("service-cap-GSERVICEALPHA");
    expect(cap).toHaveTextContent("120.00%");
    expect(cap).toHaveTextContent(/over limit/i);
  });

  it("does not invent a percentage for a zero limit", () => {
    ready({
      policy: policyWith({
        daily: {
          limit: "0",
          usedByAsset: [{ asset: "USDC", amount: "5" }],
          windowStart: "2026-11-19T00:00:00.000Z",
        },
      }),
    });

    const daily = screen.getByTestId("budget-usage-daily");
    expect(daily).toHaveTextContent("limit is 0");
    expect(daily).toHaveTextContent(/over limit/i);
  });

  it("shows each asset against the same limit and a limit the policy leaves unset", () => {
    ready({
      policy: policyWith({
        total: { limit: null, usedByAsset: [], windowStart: "2026-11-01T00:00:00.000Z" },
      }),
    });

    const daily = screen.getByTestId("budget-usage-daily");
    expect(within(daily).getByTestId("usage-USDC")).toHaveTextContent("70.00%");
    expect(within(daily).getByTestId("usage-XLM")).toHaveTextContent("40.00%");
    expect(screen.getByTestId("budget-usage-total")).toHaveTextContent(/not set/i);
  });

  it("labels the daily window as a UTC day and explains the budget unit", () => {
    ready();

    expect(screen.getByTestId("budget-usage-daily")).toHaveTextContent(
      "UTC day 2026-11-19, 00:00 to 24:00 UTC",
    );
    expect(screen.getByText(/one number with no asset/i)).toBeInTheDocument();
  });

  it("lists policy stops with the rule and detail from the trace, and links to anomalies", () => {
    ready();

    const daily = screen.getByTestId("policy-stop-budget-daily");
    expect(daily).toHaveTextContent("budget-daily");
    expect(daily).toHaveTextContent("daily budget exceeded for USDC: 5500000000 > 5000000000");
    expect(screen.getByTestId("policy-stop-per-service")).toHaveTextContent(
      "per-service cap exceeded for GSERVICEBETA",
    );
    expect(screen.getByRole("link", { name: "View in anomalies" })).toHaveAttribute(
      "href",
      "/anomalies?agent=agent-research-01",
    );
  });

  it("renders an explicit empty state when there are no policy stops", () => {
    ready({ recentStops: [] });

    expect(screen.getByText(/no recent policy stops/i)).toBeInTheDocument();
  });

  it("renders an explicit empty state for a range with no settled spend", () => {
    ready({ series: [], byModel: [], byPayee: [] });

    expect(screen.getAllByText(/no settled spend in this range/i)).toHaveLength(3);
  });
});
