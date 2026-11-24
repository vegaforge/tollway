/**
 * Shared types for the demo scenarios. Each scenario serves a paid route over
 * HTTP through `expressPaywall(createPaywall(...))`, pays it, and verifies the
 * Tollway receipt it gets back.
 */

import type { SignedReceipt } from "@vegaforge/tollway-core";

/** The settlement models a scenario can run today. */
export type ScenarioName = "x402" | "mpp-charge";

/** What one scenario run produced. */
export type ScenarioResult = {
  scenario: ScenarioName;
  mock: boolean;
  resource: string;
  amount: string;
  asset: string;
  /** The settlement transaction hash, when the receipt carries one. */
  settlement: string | undefined;
  receipt: SignedReceipt;
  receiptValid: boolean;
};
