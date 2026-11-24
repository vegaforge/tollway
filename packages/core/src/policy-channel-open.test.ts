import { describe, expect, it } from "vitest";
import { TollwayError } from "./errors.js";
import { createPolicyEngine, type PaymentIntent, type PolicyEngine } from "./policy.js";
import type { PolicyInput } from "./policy-schema.js";

// #181: headroom and channel-open decisions. A deposit locks funds, so an open
// is checked against what the policy still allows for that asset and payee.
// Opening a channel records no spend.

const ASSET = "USDC:GA5Z";
const PAYEE = "GSERVICE";

function payment(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    payee: PAYEE,
    resource: "/api/quotes",
    amount: "100",
    asset: ASSET,
    model: "x402",
    ...overrides,
  };
}

function engineWith(input: PolicyInput, clock?: () => number): PolicyEngine {
  return createPolicyEngine(input, clock ? { clock } : undefined);
}

function headroomOf(engine: PolicyEngine, asset: string, payee: string) {
  if (engine.headroom === undefined) throw new Error("the engine has no headroom query");
  return engine.headroom(asset, payee);
}

describe("PolicyEngine.headroom", () => {
  it("reports no headroom when the policy sets no ceiling for the asset and payee", async () => {
    const engine = engineWith({});
    await expect(headroomOf(engine, ASSET, PAYEE)).resolves.toEqual({
      asset: ASSET,
      payee: PAYEE,
      headroom: null,
      limitedBy: null,
    });
  });

  it("reports the tightest ceiling as an integer string", async () => {
    const engine = engineWith({
      budgets: { daily: "500", total: "1000" },
      perService: { [PAYEE]: { cap: "300" } },
    });
    await expect(headroomOf(engine, ASSET, PAYEE)).resolves.toMatchObject({
      headroom: "300",
      limitedBy: "per-service",
    });
  });

  it("names the daily budget when it is the tightest", async () => {
    const engine = engineWith({ budgets: { daily: "150", total: "1000" } });
    await expect(headroomOf(engine, ASSET, PAYEE)).resolves.toMatchObject({
      headroom: "150",
      limitedBy: "budget-daily",
    });
  });

  it("shrinks as payments are recorded, and never goes below zero", async () => {
    const engine = engineWith({ budgets: { daily: "150" } });
    await engine.record(payment({ amount: "100" }));
    await expect(headroomOf(engine, ASSET, PAYEE)).resolves.toMatchObject({ headroom: "50" });
    await engine.record(payment({ amount: "100" }));
    await expect(headroomOf(engine, ASSET, PAYEE)).resolves.toMatchObject({ headroom: "0" });
  });

  it("reads only the asset and payee it is asked about", async () => {
    const engine = engineWith({ perService: { [PAYEE]: { cap: "300" } } });
    await engine.record(payment({ payee: "GOTHER", amount: "100" }));
    await expect(headroomOf(engine, ASSET, PAYEE)).resolves.toMatchObject({ headroom: "300" });
  });

  it("resets the daily ceiling when the UTC day changes", async () => {
    let now = new Date("2026-11-24T23:59:00Z").getTime();
    const engine = engineWith({ budgets: { daily: "150" } }, () => now);
    await engine.record(payment({ amount: "100" }));
    expect(await headroomOf(engine, ASSET, PAYEE)).toMatchObject({ headroom: "50" });

    now = new Date("2026-11-25T00:01:00Z").getTime();
    expect(await headroomOf(engine, ASSET, PAYEE)).toMatchObject({ headroom: "150" });
  });
});

describe("PolicyEngine.evaluateChannelOpen", () => {
  it("blocks a deposit above the daily headroom and names the rule", async () => {
    const engine = engineWith({ budgets: { daily: "150" } });
    const decision = await engine.evaluateChannelOpen?.({
      payee: PAYEE,
      asset: ASSET,
      deposit: "200",
    });
    expect(decision).toMatchObject({
      allowed: false,
      wouldBlock: true,
      rule: "budget-daily",
      detail: expect.stringContaining("budget-daily headroom of 150"),
    });
  });

  it("blocks a deposit above a per-service cap, for that payee only", async () => {
    const engine = engineWith({ perService: { [PAYEE]: { cap: "300" } } });
    const over = await engine.evaluateChannelOpen?.({ payee: PAYEE, asset: ASSET, deposit: "400" });
    const other = await engine.evaluateChannelOpen?.({
      payee: "GOTHER",
      asset: ASSET,
      deposit: "400",
    });
    expect(over).toMatchObject({ allowed: false, rule: "per-service" });
    expect(other).toMatchObject({ allowed: true, rule: null });
  });

  it("allows a deposit equal to the headroom", async () => {
    const engine = engineWith({ budgets: { total: "1000" } });
    const decision = await engine.evaluateChannelOpen?.({
      payee: PAYEE,
      asset: ASSET,
      deposit: "1000",
    });
    expect(decision).toMatchObject({ allowed: true, wouldBlock: false, rule: null });
  });

  it("records no spend, so the headroom is the same after an open is evaluated", async () => {
    const engine = engineWith({ budgets: { daily: "150" } });
    await engine.evaluateChannelOpen?.({ payee: PAYEE, asset: ASSET, deposit: "100" });
    await engine.evaluateChannelOpen?.({ payee: PAYEE, asset: ASSET, deposit: "100" });
    expect(await headroomOf(engine, ASSET, PAYEE)).toMatchObject({ headroom: "150" });
  });

  it("reports a would-be block but allows it in dry-run mode", async () => {
    const engine = engineWith({ mode: "dry-run", budgets: { daily: "150" } });
    const decision = await engine.evaluateChannelOpen?.({
      payee: PAYEE,
      asset: ASSET,
      deposit: "200",
    });
    expect(decision).toMatchObject({ allowed: true, wouldBlock: true, rule: "budget-daily" });
  });

  it("rejects a deposit that is not an integer string", async () => {
    const engine = engineWith({});
    await expect(
      engine.evaluateChannelOpen?.({ payee: PAYEE, asset: ASSET, deposit: "1.5" }),
    ).rejects.toMatchObject({ code: "invalid-amount" });
  });

  it("is a TollwayError when a deposit is invalid", async () => {
    const engine = engineWith({});
    const attempt = engine.evaluateChannelOpen?.({ payee: PAYEE, asset: ASSET, deposit: "x" });
    await expect(attempt).rejects.toBeInstanceOf(TollwayError);
  });
});

// The per-service daily and rolling-window caps (#192) bound what may be spent
// with one payee, so a deposit sized past them would lock funds the policy
// will not let the agent spend.
describe("channel opens under per-service daily and window caps", () => {
  it("reports the per-service daily cap as headroom once spend has used part of it", async () => {
    const engine = engineWith({ perService: { [PAYEE]: { dailyCap: "500" } } });
    await engine.record(payment({ amount: "200" }));
    await expect(headroomOf(engine, ASSET, PAYEE)).resolves.toMatchObject({
      headroom: "300",
      limitedBy: "per-service-daily",
    });
    const decision = await engine.evaluateChannelOpen?.({
      payee: PAYEE,
      asset: ASSET,
      deposit: "400",
    });
    expect(decision).toMatchObject({ allowed: false, rule: "per-service-daily" });
  });

  it("reports the per-service rolling window as headroom", async () => {
    const now = Date.parse("2026-11-24T12:00:00.000Z");
    const engine = engineWith(
      { perService: { [PAYEE]: { window: { windowSeconds: 3600, cap: "1000" } } } },
      () => now,
    );
    await engine.record(payment({ amount: "750" }));
    await expect(headroomOf(engine, ASSET, PAYEE)).resolves.toMatchObject({
      headroom: "250",
      limitedBy: "per-service-window",
    });
    const decision = await engine.evaluateChannelOpen?.({
      payee: PAYEE,
      asset: ASSET,
      deposit: "300",
    });
    expect(decision).toMatchObject({ allowed: false, rule: "per-service-window" });
  });
});
