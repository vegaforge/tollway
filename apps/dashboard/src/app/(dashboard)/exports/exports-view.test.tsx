import { fireEvent, render, screen } from "@testing-library/react";
import { createObservabilityHub, type PaymentMetric } from "@vegaforge/tollway-observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildMetricsQuery } from "@/data/metrics-export";

const useMetricsExportMock = vi.hoisted(() => vi.fn());

vi.mock("@/data/use-metrics-export", () => ({
  useMetricsExport: useMetricsExportMock,
}));

import { ExportsView } from "./exports-view";

function makeMetric(overrides: Partial<PaymentMetric> = {}): PaymentMetric {
  return {
    payer: overrides.payer ?? "GAGENTAAA",
    payee: overrides.payee ?? "GSERVICEAAA",
    model: overrides.model ?? "x402",
    amount: overrides.amount ?? "10000000",
    asset: overrides.asset ?? "USDC:GA5Z",
    latencyMs: overrides.latencyMs ?? 45,
    outcome: overrides.outcome ?? "settled",
    at: overrides.at ?? "2026-11-15T12:00:00.000Z",
  };
}

function makeSeededHub(metrics: PaymentMetric[]) {
  const hub = createObservabilityHub();
  for (const metric of metrics) {
    hub.record(metric);
  }
  return hub;
}

async function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") {
    return blob.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("failed to read blob"));
    reader.readAsText(blob);
  });
}

type DownloadCapture = {
  href: string;
  download: string;
};

let originalCreateObjectUrl: PropertyDescriptor | undefined;
let originalRevokeObjectUrl: PropertyDescriptor | undefined;
let createObjectUrlMock: ReturnType<typeof vi.fn<(obj: Blob | MediaSource) => string>>;
let revokeObjectUrlMock: ReturnType<typeof vi.fn<(url: string) => void>>;
let anchorClickSpy: ReturnType<typeof vi.spyOn>;
let capturedDownloads: DownloadCapture[];
let capturedBlobs: Blob[];

beforeEach(() => {
  capturedDownloads = [];
  capturedBlobs = [];
  originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

  createObjectUrlMock = vi.fn((obj: Blob | MediaSource) => {
    if (obj instanceof Blob) {
      capturedBlobs.push(obj);
    }
    return `blob:https://dashboard.test/export-${capturedBlobs.length}`;
  });
  revokeObjectUrlMock = vi.fn();

  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: createObjectUrlMock,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: revokeObjectUrlMock,
  });

  anchorClickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function recordClick(this: HTMLAnchorElement) {
      capturedDownloads.push({
        href: this.href,
        download: this.download,
      });
    });
});

afterEach(() => {
  useMetricsExportMock.mockReset();
  anchorClickSpy.mockRestore();

  if (originalCreateObjectUrl) {
    Object.defineProperty(URL, "createObjectURL", originalCreateObjectUrl);
  } else {
    Reflect.deleteProperty(URL, "createObjectURL");
  }

  if (originalRevokeObjectUrl) {
    Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectUrl);
  } else {
    Reflect.deleteProperty(URL, "revokeObjectURL");
  }
});

describe("ExportsView", () => {
  it("renders the skeleton while loading", () => {
    useMetricsExportMock.mockReturnValue({ status: "loading" });

    render(<ExportsView />);

    expect(screen.getByTestId("exports-skeleton")).toBeInTheDocument();
  });

  it("renders an error alert when the data source fails", () => {
    useMetricsExportMock.mockReturnValue({
      status: "error",
      error: new Error("observability hub unavailable"),
    });

    render(<ExportsView />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/could not load metrics export/i);
    expect(alert).toHaveTextContent(/observability hub unavailable/i);
  });

  it("renders labelled controls and enables download when ready", () => {
    const hub = makeSeededHub([
      makeMetric({ at: "2026-11-13T10:00:00.000Z" }),
      makeMetric({ at: "2026-11-19T10:00:00.000Z" }),
    ]);
    useMetricsExportMock.mockReturnValue({
      status: "ready",
      hub,
      defaultFrom: "2026-11-13",
      defaultTo: "2026-11-19",
    });

    render(<ExportsView />);

    expect(screen.getByLabelText("From")).toHaveValue("2026-11-13");
    expect(screen.getByLabelText("To")).toHaveValue("2026-11-19");
    expect(screen.getByRole("radio", { name: "JSON" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "CSV" })).not.toBeChecked();
    expect(screen.getByTestId("export-summary")).toHaveTextContent("2 metrics in range");
    expect(screen.getByRole("button", { name: /download json/i })).toBeEnabled();
  });

  it("disables download with an inline message when from is after to", () => {
    const hub = makeSeededHub([makeMetric()]);
    useMetricsExportMock.mockReturnValue({
      status: "ready",
      hub,
      defaultFrom: "2026-11-13",
      defaultTo: "2026-11-19",
    });

    render(<ExportsView />);

    const fromInput = screen.getByLabelText("From");
    const toInput = screen.getByLabelText("To");
    const button = screen.getByRole("button", { name: /download json/i });

    fireEvent.change(fromInput, { target: { value: "2026-11-20" } });

    expect(button).toBeDisabled();
    expect(fromInput).toHaveAttribute("aria-invalid", "true");
    expect(toInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByTestId("export-range-error")).toHaveTextContent(
      "Start date must be on or before end date.",
    );

    fireEvent.change(fromInput, { target: { value: "2026-11-19" } });

    expect(button).toBeEnabled();
    expect(fromInput).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByTestId("export-range-error")).not.toBeInTheDocument();

    fireEvent.change(toInput, { target: { value: "" } });

    expect(button).toBeDisabled();
    expect(screen.getByTestId("export-range-error")).toHaveTextContent(
      "Select both a start date and an end date.",
    );
  });

  it("switches between JSON and CSV formats", () => {
    const hub = makeSeededHub([makeMetric()]);
    useMetricsExportMock.mockReturnValue({
      status: "ready",
      hub,
      defaultFrom: "2026-11-13",
      defaultTo: "2026-11-19",
    });

    render(<ExportsView />);

    const jsonRadio = screen.getByRole("radio", { name: "JSON" });
    const csvRadio = screen.getByRole("radio", { name: "CSV" });

    fireEvent.click(csvRadio);

    expect(csvRadio).toBeChecked();
    expect(jsonRadio).not.toBeChecked();
    expect(screen.getByRole("button", { name: /download csv/i })).toBeInTheDocument();
    expect(screen.getByTestId("export-summary")).toHaveTextContent(
      "tollway-metrics-2026-11-13-2026-11-19.csv",
    );

    fireEvent.click(screen.getByRole("button", { name: /download csv/i }));
    expect(capturedBlobs[0]?.type).toBe("text/csv;charset=utf-8");
    expect(capturedDownloads[0]?.download).toBe("tollway-metrics-2026-11-13-2026-11-19.csv");

    fireEvent.click(jsonRadio);

    expect(jsonRadio).toBeChecked();
    expect(screen.getByRole("button", { name: /download json/i })).toBeInTheDocument();
    expect(screen.getByTestId("export-summary")).toHaveTextContent(
      "tollway-metrics-2026-11-13-2026-11-19.json",
    );

    fireEvent.click(screen.getByRole("button", { name: /download json/i }));
    expect(capturedBlobs[1]?.type).toBe("application/json;charset=utf-8");
    expect(capturedDownloads[1]?.download).toBe("tollway-metrics-2026-11-13-2026-11-19.json");
  });

  it("downloads the exact output of hub.export for the selected range and format", async () => {
    const hub = makeSeededHub([
      makeMetric({ payer: "GAGENT_EARLY", amount: "100", at: "2026-11-13T10:00:00.000Z" }),
      makeMetric({ payer: "GAGENT_MID", amount: "200", at: "2026-11-15T12:00:00.000Z" }),
      makeMetric({ payer: "GAGENT_LATE", amount: "300", at: "2026-11-19T18:00:00.000Z" }),
    ]);
    const exportSpy = vi.spyOn(hub, "export");

    useMetricsExportMock.mockReturnValue({
      status: "ready",
      hub,
      defaultFrom: "2026-11-13",
      defaultTo: "2026-11-19",
    });

    render(<ExportsView />);

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-14" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-16" } });

    expect(screen.getByTestId("export-summary")).toHaveTextContent("1 metric in range");

    fireEvent.click(screen.getByRole("button", { name: /download json/i }));

    const expectedQuery = buildMetricsQuery("2026-11-14", "2026-11-16");
    expect(exportSpy).toHaveBeenCalledWith("json", expectedQuery);
    expect(createObjectUrlMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:https://dashboard.test/export-1");
    expect(capturedDownloads[0]).toEqual({
      href: "blob:https://dashboard.test/export-1",
      download: "tollway-metrics-2026-11-14-2026-11-16.json",
    });

    const jsonBlob = capturedBlobs[0];
    if (!jsonBlob) throw new Error("expected JSON Blob");
    expect(await readBlobText(jsonBlob)).toBe(hub.export("json", expectedQuery));

    fireEvent.click(screen.getByRole("radio", { name: "CSV" }));
    fireEvent.click(screen.getByRole("button", { name: /download csv/i }));

    expect(exportSpy).toHaveBeenCalledWith("csv", expectedQuery);
    expect(revokeObjectUrlMock).toHaveBeenCalledWith("blob:https://dashboard.test/export-2");
    expect(capturedDownloads[1]).toEqual({
      href: "blob:https://dashboard.test/export-2",
      download: "tollway-metrics-2026-11-14-2026-11-16.csv",
    });

    const csvBlob = capturedBlobs[1];
    if (!csvBlob) throw new Error("expected CSV Blob");
    expect(await readBlobText(csvBlob)).toBe(hub.export("csv", expectedQuery));
  });

  it("prefixes CSV cells starting with =, +, -, or @ with a single quote before download", async () => {
    const hub = makeSeededHub([
      makeMetric({
        payer: "=SUM(A1:A2)",
        payee: "+cmd|' /C calc'!A0",
        asset: "-2+3",
        amount: "100",
        at: "2026-11-15T10:00:00.000Z",
      }),
      makeMetric({
        payer: "@SUM(1+1)",
        payee: "GSERVICECLEAN",
        asset: "USDC:GA5Z",
        amount: "200",
        at: "2026-11-15T11:00:00.000Z",
      }),
    ]);

    useMetricsExportMock.mockReturnValue({
      status: "ready",
      hub,
      defaultFrom: "2026-11-13",
      defaultTo: "2026-11-19",
    });

    render(<ExportsView />);

    fireEvent.click(screen.getByRole("radio", { name: "CSV" }));
    fireEvent.click(screen.getByRole("button", { name: /download csv/i }));

    const csvBlob = capturedBlobs[0];
    if (!csvBlob) throw new Error("expected CSV Blob");

    const downloadedCsv = await readBlobText(csvBlob);
    expect(downloadedCsv).toBe(hub.export("csv", buildMetricsQuery("2026-11-13", "2026-11-19")));
    expect(downloadedCsv).toContain('"\'=SUM(A1:A2)"');
    expect(downloadedCsv).toContain("\"'+cmd|' /C calc'!A0\"");
    expect(downloadedCsv).toContain('"\'-2+3"');
    expect(downloadedCsv).toContain('"\'@SUM(1+1)"');
  });
});
