"use client";

import { useEffect, useState } from "react";

import { fetchOverview, type OverviewSnapshot } from "./overview";

/** The states the Overview renders. Each maps to one surface on the page. */
export type UseOverviewState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; snapshot: OverviewSnapshot };

/** Subscribes the Overview to its data source. */
export function useOverview(): UseOverviewState {
  const [state, setState] = useState<UseOverviewState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetchOverview()
      .then((snapshot) => {
        if (!cancelled) setState({ status: "ready", snapshot });
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
