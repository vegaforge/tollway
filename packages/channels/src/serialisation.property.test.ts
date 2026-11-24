import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CloseAdapterInput, MppChannelAdapter } from "./adapter.js";
import { ChannelNotOpenError, CommitmentExceedsDepositError } from "./errors.js";
import { createChannelManager } from "./manager.js";

/**
 * #175: for any interleaving of commits and one close on a channel, started
 * together, the manager behaves as if each call ran alone in the order it was
 * made. The per-channel queue gives that order, so the outcome is fully
 * predictable: the property checks it against a plain sequential model.
 *
 * Signing and closing each wait a random few milliseconds, so the calls really
 * overlap in time. Without the queue, two commits read the same sequence and
 * the compare-and-set refuses one of them, which this model does not expect.
 */

type Step =
  | { kind: "commit"; amount: bigint; delayMs: number }
  | { kind: "close"; delayMs: number };

type Expected =
  | { kind: "accepted"; sequence: number; cumulative: bigint }
  | { kind: "exceeds-deposit" }
  | { kind: "not-open" }
  | { kind: "closed"; settled: bigint };

/** What each call must return, running the steps one at a time in call order. */
function model(deposit: bigint, steps: readonly Step[]): Expected[] {
  let cumulative = 0n;
  let sequence = 0;
  let open = true;
  return steps.map((step): Expected => {
    if (step.kind === "close") {
      open = false;
      return { kind: "closed", settled: cumulative };
    }
    if (!open) return { kind: "not-open" };
    if (cumulative + step.amount > deposit) return { kind: "exceeds-deposit" };
    cumulative += step.amount;
    const accepted: Expected = { kind: "accepted", sequence, cumulative };
    sequence += 1;
    return accepted;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A fake adapter whose sign and close calls take the delay the step chose. */
function delayedAdapter(delays: { sign: number[]; close: number[] }) {
  const closeCalls: CloseAdapterInput[] = [];
  let ledger = 100_000;
  const adapter: MppChannelAdapter = {
    async openChannel() {
      return { channelId: "CPROP001", openTxHash: "tx-open" };
    },
    async getChannelState() {
      ledger += 1;
      return { balance: "0", currentLedger: ledger };
    },
    async findChannelSettlement() {
      return null;
    },
    // These properties exercise commit and close only; recovery fails loudly.
    async getState() {
      throw new Error("the serialisation properties do not read recovery state");
    },
    async startClose() {
      throw new Error("the serialisation properties do not start a funder close");
    },
    async refund() {
      throw new Error("the serialisation properties do not refund");
    },
    async signCommitment(input) {
      await sleep(delays.sign.shift() ?? 0);
      return { commitment: `sig:${input.channelId}:${input.cumulativeAmount}` };
    },
    async closeChannel(input) {
      closeCalls.push(input);
      await sleep(delays.close.shift() ?? 0);
      return {
        settlementTxHash: "tx-close",
        settledAmount: input.cumulativeAmount,
        returnedRemainder: (BigInt(input.deposit) - BigInt(input.cumulativeAmount)).toString(),
      };
    },
  };
  return { adapter, closeCalls };
}

const commitStep = fc.record({
  kind: fc.constant("commit" as const),
  amount: fc.bigInt({ min: 1n, max: 400n }),
  delayMs: fc.integer({ min: 0, max: 3 }),
});

const scenario = fc
  .record({
    deposit: fc.bigInt({ min: 1n, max: 1_000n }),
    commits: fc.array(commitStep, { minLength: 0, maxLength: 8 }),
    closeAt: fc.nat(),
    closeDelayMs: fc.integer({ min: 0, max: 3 }),
  })
  .map(({ deposit, commits, closeAt, closeDelayMs }) => {
    const at = closeAt % (commits.length + 1);
    const steps: Step[] = [
      ...commits.slice(0, at),
      { kind: "close", delayMs: closeDelayMs },
      ...commits.slice(at),
    ];
    return { deposit, steps };
  });

describe("ChannelManager serialisation property (#175)", () => {
  it("matches the sequential model for any interleaving of commits and one close", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ deposit, steps }) => {
        const delays = {
          sign: steps.flatMap((s) => (s.kind === "commit" ? [s.delayMs] : [])),
          close: steps.flatMap((s) => (s.kind === "close" ? [s.delayMs] : [])),
        };
        const { adapter, closeCalls } = delayedAdapter(delays);
        const manager = createChannelManager({ adapter });
        const channel = await manager.open({
          counterparty: "GPROP",
          asset: "USDC",
          deposit: deposit.toString(),
          network: "testnet",
        });

        // Every call starts before any of them settles.
        const results = await Promise.allSettled(
          steps.map((step) =>
            step.kind === "commit"
              ? manager.commit(channel.id, step.amount.toString())
              : manager.close(channel.id),
          ),
        );

        const expected = model(deposit, steps);
        results.forEach((result, i) => {
          const want = expected[i];
          if (want?.kind === "accepted") {
            expect(result).toMatchObject({
              status: "fulfilled",
              value: { sequence: want.sequence, cumulativeAmount: want.cumulative.toString() },
            });
          } else if (want?.kind === "closed") {
            expect(result.status).toBe("fulfilled");
          } else {
            expect(result.status).toBe("rejected");
            const reason = (result as PromiseRejectedResult).reason;
            expect(reason).toBeInstanceOf(
              want?.kind === "exceeds-deposit"
                ? CommitmentExceedsDepositError
                : ChannelNotOpenError,
            );
          }
        });

        // The stream has no gap or duplicate, and never passes the deposit.
        const stream = await manager.list(channel.id);
        expect(stream.map((c) => c.sequence)).toEqual(stream.map((_, i) => i));
        const accepted = expected.flatMap((e) => (e.kind === "accepted" ? [e] : []));
        expect(stream.map((c) => c.cumulativeAmount)).toEqual(
          accepted.map((e) => e.cumulative.toString()),
        );
        for (const c of stream) expect(BigInt(c.cumulativeAmount) <= deposit).toBe(true);

        // One close, settling exactly what was recorded before it.
        const closed = expected.find((e) => e.kind === "closed");
        expect(closeCalls).toHaveLength(1);
        expect(closeCalls[0]?.cumulativeAmount).toBe(
          closed?.kind === "closed" ? closed.settled.toString() : undefined,
        );
      }),
      { numRuns: 60 },
    );
  });
});
