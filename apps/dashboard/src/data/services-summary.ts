import type { ModelStats, ServiceSummary } from "./services";
import { describe, expect, it } from "vitest"; // ADAPT: use jest if that's what the dashboard uses
import { SERVICES_STUB } from "./services";
import { formatMicros, modelMix, totalMicros } from "./services-summary";

describe("services summary", () => {
  it("formats micro-units exactly", () => {
    expect(formatMicros("1250000000")).toBe("$1,250.00");
    expect(formatMicros("74000000")).toBe("$74.00");
    expect(formatMicros("0")).toBe("$0.00");
  });

  it("stays exact above 2^53", () => {
    expect(formatMicros("9007199254740993000000")).toBe("$9,007,199,254,740,993.00");
  });

  it("totals revenue across payees", () => {
    const llm = SERVICES_STUB.find((s) => s.serviceId === "svc-llm")!;
    expect(formatMicros(totalMicros(llm))).toBe("$5,209.75");
  });

  it("computes the settlement mix from call counts", () => {
    const geocode = SERVICES_STUB.find((s) => s.serviceId === "svc-geocode")!;
    expect(modelMix(geocode.models)).toEqual([
      { model: "per-request", percent: 18 },
      { model: "channel", percent: 82 },
    ]);
  });

  it("returns an empty mix for services with no calls", () => {
    expect(modelMix([])).toEqual([]);
  });

  it("stub data is deterministic", () => {
    expect(JSON.stringify(SERVICES_STUB)).toBe(JSON.stringify(SERVICES_STUB));
  });
});

/** "1250000000" -> "$1,250.00" (6 decimals, exact). ADAPT currency symbol/units. */
export function formatMicros(micros: string): string {
  const v = BigInt(micros);
  const whole = v / 1_000_000n;
  const cents = ((v % 1_000_000n) / 10_000n).toString().padStart(2, "0");
  return `$${whole.toLocaleString("en-US")}.${cents}`;
}

export function totalMicros(service: ServiceSummary): string {
  return service.payees.reduce((sum, p) => sum + BigInt(p.revenueMicros), 0n).toString();
}

/** Share of calls per settlement model, in whole percent; empty when there are no calls. */
export function modelMix(models: ModelStats[]): { model: string; percent: number }[] {
  const total = models.reduce((s, m) => s + m.calls, 0);
  if (total === 0) return [];
  return models.map((m) => ({ model: m.model, percent: Math.round((m.calls / total) * 100) }));
}


