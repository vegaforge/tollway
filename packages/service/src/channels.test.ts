import {
  type CloseAdapterInput,
  type CloseAdapterResult,
  type CommitmentStore,
  createChannelManager,
  createMemoryCommitmentStore,
  type MppChannelAdapter,
} from "@vegaforge/tollway-channels";
import type { TollwayEventInput } from "@vegaforge/tollway-observability";
import { describe, expect, it, vi } from "vitest";
import { createChannelsModule } from "./channels.js";
import type { OpenApiDocument } from "./openapi.js";
import { bearer, KEYS, testService } from "./test-support.js";

const ASSET = "CUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

/**
 * A fake adapter in the shape the channels package's own tests use. `close`
 * can be held open so a test decides how many close requests are in flight.
 */
function fakeAdapter(
  close?: (input: CloseAdapterInput) => Promise<CloseAdapterResult>,
  chainRead?: () => Promise<void>,
) {
  let opened = 0;
  let ledger = 1_000;
  const closeChannel = vi.fn(async (input: CloseAdapterInput): Promise<CloseAdapterResult> => {
    if (close) return close(input);
    return {
      settlementTxHash: `tx-close-${input.channelId}`,
      settledAmount: input.cumulativeAmount,
      returnedRemainder: (BigInt(input.deposit) - BigInt(input.cumulativeAmount)).toString(),
    };
  });
  const adapter: MppChannelAdapter = {
    async openChannel() {
      opened += 1;
      return { channelId: `CH${String(opened).padStart(3, "0")}`, openTxHash: `tx-open-${opened}` };
    },
    async signCommitment(input) {
      return { commitment: `sig:${input.channelId}:${input.cumulativeAmount}` };
    },
    closeChannel,
    async getChannelState() {
      await chainRead?.();
      ledger += 1;
      return { balance: "0", currentLedger: ledger };
    },
    async findChannelSettlement() {
      return null;
    },
  };
  return { adapter, closeChannel };
}

async function setup(options?: {
  close?: (input: CloseAdapterInput) => Promise<CloseAdapterResult>;
  /** Runs inside every chain read, which the manager makes between its status check and its write. */
  chainRead?: () => Promise<void>;
  emit?: (event: TollwayEventInput) => Promise<unknown>;
}) {
  const store: CommitmentStore = createMemoryCommitmentStore();
  const { adapter, closeChannel } = fakeAdapter(options?.close, options?.chainRead);
  let tick = 0;
  const manager = createChannelManager({
    adapter,
    store,
    // A distinct openedAt per channel, so newest-first order is defined.
    now: () => new Date(Date.UTC(2026, 10, 24, 0, 0, tick++)).toISOString(),
  });
  const emit = vi.fn(options?.emit ?? (async () => ({ deliveries: [], failures: [] })));
  const { app, logger } = await testService({
    channelManager: manager,
    observability: { emit: emit as never },
    modules: [createChannelsModule({ now: () => "2026-11-24T12:00:00.000Z" })],
  });
  return { app, manager, store, closeChannel, emit, logger };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("GET /v1/channels", () => {
  it("lists channels newest first with remaining and shouldClose", async () => {
    const { app, manager } = await setup();
    const a = await manager.open({
      counterparty: "GPAYEEA",
      asset: ASSET,
      deposit: "1000",
      network: "testnet",
    });
    await manager.commit(a.id, "300");
    const b = await manager.open({
      counterparty: "GPAYEEB",
      asset: ASSET,
      deposit: "500",
      network: "testnet",
    });

    const response = await app.request("/v1/channels", { headers: bearer(KEYS.reader) });
    expect(response.status).toBe(200);
    const body = await json(response);
    const channels = body.channels as Array<Record<string, unknown>>;
    expect(channels.map((channel) => channel.id)).toEqual([b.id, a.id]);
    expect(channels[1]).toMatchObject({
      deposit: "1000",
      committed: "300",
      remaining: "700",
      shouldClose: false,
      status: "open",
    });
    expect(body).not.toHaveProperty("nextCursor");
  });

  it.each([
    ["status", "closed", ["CH002"]],
    ["counterparty", "GPAYEEA", ["CH001"]],
    ["asset", "COTHER", []],
  ])("filters by %s", async (filter, value, ids) => {
    const { app, manager } = await setup();
    await manager.open({
      counterparty: "GPAYEEA",
      asset: ASSET,
      deposit: "10",
      network: "testnet",
    });
    const b = await manager.open({
      counterparty: "GPAYEEB",
      asset: ASSET,
      deposit: "10",
      network: "testnet",
    });
    await manager.close(b.id);

    const response = await app.request(`/v1/channels?${filter}=${value}`, {
      headers: bearer(KEYS.reader),
    });
    const channels = (await json(response)).channels as Array<{ id: string }>;
    expect(channels.map((channel) => channel.id)).toEqual(ids);
  });

  it("pages with a cursor and refuses a cursor it did not issue", async () => {
    const { app, manager } = await setup();
    for (let i = 0; i < 3; i += 1) {
      await manager.open({ counterparty: "GP", asset: ASSET, deposit: "10", network: "testnet" });
    }
    const first = await json(
      await app.request("/v1/channels?limit=2", { headers: bearer(KEYS.reader) }),
    );
    expect((first.channels as Array<{ id: string }>).map((c) => c.id)).toEqual(["CH003", "CH002"]);
    const second = await json(
      await app.request(`/v1/channels?limit=2&cursor=${first.nextCursor as string}`, {
        headers: bearer(KEYS.reader),
      }),
    );
    expect((second.channels as Array<{ id: string }>).map((c) => c.id)).toEqual(["CH001"]);
    expect(second).not.toHaveProperty("nextCursor");

    const bad = await app.request("/v1/channels?cursor=not-a-cursor", {
      headers: bearer(KEYS.reader),
    });
    expect(bad.status).toBe(400);
  });
});

describe("GET /v1/channels/{id} and its commitments", () => {
  it("returns one channel, and 404 for an unknown id", async () => {
    const { app, manager } = await setup();
    const a = await manager.open({
      counterparty: "GP",
      asset: ASSET,
      deposit: "10",
      network: "testnet",
    });
    const found = await app.request(`/v1/channels/${a.id}`, { headers: bearer(KEYS.reader) });
    expect(found.status).toBe(200);
    expect(await json(found)).toMatchObject({ id: a.id, remaining: "10" });

    const missing = await app.request("/v1/channels/CHNONE", { headers: bearer(KEYS.reader) });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ error: { code: "not-found" } });
  });

  it("pages the commitment stream by sequence, without the blob by default", async () => {
    const { app, manager } = await setup();
    const a = await manager.open({
      counterparty: "GP",
      asset: ASSET,
      deposit: "100",
      network: "testnet",
    });
    for (const amount of ["10", "20", "30"]) await manager.commit(a.id, amount);

    const first = await json(
      await app.request(`/v1/channels/${a.id}/commitments?limit=2`, {
        headers: bearer(KEYS.reader),
      }),
    );
    const page = first.commitments as Array<Record<string, unknown>>;
    expect(page.map((commitment) => commitment.cumulativeAmount)).toEqual(["10", "30"]);
    expect(page[0]).not.toHaveProperty("commitment");

    const rest = await json(
      await app.request(
        `/v1/channels/${a.id}/commitments?limit=2&cursor=${first.nextCursor as string}`,
        { headers: bearer(KEYS.reader) },
      ),
    );
    expect((rest.commitments as Array<Record<string, unknown>>).map((c) => c.sequence)).toEqual([
      2,
    ]);
    expect(rest).not.toHaveProperty("nextCursor");
  });

  it("includes the signed blob only for an admin key", async () => {
    const { app, manager } = await setup();
    const a = await manager.open({
      counterparty: "GP",
      asset: ASSET,
      deposit: "100",
      network: "testnet",
    });
    await manager.commit(a.id, "10");

    const reader = await app.request(`/v1/channels/${a.id}/commitments?include=blob`, {
      headers: bearer(KEYS.reader),
    });
    expect(reader.status).toBe(403);

    const admin = await json(
      await app.request(`/v1/channels/${a.id}/commitments?include=blob`, {
        headers: bearer(KEYS.admin),
      }),
    );
    expect((admin.commitments as Array<Record<string, unknown>>)[0]).toMatchObject({
      commitment: `sig:${a.id}:10`,
    });
  });

  it("returns 404 for the commitments of an unknown channel", async () => {
    const { app } = await setup();
    const response = await app.request("/v1/channels/CHNONE/commitments", {
      headers: bearer(KEYS.reader),
    });
    expect(response.status).toBe(404);
  });
});

describe("POST /v1/channels/{id}/close", () => {
  it("closes an open channel, records who asked, and emits channel.closed", async () => {
    const { app, manager, emit } = await setup();
    const a = await manager.open({
      counterparty: "GP",
      asset: ASSET,
      deposit: "100",
      network: "testnet",
    });
    await manager.commit(a.id, "40");

    const response = await app.request(`/v1/channels/${a.id}/close`, {
      method: "POST",
      headers: bearer(KEYS.admin),
    });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      id: a.id,
      status: "closed",
      settlementTxHash: `tx-close-${a.id}`,
      returnedRemainder: "60",
      closeRequest: { requestedBy: "admin", requestedAt: "2026-11-24T12:00:00.000Z" },
    });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      type: "channel.closed",
      data: { channelId: a.id, returnedRemainder: "60", requestedBy: "admin" },
    });
  });

  it("returns the closed channel on a second request and never closes twice", async () => {
    const { app, manager, closeChannel, emit } = await setup();
    const a = await manager.open({
      counterparty: "GP",
      asset: ASSET,
      deposit: "100",
      network: "testnet",
    });
    const close = () =>
      app.request(`/v1/channels/${a.id}/close`, { method: "POST", headers: bearer(KEYS.admin) });

    expect((await close()).status).toBe(200);
    const again = await close();
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ status: "closed" });
    expect(closeChannel).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("submits exactly one close across concurrent requests", async () => {
    // The manager checks the status, reads the chain, then marks the channel
    // closing. Holding the chain read keeps every request inside that window,
    // so only the service's per-channel guard can stop a second close.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = false;
    const chainReads = vi.fn(async () => {
      if (holding) await held;
    });
    const { app, manager, closeChannel } = await setup({ chainRead: chainReads });
    const a = await manager.open({
      counterparty: "GP",
      asset: ASSET,
      deposit: "100",
      network: "testnet",
    });
    holding = true;

    const requests = Array.from({ length: 5 }, () =>
      app.request(`/v1/channels/${a.id}/close`, { method: "POST", headers: bearer(KEYS.admin) }),
    );
    await vi.waitFor(() => expect(chainReads).toHaveBeenCalled());
    // Give every request time to reach the manager before the chain answers.
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const responses = await Promise.all(requests);

    expect(closeChannel).toHaveBeenCalledTimes(1);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
  });

  it("refuses a channel in recovering with 409", async () => {
    const { app, manager, store, closeChannel } = await setup();
    const a = await manager.open({
      counterparty: "GP",
      asset: ASSET,
      deposit: "100",
      network: "testnet",
    });
    await store.updateChannel(a.id, { status: "recovering" });

    const response = await app.request(`/v1/channels/${a.id}/close`, {
      method: "POST",
      headers: bearer(KEYS.admin),
    });
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      error: { code: "conflict", details: { status: "recovering" } },
    });
    expect(closeChannel).not.toHaveBeenCalled();
  });

  it("needs the admin scope", async () => {
    const { app, manager, closeChannel } = await setup();
    const a = await manager.open({
      counterparty: "GP",
      asset: ASSET,
      deposit: "100",
      network: "testnet",
    });
    const response = await app.request(`/v1/channels/${a.id}/close`, {
      method: "POST",
      headers: bearer(KEYS.reader),
    });
    expect(response.status).toBe(403);
    expect(closeChannel).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown channel", async () => {
    const { app } = await setup();
    const response = await app.request("/v1/channels/CHNONE/close", {
      method: "POST",
      headers: bearer(KEYS.admin),
    });
    expect(response.status).toBe(404);
  });

  it("reports a failed close with the channel's current status, and logs the cause", async () => {
    const { app, manager, emit, logger } = await setup({
      close: async () => {
        throw new Error("rpc unavailable");
      },
    });
    const a = await manager.open({
      counterparty: "GP",
      asset: ASSET,
      deposit: "100",
      network: "testnet",
    });

    const response = await app.request(`/v1/channels/${a.id}/close`, {
      method: "POST",
      headers: bearer(KEYS.admin),
    });
    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body).toMatchObject({ error: { code: "close-failed" } });
    expect(JSON.stringify(body)).not.toContain("rpc unavailable");
    expect(emit).not.toHaveBeenCalled();
    expect(logger.lines.some((line) => line.event === "channel-close-failed")).toBe(true);
  });
});

describe("channels module wiring", () => {
  it("refuses to build without a channel manager", async () => {
    await expect(testService({ modules: [createChannelsModule()] })).rejects.toThrow(
      /channelManager/,
    );
  });

  it("publishes every channel route in /openapi.json", async () => {
    const { app } = await setup();
    const document = (await json(await app.request("/openapi.json"))) as unknown as OpenApiDocument;
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/v1/channels",
        "/v1/channels/{id}",
        "/v1/channels/{id}/commitments",
        "/v1/channels/{id}/close",
      ]),
    );
    const close = document.paths["/v1/channels/{id}/close"]?.post as Record<string, unknown>;
    expect(close["x-tollway-scope"]).toBe("admin");
  });
});
