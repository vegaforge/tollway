"use client";

import { useEffect, useState } from "react";

import { fetchReceipts, type ReceiptRow } from "./receipts";

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
  | { status: "ready"; rows: ReceiptRow[]; trustedKeys: Record<string, Uint8Array> };

/**
 * Subscribes the receipts view to the data source. Today the source is a
 * local stub; tomorrow it is @tollway/observability or the receipt
 * archive. The hook's contract does not change either way.
 */
export function useReceipts(): UseReceiptsState {
  const [state, setState] = useState<UseReceiptsState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetchReceipts()
      .then((snapshot) => {
        if (cancelled) return;
        setState({
          status: "ready",
          rows: snapshot.rows,
          trustedKeys: snapshot.trustedKeys,
        });
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
