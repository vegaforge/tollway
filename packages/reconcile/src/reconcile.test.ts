import { NotImplementedError } from "@tollway/core";
import { describe, expect, it } from "vitest";
import { createReconciler } from "./index.js";

describe("createReconciler", () => {
  it("throws NotImplemented until the engine is built", () => {
    try {
      createReconciler();
      expect.unreachable("expected createReconciler to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(NotImplementedError);
      expect((error as NotImplementedError).reference).toContain("design.md");
    }
  });
});
