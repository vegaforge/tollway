import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentSpendRow } from "@/data/agent-spend";

const useAgentSpendMock = vi.hoisted(() => vi.fn());

vi.mock("@/data/use-agent-spend", () => ({
  useAgentSpend: useAgentSpendMock,
}));

import { AgentsView } from "./agents-view";

function row(
  id: string,
  label: string,
  spend: string,
  budget: string = "10000000000",
): AgentSpendRow {
  return { id, label, spend, budget, asset: "USDC" };
}

afterEach(() => {
  useAgentSpendMock.mockReset();
});

describe("AgentsView", () => {
  it("renders the skeleton while loading", () => {
    useAgentSpendMock.mockReturnValue({ status: "loading" });

    render(<AgentsView />);

    expect(screen.getByTestId("agents-skeleton")).toBeInTheDocument();
  });

  it("renders an error surface when the data source rejects", () => {
    useAgentSpendMock.mockReturnValue({
      status: "error",
      error: new Error("hub offline"),
    });

    render(<AgentsView />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/could not load agent spend/i);
    expect(alert).toHaveTextContent(/hub offline/i);
  });

  it("renders the empty state when there are no rows", () => {
    useAgentSpendMock.mockReturnValue({ status: "ready", rows: [] });

    render(<AgentsView />);

    expect(screen.getByText(/no agents have spent yet/i)).toBeInTheDocument();
  });

  it("sorts rows by spend descending by default", () => {
    useAgentSpendMock.mockReturnValue({
      status: "ready",
      rows: [
        row("a", "low-spender", "100000000"),
        row("b", "top-spender", "900000000"),
        row("c", "mid-spender", "500000000"),
      ],
    });

    render(<AgentsView />);

    const bodyRows = screen
      .getAllByRole("row")
      .filter((r) => within(r).queryByRole("button") === null && r.querySelector("td"));
    expect(bodyRows).toHaveLength(3);
    expect(bodyRows[0]).toHaveTextContent("top-spender");
    expect(bodyRows[1]).toHaveTextContent("mid-spender");
    expect(bodyRows[2]).toHaveTextContent("low-spender");
  });

  it("flips to ascending when the Spend header is clicked and updates aria-sort", async () => {
    useAgentSpendMock.mockReturnValue({
      status: "ready",
      rows: [
        row("a", "low-spender", "100000000"),
        row("b", "top-spender", "900000000"),
        row("c", "mid-spender", "500000000"),
      ],
    });

    render(<AgentsView />);

    const spendHeader = screen
      .getAllByRole("columnheader")
      .find((th) => within(th).queryByRole("button", { name: /spend/i }));
    if (!spendHeader) throw new Error("spend header not found");
    expect(spendHeader).toHaveAttribute("aria-sort", "descending");

    fireEvent.click(within(spendHeader).getByRole("button", { name: /spend/i }));

    await waitFor(() => {
      expect(spendHeader).toHaveAttribute("aria-sort", "ascending");
    });

    const bodyRows = screen
      .getAllByRole("row")
      .filter((r) => within(r).queryByRole("button") === null && r.querySelector("td"));
    expect(bodyRows[0]).toHaveTextContent("low-spender");
    expect(bodyRows[2]).toHaveTextContent("top-spender");
  });

  it("formats amounts using the asset code and seven-decimal precision", () => {
    useAgentSpendMock.mockReturnValue({
      status: "ready",
      rows: [row("a", "research-bot", "12345600000", "50000000000")],
    });

    render(<AgentsView />);

    expect(screen.getAllByText(/1,234\.56 USDC/)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/5,000\.00 USDC/)[0]).toBeInTheDocument();
  });

  it("shows totals in the StatCards using ready-state data only", () => {
    useAgentSpendMock.mockReturnValue({
      status: "ready",
      rows: [row("a", "agent-1", "20000000000"), row("b", "agent-2", "30000000000")],
    });

    render(<AgentsView />);

    expect(screen.getByText(/total spend/i)).toBeInTheDocument();
    expect(screen.getByText(/5,000\.00 USDC/)).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows a placeholder dash in headline StatCards while loading", () => {
    useAgentSpendMock.mockReturnValue({ status: "loading" });

    render(<AgentsView />);

    expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(3);
  });
});
