"use client";

/**
 * Anomaly feed, updated live from `anomaly.detected` events.
 *
 * New anomalies are prepended (newest first) and deduplicated by id.
 * The list is capped at MAX_ANOMALIES to prevent unbounded growth.
 * On a `reset` event the list is cleared (there is no REST snapshot yet;
 * when the service exposes one, the reset handler should refetch it).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { AnomalyDetectedData } from "@/lib/event-schemas";
import {
  createHandlerMap,
  registerSseHandler,
  type StreamStatus,
  useEventStream,
} from "./use-event-stream";

const MAX_ANOMALIES = 200;

export type AnomalyRow = {
  id: string;
  type: string;
  agentId: string;
  detail: string;
  at: string;
};

export type UseAnomaliesState =
  | { status: "loading"; stream?: StreamStatus }
  | { status: "ready"; rows: AnomalyRow[]; stream?: StreamStatus };

export function useAnomalies(agentFilter?: string | null): UseAnomaliesState {
  const [state, setState] = useState<UseAnomaliesState>({
    status: "loading",
    stream: "connecting",
  });
  const handlersRef = useRef(createHandlerMap());

  // No REST snapshot yet; mark ready with empty rows on mount.
  useEffect(() => {
    setState((prev) => ({ status: "ready", rows: [], stream: prev.stream }));
  }, []);

  const reset = useCallback(() => {
    setState((prev) => ({ status: "ready", rows: [], stream: prev.stream }));
  }, []);

  useEffect(() => {
    return registerSseHandler(handlersRef, "anomaly.detected", (event) => {
      const data = event.data as AnomalyDetectedData;
      const newRow: AnomalyRow = {
        id: data.id,
        type: data.type,
        agentId: data.agentId,
        detail: data.detail,
        at: data.at,
      };
      setState((prev) => {
        if (prev.status !== "ready") return prev;
        if (prev.rows.some((r) => r.id === newRow.id)) return prev;
        const rows = [newRow, ...prev.rows];
        return {
          ...prev,
          rows: rows.length > MAX_ANOMALIES ? rows.slice(0, MAX_ANOMALIES) : rows,
        };
      });
    });
    // handlersRef.current is mutated in place; the ref object itself is stable.
  }, []);

  const streamStatus = useEventStream({
    handlersRef,
    types: ["anomaly.detected"],
    onReset: reset,
  });

  useEffect(() => {
    setState((prev) => ({ ...prev, stream: streamStatus }));
  }, [streamStatus]);

  // Filter by agent if requested.
  if (agentFilter && state.status === "ready") {
    return {
      ...state,
      rows: state.rows.filter((r) => r.agentId === agentFilter),
    };
  }

  return state;
}
