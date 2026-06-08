import { NotImplementedError } from "@tollway/core";
import type { Gate } from "@tollway/server";
import { describe, expect, it } from "vitest";
import { honoPaywall } from "./index.js";

const noopGate: Gate = async () => ({ kind: "rejected", status: 500, reason: "unused" });

describe("honoPaywall", () => {
  it("throws NotImplemented until the adapter is built (good first issue)", () => {
    try {
      honoPaywall(noopGate);
      expect.unreachable("expected honoPaywall to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedError);
      expect((error as NotImplementedError).reference).toContain("design.md");
    }
  });
});
