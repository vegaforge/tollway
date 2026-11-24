import { verifyReceipt } from "@vegaforge/tollway-core";
import { describe, expect, it } from "vitest";
import { type CliDeps, runCli, scenarioFromArgs } from "./run-cli.js";
import { runAllModels } from "./scenarios/all-models.js";
import { runMppChargeScenario } from "./scenarios/mpp-charge.js";

function deps(overrides: Partial<CliDeps> = {}): CliDeps & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    env: { MOCK_MODE: "true" },
    output: { log: (line) => lines.push(line), error: (line) => errors.push(line) },
    runAllModels,
    ...overrides,
    lines,
    errors,
  };
}

describe("scenarioFromArgs", () => {
  it.each([
    [[], "x402"],
    [["--"], "x402"],
    [["mpp-charge"], "mpp-charge"],
    [["--", "all-models"], "all-models"],
  ])("reads %j as %s", (args, expected) => {
    expect(scenarioFromArgs(args)).toBe(expected);
  });
});

describe("runCli", () => {
  it("keeps the original x402 run as the default", async () => {
    const run = deps();
    expect(await runCli([], run)).toBe(0);
    expect(run.lines).toContain("Receipt signature valid: true");
  });

  it("runs all-models in mock mode and exits 0 when every receipt verifies", async () => {
    const run = deps();
    expect(await runCli(["--", "all-models"], run)).toBe(0);
    expect(run.lines).toContain("All receipts valid: true");
  });

  it("exits non-zero when a receipt was tampered with after signing", async () => {
    // Change a signed field, then verify against the service's real key:
    // the signature no longer covers the body, so the run must fail.
    const tampered = async () => {
      const result = await runMppChargeScenario();
      const receipt = {
        ...result.receipt,
        receipt: { ...result.receipt.receipt, amount: "1" },
      };
      const verdict = await verifyReceipt(receipt, result.verifier);
      return { ...result, receipt, receiptValid: verdict.valid };
    };
    const run = deps({ runAllModels: () => runAllModels([tampered]) });

    expect(await runCli(["all-models"], run)).toBe(1);
    expect(run.lines).toContain("All receipts valid: false");
  });

  it("refuses the mock-only scenarios outside mock mode", async () => {
    for (const scenario of ["mpp-charge", "all-models"]) {
      const run = deps({ env: {} });
      expect(await runCli([scenario], run)).toBe(1);
      expect(run.errors.join("\n")).toMatch(/mock mode only/);
    }
  });

  it("names the valid scenarios for an unknown one", async () => {
    const run = deps();
    expect(await runCli(["mpp-channel"], run)).toBe(1);
    expect(run.errors.join("\n")).toMatch(/x402, mpp-charge, all-models/);
  });
});
