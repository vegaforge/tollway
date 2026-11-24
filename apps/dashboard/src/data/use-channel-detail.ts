"use client";

import { useEffect, useState } from "react";

import { type ChannelDetail, fetchChannelDetail } from "./channel-detail";

/**
 * The states the channel detail page renders. `not-found` is separate from
 * `error`: an id the source does not track is an answer, not a failure.
 */
export type UseChannelDetailState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | { status: "not-found" }
  | { status: "ready"; detail: ChannelDetail };

/** Loads one channel's detail and reloads when the channel id changes. */
export function useChannelDetail(channelId: string): UseChannelDetailState {
  const [state, setState] = useState<UseChannelDetailState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });

    fetchChannelDetail(channelId)
      .then((detail) => {
        if (cancelled) return;
        setState(detail ? { status: "ready", detail } : { status: "not-found" });
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
  }, [channelId]);

  return state;
}
