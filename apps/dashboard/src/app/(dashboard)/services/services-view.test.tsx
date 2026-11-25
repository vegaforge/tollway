import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServiceModelStats, ServiceRevenueRow } from "@/data/service-revenue";

const useServiceRevenueMock = vi.hoisted(() => vi.fn());

vi.mock("@/data/use-service-revenue", () => ({
  useServiceRevenue: useServiceRevenueMock,
}));

import { ServicesView } from "./services-view";

function models(
  counts: Partial<Record<ServiceModelStats["model"], [number, number | null]>>,
): ServiceModelStats[] {
  return (["x402", "mpp-charge", "mpp-channel"] as const).map((model) => {
    const [count, avgLatencyMs] = counts[model] ?? [0, null];
    return { model, count, avgLatencyMs };
  });
}

function row(
  label: string,
  revenue: string,
  count: number,
  overrides: Partial<ServiceRevenueRow> = {},
): ServiceRevenueRow {
  const payee = `G${label.toUpperCase()}`;
  return {
    id: `${payee}:USDC`,
    payee,
    label,
    asset: "USDC",
    revenue,
    count,
    models: models({ x402: [count, 100] }),
    ...overrides,
  };
}

/** Body rows, in rendered order. */
function bodyRows(): HTMLElement[] {
  const table = screen.getByRole("table");
  const [, body] = within(table).getAllByRole("rowgroup");
  if (!body) throw new Error("table body not found");
  return within(body).getAllByRole("row");
}

function header(name: RegExp): HTMLElement {
  const found = screen
    .getAllByRole("columnheader")
    .find((th) => within(th).queryByRole("button", { name }));
  if (!found) throw new Error(`header ${name} not found`);
  return found;
}

afterEach(() => {
  useServiceRevenueMock.mockReset();
});

describe("ServicesView", () => {
  it("renders the skeleton while loading", () => {
    useServiceRevenueMock.mockReturnValue({ status: "loading" });

    render(<ServicesView />);

    expect(screen.getByTestId("services-skeleton")).toBeInTheDocument();
    expect(screen.getAllByText("-").length).toBeGreaterThanOrEqual(3);
  });

  it("renders an error surface when the data source rejects", () => {
    useServiceRevenueMock.mockReturnValue({ status: "error", error: new Error("hub offline") });

    render(<ServicesView />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/could not load service revenue/i);
    expect(alert).toHaveTextContent(/hub offline/i);
  });

  it("renders the shared empty state when no service has settled", () => {
    useServiceRevenueMock.mockReturnValue({ status: "ready", rows: [] });

    render(<ServicesView />);

    expect(screen.getByText(/no service has settled a payment yet/i)).toBeInTheDocument();
    expect(screen.getByText(/summarize\(\{ payee \}\)/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("renders one row per payee and asset, sorted by revenue descending", () => {
    useServiceRevenueMock.mockReturnValue({
      status: "ready",
      rows: [row("low", "1000000", 9), row("top", "90000000", 1), row("mid", "5000000", 4)],
    });

    render(<ServicesView />);

    expect(header(/revenue/i)).toHaveAttribute("aria-sort", "descending");
    expect(bodyRows().map((r) => within(r).getByRole("rowheader").textContent)).toEqual([
      expect.stringContaining("top"),
      expect.stringContaining("mid"),
      expect.stringContaining("low"),
    ]);
  });

  it("toggles the revenue sort to ascending", () => {
    useServiceRevenueMock.mockReturnValue({
      status: "ready",
      rows: [row("low", "1000000", 9), row("top", "90000000", 1)],
    });

    render(<ServicesView />);
    fireEvent.click(within(header(/revenue/i)).getByRole("button"));

    expect(header(/revenue/i)).toHaveAttribute("aria-sort", "ascending");
    expect(bodyRows()[0]).toHaveTextContent("low");
  });

  it("sorts by payment count, and only the active column carries aria-sort", () => {
    useServiceRevenueMock.mockReturnValue({
      status: "ready",
      rows: [row("low", "1000000", 9), row("top", "90000000", 1)],
    });

    render(<ServicesView />);
    fireEvent.click(within(header(/payments/i)).getByRole("button"));

    expect(header(/payments/i)).toHaveAttribute("aria-sort", "descending");
    expect(header(/revenue/i)).not.toHaveAttribute("aria-sort");
    expect(bodyRows()[0]).toHaveTextContent("low");
  });

  it("compares revenue as BigInt, so values above 2^53 sort exactly", () => {
    useServiceRevenueMock.mockReturnValue({
      status: "ready",
      rows: [row("smaller", "9007199254740992", 1), row("larger", "9007199254740993", 1)],
    });

    render(<ServicesView />);

    expect(bodyRows()[0]).toHaveTextContent("larger");
  });

  it("totals revenue per asset with BigInt and formats only for display", () => {
    useServiceRevenueMock.mockReturnValue({
      status: "ready",
      rows: [
        row("a", "9007199254740993", 1),
        row("b", "9007199254740993", 1),
        row("c", "30000000", 2, { id: "GC:XLM", asset: "XLM" }),
      ],
    });

    render(<ServicesView />);

    const card = screen.getByText("Total revenue").closest("div");
    if (!card) throw new Error("revenue card not found");
    // 2 * 9007199254740993 = 18014398509481986 base units, 7 decimals.
    expect(within(card).getByText("1,801,439,850.9481986 USDC")).toBeInTheDocument();
    expect(within(card).getByText("3.00 XLM")).toBeInTheDocument();
  });

  it("shows the model mix as shares of settled payments and the latency per model", () => {
    useServiceRevenueMock.mockReturnValue({
      status: "ready",
      rows: [
        row("weather", "1000000", 4, {
          models: models({ x402: [3, 120], "mpp-channel": [1, 21] }),
        }),
      ],
    });

    render(<ServicesView />);

    const mix = screen.getByTestId(`model-mix-GWEATHER:USDC`);
    expect(within(mix).getByText(/x402 per-request/)).toHaveTextContent("75.00%");
    expect(within(mix).getByText(/MPP channel/)).toHaveTextContent("25.00%");
    expect(within(mix).queryByText(/MPP charge/)).not.toBeInTheDocument();

    const latency = screen.getByTestId(`latency-GWEATHER:USDC`);
    expect(latency).toHaveTextContent("x402 per-request: 120 ms");
    expect(latency).toHaveTextContent("MPP channel: 21 ms");
    expect(latency).not.toHaveTextContent("MPP charge");
  });
});
