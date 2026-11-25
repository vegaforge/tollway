"use client";

import type { SignedReceipt } from "@vegaforge/tollway-core";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ReceiptCreatedData } from "@/lib/event-schemas";
import {
  fetchReceipts,
  type KeySetInfo,
  type ReceiptQuery,
  type ReceiptRow,
  type ReceiptsPage,
} from "./receipts";
import {
  createHandlerMap,
  registerSseHandler,
  type StreamStatus,
  useEventStream,
} from "./use-event-stream";

/** Maximum receipts kept in the live feed to prevent unbounded growth. */
const MAX_LIVE_RECEIPTS = 500;

/**
 * Discriminated state machine the receipts view renders against. The key set
 * travels separately from the rows so the detail view can verify signatures
 * against an independently sourced key rather than one that travels with the
 * receipts.
 */
export type UseReceiptsState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | {
      status: "ready";
      page: ReceiptsPage;
      keySet: KeySetInfo;
      stream?: StreamStatus;
    };

/**
 * Loads one page of receipts for `query`. Reloads when the query changes.
 * Merges live `receipt.created` events from the SSE stream into the first
 * page when no cursor is active. On a `reset` event the snapshot is
 * refetched.
 *
 * The live-prepend behaviour only applies to the first page (cursor = null)
 * so a user paging through history does not see rows jump.
 */
export function useReceipts(query: ReceiptQuery = {}): UseReceiptsState {
  const [state, setState] = useState<UseReceiptsState>({ status: "loading" });
  const handlersRef = useRef(createHandlerMap());

  // Stringify the query so the effect dependency array can be a single string.
  const queryKey = JSON.stringify(query);

  const fetchAndSet = useCallback(() => {
    setState({ status: "loading" });
    const q: ReceiptQuery = JSON.parse(queryKey) as ReceiptQuery;
    fetchReceipts(q)
      .then(({ page, keySet }) => {
        setState((prev) => ({
          status: "ready",
          page,
          keySet,
          stream: prev.status === "ready" ? prev.stream : "connecting",
        }));
      })
      .catch((err: unknown) => {
        setState({
          status: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      });
  }, [queryKey]);

  useEffect(() => {
    fetchAndSet();
  }, [fetchAndSet]);

  useEffect(() => {
    // Only prepend live events on the first page (no cursor).
    const q: ReceiptQuery = JSON.parse(queryKey) as ReceiptQuery;
    const isFirstPage = q.cursor === undefined || q.cursor === null;

    return registerSseHandler(handlersRef, "receipt.created", (event) => {
      if (!isFirstPage) return;
      const data = event.data as ReceiptCreatedData;
      const newReceipt: SignedReceipt = {
        receipt: data.receipt,
        signature: data.signature,
      };
      setState((prev) => {
        if (prev.status !== "ready") return prev;
        const rows: ReceiptRow[] = prev.page.rows;
        if (rows.some((r) => r.receipt.id === newReceipt.receipt.id)) return prev;
        const updated = [newReceipt, ...rows];
        return {
          ...prev,
          page: {
            ...prev.page,
            rows:
              updated.length > MAX_LIVE_RECEIPTS ? updated.slice(0, MAX_LIVE_RECEIPTS) : updated,
          },
        };
      });
    });
  }, [queryKey]);

  const streamStatus = useEventStream({
    handlersRef,
    types: ["receipt.created"],
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
