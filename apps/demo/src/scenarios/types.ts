/**
 * Shared types for the demo scenario layer.
 *
 * Each scenario receives a `ScenarioOptions` from main, which carries the
 * resolved facilitator, paywall config, and payer. Scenarios are pure
 * functions that return typed results.
 */

import type { SignedReceipt } from "@vegaforge/tollway-core";
import type { FacilitatorClient, PaywallConfig } from "@vegaforge/tollway-server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/**
 * Signs a payment for one x402 requirement. In live mode this produces a
 * real Soroban authorization; in mock mode a fixed transaction stands in.
 */
export type DemoPayer = (requirements: PaymentRequirements) => Promise<PaymentPayload>;

/** What main.ts resolves from the environment before dispatching a scenario. */
export type ScenarioSetup = {
  mock: boolean;
  facilitator: FacilitatorClient;
  paywall: Pick<PaywallConfig, "asset" | "payTo" | "network">;
  payer: DemoPayer;
};

/** Passed into every scenario's `run(options)` call. */
export type ScenarioOptions = {
  setup: ScenarioSetup;
};

/** Result from the x402 scenario. */
export type X402ScenarioResult = {
  scenario: "x402";
  mock: boolean;
  resource: string;
  amount: string;
  asset: string;
  /** Settlement transaction hash, present when mock is false. */
  settlement: string | undefined;
  receipt: SignedReceipt;
  receiptValid: boolean;
};

/** Result from the mpp-charge scenario. */
export type MppChargeScenarioResult = {
  scenario: "mpp-charge";
  mock: boolean;
  resource: string;
  amount: string;
  asset: string;
  /** Settlement transaction hash. In mock mode this is deterministic. */
  settlement: string | undefined;
  receipt: SignedReceipt;
  receiptValid: boolean;
};

/** Per-request result for the mpp-channel scenario. */
export type ChannelCommitmentResult = {
  sequence: number;
  receipt: SignedReceipt;
  receiptValid: boolean;
};

/** Result from the mpp-channel scenario (mock mode only until #173 merges). */
export type MppChannelScenarioResult = {
  scenario: "mpp-channel";
  mock: true;
  channelId: string;
  commitments: ChannelCommitmentResult[];
  settlementTxHash: string;
  returnedRemainder: string;
  reconciliationOk: boolean;
  openChannelCalls: number;
  signCommitmentCalls: number;
  closeChannelCalls: number;
};

/** Result from the high-frequency channel scenario. */
export type HighFrequencyScenarioResult = {
  scenario: "high-frequency";
  mock: true;
  channelId: string;
  n: number;
  throughputCommitmentsPerSecond: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  settlementTxHash: string;
  settledTotal: string;
  reconciliationOk: boolean;
  openChannelCalls: number;
  closeChannelCalls: number;
};

/** Union of all scenario results for the all-models summary table. */
export type ScenarioResult =
  | X402ScenarioResult
  | MppChargeScenarioResult
  | MppChannelScenarioResult
  | HighFrequencyScenarioResult;
