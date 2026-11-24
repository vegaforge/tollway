import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnomaliesView } from "./anomalies-view";

/** Waits for the feed to finish loading, then returns the rendered event ids. */
async function loadedIds(): Promise<string[]> {
  await waitFor(() => {
    expect(screen.queryByTestId("anomalies-skeleton")).not.toBeInTheDocument();
  });
  return screen
    .queryAllByTestId(/^anomaly-anom-/)
    .map((item) => item.getAttribute("data-testid") ?? "");
}

describe("AnomaliesView", () => {
  it("shows the newest page first, grouped by UTC day", async () => {
    render(<AnomaliesView />);

    const ids = await loadedIds();

    expect(ids[0]).toBe("anomaly-anom-policy-stop-0");
    expect(ids).toHaveLength(10);
    expect(screen.getByRole("heading", { name: "2026-11-24 UTC" })).toBeInTheDocument();
  });

  it("moves to the next page with Older and back with Newer", async () => {
    render(<AnomaliesView />);
    await loadedIds();

    fireEvent.click(screen.getByRole("button", { name: "Older" }));
    const second = await loadedIds();

    expect(second[0]).toBe("anomaly-anom-policy-stop-10");
    expect(screen.getByText("Page 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Newer" }));
    const back = await loadedIds();

    expect(back[0]).toBe("anomaly-anom-policy-stop-0");
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("filters by kind and starts again from the newest event", async () => {
    render(<AnomaliesView />);
    await loadedIds();

    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), {
      target: { value: "reconciliation-drift" },
    });
    const drifts = await loadedIds();

    expect(drifts).toHaveLength(9);
    expect(screen.queryByTestId("anomaly-anom-policy-stop-0")).not.toBeInTheDocument();
    expect(screen.getByText("Page 1")).toBeInTheDocument();
  });

  it("filters by severity", async () => {
    render(<AnomaliesView />);
    await loadedIds();

    fireEvent.change(screen.getByRole("combobox", { name: "Severity" }), {
      target: { value: "medium" },
    });
    const medium = await loadedIds();

    expect(medium).toHaveLength(6);
    expect(medium.every((id) => !id.includes("policy-stop") && !id.includes("drift"))).toBe(true);
  });

  it("limits the feed to one agent and says so", async () => {
    render(<AnomaliesView agentId="agent-classifier-03" />);

    const ids = await loadedIds();

    expect(screen.getByTestId("anomalies-agent-filter")).toHaveTextContent(
      "agent-classifier-03",
    );
    expect(ids).toHaveLength(3);
    expect(ids.every((id) => id.includes("spend-spike"))).toBe(true);
  });

  it("explains each event and links a drift to its channel", async () => {
    render(<AnomaliesView />);
    await loadedIds();

    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), {
      target: { value: "reconciliation-drift" },
    });
    const drift = await screen.findByTestId("anomaly-anom-reconciliation-drift-18");

    expect(within(drift).getByRole("link", { name: "Channel" })).toHaveAttribute(
      "href",
      "/channels/ch-drift-06",
    );
    expect(drift).toHaveTextContent("Reconciliation of ch-drift-06 reported");
  });
});
