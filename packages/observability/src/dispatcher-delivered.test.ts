import { describe, expect, it, vi } from "vitest";
import { createWebhookDispatcher } from "./dispatcher.js";
import type { TollwayEvent } from "./events.js";
import type { WebhookSubscription } from "./index.js";
import { createMemoryWebhookOutbox } from "./outbox.js";

const event: TollwayEvent = {
  id: "evt-1",
  type: "receipt.created",
  at: "2026-11-23T00:00:00.000Z",
  data: {},
};

const subscription: WebhookSubscription = { id: "sub-1", url: "https://example.test/hook" };

describe("webhook dispatcher onDelivered", () => {
  it("reports a delivery once it is recorded as delivered", async () => {
    const outbox = createMemoryWebhookOutbox();
    const onDelivered = vi.fn();
    const dispatcher = createWebhookDispatcher({
      outbox,
      resolveSubscription: () => subscription,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
      requestTimeoutMs: 1_000,
      onDelivered,
    });
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);
    expect(await dispatcher.drainOnce()).toBe(1);
    expect(onDelivered).toHaveBeenCalledTimes(1);
    expect(onDelivered.mock.calls[0]?.[0]).toMatchObject({ subscriptionId: "sub-1" });
  });

  it("does not report a failed attempt as delivered", async () => {
    const outbox = createMemoryWebhookOutbox();
    const onDelivered = vi.fn();
    const dispatcher = createWebhookDispatcher({
      outbox,
      resolveSubscription: () => subscription,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
      requestTimeoutMs: 1_000,
      onDelivered,
    });
    await outbox.enqueue([{ subscriptionId: "sub-1", event }]);
    await dispatcher.drainOnce();
    expect(onDelivered).not.toHaveBeenCalled();
  });
});
