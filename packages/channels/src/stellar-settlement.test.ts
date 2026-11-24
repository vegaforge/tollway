import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { MissingEventHistoryError } from "./errors.js";
import { findSettlementInEvents, type SettlementEventSource } from "./stellar-settlement.js";

const CHANNEL = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const RECIPIENT = Keypair.random().publicKey();
const FUNDER = Keypair.random().publicKey();

type Event = Awaited<ReturnType<SettlementEventSource["getEvents"]>>["events"][number];

/**
 * Events shaped the way the one-way-channel contract emits them: a single
 * symbol topic and a `#[contractevent]` map of fields.
 */
function event(
  name: string,
  fields: Record<string, unknown>,
  types: NonNullable<Parameters<typeof nativeToScVal>[1]>["type"],
  tx: { txHash: string; ledger: number; ok?: boolean },
): Event {
  return {
    topic: [xdr.ScVal.scvSymbol(name)],
    value: nativeToScVal(fields, { type: types }),
    txHash: tx.txHash,
    ledger: tx.ledger,
    inSuccessfulContractCall: tx.ok ?? true,
  };
}

const withdraw = (amount: bigint, tx: { txHash: string; ledger: number; ok?: boolean }) =>
  event(
    "withdraw",
    { to: RECIPIENT, amount },
    { to: ["symbol", "address"], amount: ["symbol", "i128"] },
    tx,
  );
const close = (effectiveAtLedger: number, tx: { txHash: string; ledger: number; ok?: boolean }) =>
  event(
    "close",
    { effective_at_ledger: effectiveAtLedger },
    { effective_at_ledger: ["symbol", "u32"] },
    tx,
  );
const refund = (amount: bigint, tx: { txHash: string; ledger: number; ok?: boolean }) =>
  event(
    "refund",
    { from: FUNDER, amount },
    { from: ["symbol", "address"], amount: ["symbol", "i128"] },
    tx,
  );

/** An RPC that serves the given events in pages of `pageSize`. */
function source(events: Event[], options: { oldestLedger?: number; pageSize?: number } = {}) {
  const requests: Array<{ startLedger?: number; cursor?: string; limit?: number }> = [];
  const pageSize = options.pageSize ?? events.length + 1;
  const src: SettlementEventSource = {
    async getHealth() {
      return { oldestLedger: options.oldestLedger ?? 1, latestLedger: 10_000 };
    },
    async getEvents(request) {
      requests.push({
        ...(request.startLedger === undefined ? {} : { startLedger: request.startLedger }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
      });
      const offset = request.cursor === undefined ? 0 : Number(request.cursor);
      // The fake honours the page size the lookup asks for, capped by its own.
      const size = Math.min(pageSize, request.limit ?? pageSize);
      const page = events.slice(offset, offset + size);
      return { events: page, cursor: String(offset + page.length) };
    },
  };
  return { src, requests };
}

describe("findSettlementInEvents", () => {
  it("reads the settlement a close made: payout, close effective now, refund", async () => {
    const tx = { txHash: "a".repeat(64), ledger: 500 };
    const { src, requests } = source([withdraw(400n, tx), close(500, tx), refund(600n, tx)]);
    await expect(
      findSettlementInEvents({ source: src, channelId: CHANNEL, startLedger: 450 }),
    ).resolves.toEqual({
      settlementTxHash: tx.txHash,
      settledAmount: "400",
      returnedRemainder: "600",
      settledAtLedger: 500,
    });
    expect(requests[0]).toEqual({ startLedger: 450, limit: 200 });
  });

  it("does not take a close_start, which is effective later, for a settlement", async () => {
    const { src } = source([close(900, { txHash: "b".repeat(64), ledger: 500 })]);
    await expect(
      findSettlementInEvents({ source: src, channelId: CHANNEL, startLedger: 450 }),
    ).resolves.toBeNull();
  });

  it("does not take a funder's refund for a settlement", async () => {
    const { src } = source([refund(1000n, { txHash: "c".repeat(64), ledger: 700 })]);
    await expect(
      findSettlementInEvents({ source: src, channelId: CHANNEL, startLedger: 450 }),
    ).resolves.toBeNull();
  });

  it("ignores events from a failed contract call", async () => {
    const tx = { txHash: "d".repeat(64), ledger: 500, ok: false };
    const { src } = source([withdraw(400n, tx), close(500, tx)]);
    await expect(
      findSettlementInEvents({ source: src, channelId: CHANNEL, startLedger: 450 }),
    ).resolves.toBeNull();
  });

  it("reports zero remainder when the contract had nothing left to refund", async () => {
    const tx = { txHash: "e".repeat(64), ledger: 500 };
    const { src } = source([withdraw(1000n, tx), close(500, tx)]);
    await expect(
      findSettlementInEvents({ source: src, channelId: CHANNEL, startLedger: 1 }),
    ).resolves.toMatchObject({ settledAmount: "1000", returnedRemainder: "0" });
  });

  it("joins one transaction's events across a page boundary", async () => {
    const tx = { txHash: "f".repeat(64), ledger: 500 };
    const noise = Array.from({ length: 199 }, (_, index) =>
      close(9_000, { txHash: index.toString(16).padStart(64, "0"), ledger: 300 }),
    );
    const { src, requests } = source(
      [...noise, withdraw(400n, tx), close(500, tx), refund(600n, tx)],
      {
        pageSize: 200,
      },
    );
    await expect(
      findSettlementInEvents({ source: src, channelId: CHANNEL, startLedger: 1 }),
    ).resolves.toMatchObject({ settledAmount: "400", returnedRemainder: "600" });
    expect(requests[1]).toEqual({ cursor: "200", limit: 200 });
  });

  it("refuses to answer when the RPC no longer keeps events back to the start ledger", async () => {
    const { src, requests } = source([], { oldestLedger: 451 });
    await expect(
      findSettlementInEvents({ source: src, channelId: CHANNEL, startLedger: 450 }),
    ).rejects.toBeInstanceOf(MissingEventHistoryError);
    expect(requests).toHaveLength(0);
  });

  it("refuses a known event it cannot read instead of guessing", async () => {
    const tx = { txHash: "9".repeat(64), ledger: 500 };
    const odd = event("withdraw", { to: RECIPIENT }, { to: ["symbol", "address"] }, tx);
    const { src } = source([odd, close(500, tx)]);
    await expect(
      findSettlementInEvents({ source: src, channelId: CHANNEL, startLedger: 1 }),
    ).rejects.toThrow("cannot read");
  });
});
