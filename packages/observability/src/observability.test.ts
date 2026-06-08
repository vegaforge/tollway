import { NotImplementedError } from "@tollway/core";
import { describe, expect, it } from "vitest";
import { createObservabilityHub, webhookEvents } from "./index.js";

describe("observability", () => {
  it("lists the webhook events from the design document", () => {
    expect(webhookEvents).toContain("receipt.created");
    expect(webhookEvents).toContain("anomaly.detected");
    expect(webhookEvents).toHaveLength(5);
  });

  it("throws NotImplemented until the hub is built", () => {
    try {
      createObservabilityHub();
      expect.unreachable("expected createObservabilityHub to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedError);
      expect((error as NotImplementedError).reference).toContain("design.md");
    }
  });
});
