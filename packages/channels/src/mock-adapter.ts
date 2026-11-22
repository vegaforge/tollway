/**
 * Offline mock adapter for the MPP channel lifecycle manager.
 *
 * All ids and commitment blobs are derived from their inputs through FNV-1a,
 * so runs and retries are reproducible without any network access. The adapter
 * counts its calls so tests can assert the single-settlement property.
 *
 * This adapter is for testing and the offline demo only. Never use it in a
 * production code path: it does not submit anything on-chain, so "settlement"
 * is a local fiction.
 *
 * See docs/design.md, "The channel lifecycle manager".
 */

import type {
  CloseAdapterInput,
  CloseAdapterResult,
  MppChannelAdapter,
  OpenAdapterInput,
  OpenAdapterResult,
  SignCommitmentInput,
  SignedCommitment,
} from "./adapter.js";
import { mockContractId, mockHex } from "./hash.js";

/**
 * Counters exposed by the mock adapter so tests can assert call counts without
 * inspecting the channel manager's internal state.
 */
export type MockMppChannelAdapterCalls = {
  readonly openChannel: readonly OpenAdapterInput[];
  readonly signCommitment: readonly SignCommitmentInput[];
  readonly closeChannel: readonly CloseAdapterInput[];
};

/**
 * What `createMockMppChannelAdapter` returns: the adapter to pass into
 * `createChannelManager`, and the call log for assertions.
 */
export type MockMppChannelAdapter = {
  adapter: MppChannelAdapter;
  calls: MockMppChannelAdapterCalls;
};

/**
 * Creates a deterministic offline adapter for `createChannelManager`.
 *
 * - `openChannel` returns a contract id and tx hash derived from the inputs.
 *   It never touches the network.
 * - `signCommitment` returns a commitment blob encoding the channel id,
 *   cumulative amount and sequence; no on-chain simulation is run.
 * - `closeChannel` settles exactly `cumulativeAmount` and returns the correct
 *   remainder without any Stellar transaction. `settledAmount` always equals
 *   `cumulativeAmount`, so `createChannelManager().close` will not throw
 *   `SettlementMismatchError` under normal use.
 *
 * Usage:
 * ```ts
 * import { createMockMppChannelAdapter } from "@vegaforge/tollway-channels";
 * import { createChannelManager } from "@vegaforge/tollway-channels";
 *
 * const { adapter, calls } = createMockMppChannelAdapter();
 * const manager = createChannelManager({ adapter });
 * ```
 */
export function createMockMppChannelAdapter(): MockMppChannelAdapter {
  const openCalls: OpenAdapterInput[] = [];
  const signCalls: SignCommitmentInput[] = [];
  const closeCalls: CloseAdapterInput[] = [];

  let openCount = 0;
  let closeCount = 0;

  const adapter: MppChannelAdapter = {
    async openChannel(input: OpenAdapterInput): Promise<OpenAdapterResult> {
      openCalls.push(input);
      openCount += 1;
      const seed = `${input.counterparty}:${input.asset}:${input.deposit}:${openCount}`;
      return {
        channelId: mockContractId(seed),
        openTxHash: mockHex(`open:${seed}`),
      };
    },

    async signCommitment(input: SignCommitmentInput): Promise<SignedCommitment> {
      signCalls.push(input);
      // The blob encodes channel id and cumulative amount so the manager's
      // reconciliation tests can inspect it without opaque bytes.
      const commitment = `mock:${input.channelId}:${input.cumulativeAmount}`;
      return { commitment };
    },

    async closeChannel(input: CloseAdapterInput): Promise<CloseAdapterResult> {
      closeCalls.push(input);
      closeCount += 1;
      const deposit = BigInt(input.deposit);
      const cumulative = BigInt(input.cumulativeAmount);
      const remainder = deposit >= cumulative ? deposit - cumulative : 0n;
      return {
        settlementTxHash: mockHex(
          `close:${input.channelId}:${input.cumulativeAmount}:${closeCount}`,
        ),
        settledAmount: input.cumulativeAmount,
        returnedRemainder: remainder.toString(),
      };
    },
  };

  return {
    adapter,
    calls: {
      get openChannel() {
        return openCalls as readonly OpenAdapterInput[];
      },
      get signCommitment() {
        return signCalls as readonly SignCommitmentInput[];
      },
      get closeChannel() {
        return closeCalls as readonly CloseAdapterInput[];
      },
    },
  };
}
