"use client";

import { useEffect, useState } from "react";

import { type AgentDetail, fetchAgentDetail } from "./agent-detail";

export type UseAgentDetailState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; detail: AgentDetail };

export function useAgentDetail(agentId: string): UseAgentDetailState {
  const [state, setState] = useState<UseAgentDetailState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetchAgentDetail(agentId)
      .then((detail) => {
        if (cancelled) return;
        setState({ status: "ready", detail });
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
  }, [agentId]);

  return state;
}
