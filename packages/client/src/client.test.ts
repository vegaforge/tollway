import { NotImplementedError } from "@tollway/core";
import { describe, expect, it } from "vitest";
import { createClient } from "./index.js";

describe("createClient", () => {
  it("throws NotImplemented until the agent flow is wired", () => {
    try {
      createClient({ network: "testnet" });
      expect.unreachable("expected createClient to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedError);
      expect((error as NotImplementedError).reference).toContain("design.md");
    }
  });
});
