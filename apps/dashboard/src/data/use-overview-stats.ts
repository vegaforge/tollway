"use client";

/**
 * Overview page counters, updated live from `metrics.delta` events.
 *
 * The overview page shows headline numbers: payments settled, open channels,
 * and anomaly count. These are delivered as `metrics.delta` events that
 * carry the running totals from the service, so the page updates without
 * a reload.
 *
 * On a `reset` event the stats revert to the stub zeros until the next
 * `metrics.delta` arrives; the view shows "," for stale values.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { MetricsDeltaData } from "@/lib/event-schemas";
import {
  createHandlerMap,
  registerSseHandler,
  type StreamStatus,
  useEventStream,
} from "./use-event-stream";

export type OverviewStats = {
  settledCount: number;
  openChannels: number;
  anomalyCount: number;
  spendByAsset: Record<string, string>;
  /** ISO 8601 timestamp of the most recent delta. */
  at: string | null;
};

export type UseOverviewStatsState =
  | { status: "waiting"; stream?: StreamStatus }
  | { status: "ready"; stats: OverviewStats; stream?: StreamStatus };

export function useOverviewStats(): UseOverviewStatsState {
  const [state, setState] = useState<UseOverviewStatsState>({
    status: "waiting",
    stream: "connecting",
  });
  const handlersRef = useRef(createHandlerMap());

  const reset = useCallback(() => {
    setState((prev) => ({ status: "waiting", stream: prev.stream }));
  }, []);

  useEffect(() => {
    return registerSseHandler(handlersRef, "metrics.delta", (event) => {
      const data = event.data as MetricsDeltaData;
      setState((prev) => ({
        status: "ready",
        stream: prev.stream,
        stats: {
          settledCount: data.settledCount,
          openChannels: data.openChannels,
          anomalyCount: data.anomalyCount,
          spendByAsset: data.spendByAsset,
          at: data.at,
        },
      }));
    });
    // handlersRef.current is mutated in place; the ref object itself is stable.
  }, []);

  const streamStatus = useEventStream({
    handlersRef,
    types: ["metrics.delta"],
    onReset: reset,
  });

  useEffect(() => {
    setState((prev) => ({ ...prev, stream: streamStatus }));
  }, [streamStatus]);

  return state;
}
