"use client";

import { useEffect, useState } from "react";

import { fetchMetricsExport, type MetricsExportSource } from "./metrics-export";

/**
 * Discriminated state machine the exports view renders against. Each variant
 * maps to one rendered surface, preventing the form from appearing before
 * the hub source is ready.
 */
export type UseMetricsExportState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | {
      status: "ready";
      hub: MetricsExportSource;
      defaultFrom: string;
      defaultTo: string;
    };

/**
 * Subscribes the exports view to the metrics export source. Today the source
 * is a deterministic stub hub; tomorrow it will query the observability API.
 */
export function useMetricsExport(): UseMetricsExportState {
  const [state, setState] = useState<UseMetricsExportState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetchMetricsExport()
      .then((snapshot) => {
        if (cancelled) return;
        setState({
          status: "ready",
          hub: snapshot.hub,
          defaultFrom: snapshot.defaultFrom,
          defaultTo: snapshot.defaultTo,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
