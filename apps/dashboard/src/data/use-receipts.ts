"use client";

import { type SignedReceipt } from "@vegaforge/tollway-core";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ReceiptCreatedData } from "@/lib/event-schemas";
import { fetchReceipts, type ReceiptRow } from "./receipts";
import {
  registerSseHandler,
  type StreamStatus,
  useEventStream,
  createHandlerMap,
} from "./use-event-stream";

/** Maximum receipts kept in the live feed to prevent unbounded growth. */
const MAX_LIVE_RECEIPTS = 500;

/**
 * Discriminated state machine the receipts view renders against. Each
 * variant maps to one rendered surface, so the UI cannot accidentally
 * render rows while still loading or render the empty state while an
 * error is in flight. The trustedKeys travel with the ready snapshot so
 * the detail view can construct an Ed25519Verifier without a separate
 * key-directory request.
 */
export type UseReceiptsState =
  | { status: "loading" }
  | { status: "error"; error: Error }
  | {
      status: "ready";
      rows: ReceiptRow[];
      trustedKeys: Record<string, Uint8Array>;
      stream?: StreamStatus;
    };

/**
 * Subscribes the receipts view to the data source. Loads a snapshot on
 * mount and merges live `receipt.created` events from the SSE stream.
 * New receipts are prepended (newest first) and deduplicated by id.
 * On a `reset` event the snapshot is refetched.
 */
export function useReceipts(): UseReceiptsState {
  const [state, setState] = useState<UseReceiptsState>({ status: "loading" });
  const handlersRef = useRef(createHandlerMap());

  const fetchAndSet = useCallback(() => {
    setState({ status: "loading" });
    fetchReceipts()
      .then((snapshot) => {
        setState((prev) => ({
          status: "ready",
          rows: snapshot.rows,
          trustedKeys: snapshot.trustedKeys,
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
    return registerSseHandler(handlersRef, "receipt.created", (event) => {
      const data = event.data as ReceiptCreatedData;
      // The event already carries a validated ReceiptBody; wrap it with the
      // signature directly rather than rebuilding through buildReceipt.
      const newReceipt: SignedReceipt = {
        receipt: data.receipt,
        signature: data.signature,
      };
      setState((prev) => {
        if (prev.status !== "ready") return prev;
        // Deduplicate by receipt id.
        if (prev.rows.some((r) => r.receipt.id === newReceipt.receipt.id)) return prev;
        const updated = [newReceipt, ...prev.rows];
        return {
          ...prev,
          rows: updated.length > MAX_LIVE_RECEIPTS ? updated.slice(0, MAX_LIVE_RECEIPTS) : updated,
        };
      });
    });
    // handlersRef.current is mutated in place; the ref object itself is stable.
  }, []);

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
