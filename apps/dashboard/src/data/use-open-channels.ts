"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ChannelClosedData, ChannelOpenedData } from "@/lib/event-schemas";
import { fetchOpenChannels, type OpenChannelRow } from "./open-channels";
import {
  createHandlerMap,
  registerSseHandler,
  type StreamStatus,
  useEventStream,
} from "./use-event-stream";

/**
 * Discriminated state machine the channels view renders against. Each variant
 * maps to one rendered surface, so the UI cannot accidentally render rows
 * while still loading or render the empty state while an error is in flight.
 */
export type UseOpenChannelsState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; rows: OpenChannelRow[]; stream?: StreamStatus };

/**
 * Subscribes the channels view to the data source. Loads a snapshot on
 * mount and merges live `channel.opened` and `channel.closed` events from
 * the SSE stream. Channels are updated in place (by id); new ones are
 * appended, closed ones have their status updated to `"closed"`.
 * On a `reset` event the snapshot is refetched.
 */
export function useOpenChannels(): UseOpenChannelsState {
  const [state, setState] = useState<UseOpenChannelsState>({ status: "loading" });
  const handlersRef = useRef(createHandlerMap());

  const fetchAndSet = useCallback(() => {
    setState({ status: "loading" });
    fetchOpenChannels()
      .then((snapshot) => {
        setState((prev) => ({
          status: "ready",
          rows: snapshot.rows,
          stream: prev.status === "ready" ? prev.stream : "connecting",
        }));
      })
      .catch((err: unknown) => {
        setState({
          status: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
  }, []);

  useEffect(() => {
    fetchAndSet();
  }, [fetchAndSet]);

  useEffect(() => {
    const unsubOpened = registerSseHandler(handlersRef, "channel.opened", (event) => {
      const data = event.data as ChannelOpenedData;
      const newRow: OpenChannelRow = {
        id: data.channelId,
        counterparty: data.counterparty,
        deposit: data.deposit,
        committed: "0",
        sequence: -1,
        status: "open",
        asset: data.asset,
      };
      setState((prev) => {
        if (prev.status !== "ready") return prev;
        if (prev.rows.some((r) => r.id === newRow.id)) return prev;
        return { ...prev, rows: [...prev.rows, newRow] };
      });
    });

    const unsubClosed = registerSseHandler(handlersRef, "channel.closed", (event) => {
      const data = event.data as ChannelClosedData;
      setState((prev) => {
        if (prev.status !== "ready") return prev;
        return {
          ...prev,
          rows: prev.rows.map((r) =>
            r.id === data.channelId ? { ...r, status: "closed" as const } : r,
          ),
        };
      });
    });

    return () => {
      unsubOpened();
      unsubClosed();
    };
    // handlersRef.current is mutated in place; the ref object itself is stable.
  }, []);

  const streamStatus = useEventStream({
    handlersRef,
    types: ["channel.opened", "channel.closed"],
    onReset: fetchAndSet,
  });

  useEffect(() => {
    setState((prev) => {
      if (prev.status !== "ready") return prev;
      return { ...prev, stream: streamStatus };
    });
  }, [streamStatus]);

  return state;
}
