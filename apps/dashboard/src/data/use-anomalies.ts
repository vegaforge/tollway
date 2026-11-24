"use client";

import { useEffect, useState } from "react";

import { type AnomalyPage, type AnomalyQuery, fetchAnomalies } from "./anomalies";

/** The states the anomalies feed and the Overview strip render. */
export type UseAnomaliesState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; page: AnomalyPage };

/**
 * Loads one page of the feed for `query`. It loads again when a filter or the
 * cursor changes, so the view moves between pages by changing the cursor.
 */
export function useAnomalies(query: AnomalyQuery): UseAnomaliesState {
  const { kind, severity, counterparty, agentId, cursor, limit } = query;
  const [state, setState] = useState<UseAnomaliesState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    fetchAnomalies({ kind, severity, counterparty, agentId, cursor, limit })
      .then((page) => {
        if (!cancelled) setState({ status: "ready", page });
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
  }, [kind, severity, counterparty, agentId, cursor, limit]);

  return state;
}
