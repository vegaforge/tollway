import { NotImplementedError } from "@tollway/core";
import { describe, expect, it } from "vitest";
import { createChannelManager } from "./index.js";

describe("createChannelManager", () => {
  it("throws NotImplemented until the lifecycle is built", () => {
    try {
      createChannelManager({ drawdownThreshold: 0.9 });
      expect.unreachable("expected createChannelManager to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedError);
      expect((error as NotImplementedError).reference).toContain("design.md");
    }
  });
});
