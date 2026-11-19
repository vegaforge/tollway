"use client";

import { useEffect, useState } from "react";

import { type AgentDetail, type AgentDetailQuery, fetchAgentDetail } from "./agent-detail";

export type UseAgentDetailState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; detail: AgentDetail };

/** Loads one agent's detail and reloads when the agent, bucket or range changes. */
export function useAgentDetail(agentId: string, query: AgentDetailQuery): UseAgentDetailState {
  const [state, setState] = useState<UseAgentDetailState>({ status: "loading" });
  const { bucket, range } = query;

  useEffect(() => {
    // The previous detail stays on screen while a new bucket or range loads,
    // so the controls the user just changed keep their focus.
    let cancelled = false;

    fetchAgentDetail(agentId, { bucket, range })
      .then((detail) => {
        if (!cancelled) setState({ status: "ready", detail });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: "error", error: err instanceof Error ? err : new Error(String(err)) });
      });

    return () => {
      cancelled = true;
    };
  }, [agentId, bucket, range]);

  return state;
}
