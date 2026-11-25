"use client";

import { useEffect, useState } from "react";

import { fetchServiceRevenue, type ServiceRevenueRow } from "./service-revenue";

/**
 * The three states the services view renders. Each maps to one surface, so
 * the view cannot render rows while loading or an empty state on an error.
 */
export type UseServiceRevenueState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; rows: ServiceRevenueRow[] };

/** Subscribes the services view to `fetchServiceRevenue`. */
export function useServiceRevenue(): UseServiceRevenueState {
  const [state, setState] = useState<UseServiceRevenueState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetchServiceRevenue()
      .then((snapshot) => {
        if (cancelled) return;
        setState({ status: "ready", rows: snapshot.rows });
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
