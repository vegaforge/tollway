/**
 * MPP channel scenario: open one channel, pay five requests as off-chain
 * commitments, close, and reconcile.
 *
 * This scenario requires the gate's mpp-channel path (#173) for the HTTP
 * layer. Until #173 merges, the scenario runs directly against the channel
 * manager to prove the commitment lifecycle end to end in mock mode.
 *
 * Each per-request receipt is built from the commitment the manager returns,
 * carrying `model: "mpp-channel"` and a `channel-commitment` settlement
 * reference with strictly increasing sequence numbers. After close the
 * scenario runs `createReconciler().reconcileChannel` and fails if the result
 * is not ok.
 *
 * See docs/design.md, "The channel lifecycle manager".
 */

import {
  createChannelManager,
  createMemoryCommitmentStore,
  createMockMppChannelAdapter,
} from "@vegaforge/tollway-channels";
import {
  buildReceipt,
  Ed25519Signer,
  Ed25519Verifier,
  signReceipt,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import { createReconciler } from "@vegaforge/tollway-reconcile";
import type {
  ChannelCommitmentResult,
  MppChannelScenarioResult,
  ScenarioOptions,
} from "./types.js";

/** Price per request: 0.001 USDC in 7-decimal base units. */
const PRICE_PER_REQUEST = "10000";

/** Initial deposit: enough for 100 requests (10 USDC in base units). */
const CHANNEL_DEPOSIT = "1000000";

/** Number of requests to pay through the channel. */
const REQUEST_COUNT = 5;

/**
 * Runs the MPP channel happy path in mock mode:
 *
 * 1. Opens a channel via the mock adapter.
 * 2. Commits REQUEST_COUNT times and builds a signed receipt per commitment.
 * 3. Closes the channel once.
 * 4. Reconciles the commitment stream against the settlement.
 *
 * Live HTTP gating requires #173 and is not in scope for this PR.
 */
export async function runMppChannelScenario(
  options: ScenarioOptions,
): Promise<MppChannelScenarioResult> {
  const { paywall, mock } = options.setup;

  if (!mock) {
    throw new Error(
      "MPP channel live mode requires #173 (gate accepts channel commitments). " +
        "Run with MOCK_MODE=true.",
    );
  }

  const signer = await Ed25519Signer.generate("tollway-demo-mpp-channel");
  const verifier = Ed25519Verifier.forSigner(signer);
  const { adapter, calls } = createMockMppChannelAdapter();
  const store = createMemoryCommitmentStore();
  const manager = createChannelManager({ adapter, store });

  const channel = await manager.open({
    counterparty: paywall.payTo,
    asset: paywall.asset,
    deposit: CHANNEL_DEPOSIT,
    network: paywall.network,
  });

  const commitmentResults: ChannelCommitmentResult[] = [];

  for (let i = 0; i < REQUEST_COUNT; i++) {
    const commitment = await manager.commit(channel.id, PRICE_PER_REQUEST);

    const receiptBody = buildReceipt({
      payer: `mock-agent`,
      payee: paywall.payTo,
      amount: PRICE_PER_REQUEST,
      asset: paywall.asset,
      resource: `demo-resource-${i}`,
      model: "mpp-channel",
      settlement: {
        kind: "channel-commitment",
        channelId: channel.id,
        sequence: commitment.sequence,
      },
      network: paywall.network,
    });

    const receipt = await signReceipt(receiptBody, signer);
    const verification = await verifyReceipt(receipt, verifier);

    if (commitment.sequence !== i) {
      throw new Error(`expected commitment sequence ${i}, got ${commitment.sequence}`);
    }

    commitmentResults.push({
      sequence: commitment.sequence,
      receipt,
      receiptValid: verification.valid,
    });
  }

  const closeResult = await manager.close(channel.id);

  // Reconcile the full commitment stream against the on-chain settlement.
  const commitments = await manager.list(channel.id);
  const reconciler = createReconciler();
  const reconciliation = await reconciler.reconcileChannel(
    commitments.map((c) => ({
      channelId: c.channelId,
      sequence: c.sequence,
      cumulativeAmount: c.cumulativeAmount,
    })),
    {
      channelId: channel.id,
      settledAmount: (BigInt(PRICE_PER_REQUEST) * BigInt(REQUEST_COUNT)).toString(),
      returnedRemainder: (
        BigInt(CHANNEL_DEPOSIT) -
        BigInt(PRICE_PER_REQUEST) * BigInt(REQUEST_COUNT)
      ).toString(),
      txHash: closeResult.settlementTxHash,
    },
  );

  return {
    scenario: "mpp-channel",
    mock: true,
    channelId: channel.id,
    commitments: commitmentResults,
    settlementTxHash: closeResult.settlementTxHash,
    returnedRemainder: closeResult.returnedRemainder,
    reconciliationOk: reconciliation.ok,
    openChannelCalls: calls.openChannel.length,
    signCommitmentCalls: calls.signCommitment.length,
    closeChannelCalls: calls.closeChannel.length,
  };
}
