"use client";

import { useEffect, useState } from "react";

import { type AgentSpendRow, fetchAgentSpend } from "./agent-spend";

/**
 * Discriminated state machine the agents view renders against. Each variant
 * maps to one rendered surface, so the UI cannot accidentally render rows
 * while still loading or render the empty state while an error is in flight.
 */
export type UseAgentSpendState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; rows: AgentSpendRow[] };

/**
 * Subscribes the agents view to the data source. Today the source is a local
 * stub; tomorrow it is @tollway/observability. The hook's contract does not
 * change either way.
 */
export function useAgentSpend(): UseAgentSpendState {
  const [state, setState] = useState<UseAgentSpendState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetchAgentSpend()
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
