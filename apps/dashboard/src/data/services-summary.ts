import type { ModelStats, ServiceSummary } from "./services";

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
