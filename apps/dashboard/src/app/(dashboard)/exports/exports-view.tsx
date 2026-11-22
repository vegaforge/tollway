"use client";

import type { ExportFormat } from "@vegaforge/tollway-observability";
import { type FormEvent, useMemo, useState } from "react";

import { Icon } from "@/components/icon";
import { Panel } from "@/components/ui/panel";
import {
  buildExportFilename,
  buildMetricsQuery,
  exportFormats,
  type MetricsExportSource,
  validateDateRange,
} from "@/data/metrics-export";
import { useMetricsExport } from "@/data/use-metrics-export";

const FORMAT_COPY: Record<ExportFormat, { label: string; description: string }> = {
  json: {
    label: "JSON",
    description: "Array of PaymentMetric records",
  },
  csv: {
    label: "CSV",
    description: "RFC 4180 spreadsheet rows",
  },
};

const MIME_TYPE: Record<ExportFormat, string> = {
  json: "application/json;charset=utf-8",
  csv: "text/csv;charset=utf-8",
};

/**
 * Interactive export controls for downloading payment metrics in JSON or CSV
 * format for a chosen inclusive UTC date range.
 */
export function ExportsView() {
  const state = useMetricsExport();

  return (
    <Panel title="Exports" description="Download a range as JSON or CSV">
      {state.status === "loading" ? <ExportsSkeleton /> : null}
      {state.status === "error" ? <ExportsError error={state.error} /> : null}
      {state.status === "ready" ? (
        <ExportsForm hub={state.hub} defaultFrom={state.defaultFrom} defaultTo={state.defaultTo} />
      ) : null}
    </Panel>
  );
}

function ExportsForm({
  hub,
  defaultFrom,
  defaultTo,
}: {
  hub: MetricsExportSource;
  defaultFrom: string;
  defaultTo: string;
}) {
  const [fromDate, setFromDate] = useState(defaultFrom);
  const [toDate, setToDate] = useState(defaultTo);
  const [format, setFormat] = useState<ExportFormat>("json");
  const [lastDownloaded, setLastDownloaded] = useState<string | null>(null);

  const rangeError = validateDateRange(fromDate, toDate);
  const isValid = rangeError === null;

  const query = useMemo(
    () => (isValid ? buildMetricsQuery(fromDate, toDate) : null),
    [isValid, fromDate, toDate],
  );

  const metricCount = useMemo(() => (query ? hub.summarize(query).count : null), [hub, query]);
  const filename = isValid ? buildExportFilename(fromDate, toDate, format) : null;

  function handleDownload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query || !filename) return;

    const content = hub.export(format, query);
    const blob = new Blob([content], { type: MIME_TYPE[format] });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
      if (typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(url);
      }
    }

    setLastDownloaded(filename);
  }

  return (
    <form onSubmit={handleDownload} noValidate className="space-y-5">
      <fieldset>
        <legend className="text-xs font-medium uppercase tracking-wide text-muted">
          Time range (UTC)
        </legend>
        <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-foreground" htmlFor="export-from">
              From
            </label>
            <input
              id="export-from"
              name="from"
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
              aria-invalid={rangeError !== null}
              aria-describedby={rangeError ? "export-range-error" : undefined}
              className="mt-1.5 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground" htmlFor="export-to">
              To
            </label>
            <input
              id="export-to"
              name="to"
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
              aria-invalid={rangeError !== null}
              aria-describedby={rangeError ? "export-range-error" : undefined}
              className="mt-1.5 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            />
          </div>
        </div>
        {rangeError ? (
          <p
            id="export-range-error"
            role="alert"
            data-testid="export-range-error"
            className="mt-3 rounded-lg border border-danger bg-danger/10 px-3 py-2 text-sm text-foreground"
          >
            {rangeError}
          </p>
        ) : null}
      </fieldset>

      <fieldset>
        <legend className="text-xs font-medium uppercase tracking-wide text-muted">Format</legend>
        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {exportFormats.map((option) => {
            const copy = FORMAT_COPY[option];
            const selected = format === option;
            const inputId = `export-format-${option}`;
            const hintId = `${inputId}-hint`;

            return (
              <div
                key={option}
                className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                  selected ? "border-primary bg-surface" : "border-border bg-surface-2"
                }`}
              >
                <input
                  id={inputId}
                  type="radio"
                  name="export-format"
                  value={option}
                  checked={selected}
                  onChange={() => setFormat(option)}
                  aria-describedby={hintId}
                  className="mt-1 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
                <div>
                  <label htmlFor={inputId} className="block font-medium text-foreground">
                    {copy.label}
                  </label>
                  <p id={hintId} className="text-xs text-muted">
                    {copy.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-xs text-muted" data-testid="export-summary">
          {isValid && metricCount !== null && filename ? (
            <>
              <span>
                {metricCount} {metricCount === 1 ? "metric" : "metrics"} in range
              </span>
              <span className="mx-1.5" aria-hidden="true">
                ·
              </span>
              <code className="font-mono text-foreground">{filename}</code>
            </>
          ) : (
            <span>Fix the date range to enable download.</span>
          )}
        </div>
        <button
          type="submit"
          disabled={!isValid}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Icon name="exports" className="h-4 w-4" />
          <span>{format === "json" ? "Download JSON" : "Download CSV"}</span>
        </button>
      </div>

      <p role="status" aria-live="polite" className="text-xs text-muted">
        {lastDownloaded ? `Downloaded ${lastDownloaded}` : ""}
      </p>
    </form>
  );
}

function ExportsSkeleton() {
  return (
    <div className="space-y-3" data-testid="exports-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-10 animate-pulse rounded-md bg-surface-2" />
      ))}
    </div>
  );
}

function ExportsError({ error }: { error: Error }) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-dashed border-border-strong bg-surface-2 px-4 py-6 text-sm text-muted"
    >
      <p className="font-medium text-foreground">Could not load metrics export</p>
      <p className="mt-1">{error.message}</p>
    </div>
  );
}
