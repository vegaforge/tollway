"use client";

import { useEffect, useState } from "react";

import { fetchOpenChannels, type OpenChannelRow } from "./open-channels";

/**
 * Discriminated state machine the channels view renders against. Each variant
 * maps to one rendered surface, so the UI cannot accidentally render rows
 * while still loading or render the empty state while an error is in flight.
 */
export type UseOpenChannelsState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "ready"; rows: OpenChannelRow[] };

/**
 * Subscribes the channels view to the data source. Today the source is a
 * local stub; tomorrow it is the observability hub. The hook's contract
 * does not change either way.
 */
export function useOpenChannels(): UseOpenChannelsState {
  const [state, setState] = useState<UseOpenChannelsState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetchOpenChannels()
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
