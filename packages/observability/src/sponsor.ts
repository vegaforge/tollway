import type { SponsorBalanceReading } from "@vegaforge/tollway-core";

/** Latest sponsor readings, keyed internally by both network and account. */
export type SponsorReadingSource = {
  getSponsorReadings(): readonly SponsorBalanceReading[];
};

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

/**
 * Sponsor gauges in Prometheus text format 0.0.4, ready to append to an exporter.
 * Stale balances are omitted. Prometheus stores samples as float64, so amounts
 * above 2^53 may be rounded on ingestion and must never be used for accounting.
 */
export function renderFeeSponsorMetrics(source: SponsorReadingSource): string {
  const balances: string[] = [];
  const staleness: string[] = [];
  for (const reading of source.getSponsorReadings()) {
    const labels = `account="${escapeLabel(reading.account)}",network="${escapeLabel(reading.network)}"`;
    if (!reading.stale) {
      balances.push(`tollway_fee_sponsor_balance_stroops{${labels}} ${reading.balanceStroops}`);
    }
    staleness.push(`tollway_fee_sponsor_balance_stale{${labels}} ${reading.stale ? 1 : 0}`);
  }
  return `${[
    "# HELP tollway_fee_sponsor_balance_stroops Native XLM balance in stroops; approximate above 2^53.",
    "# TYPE tollway_fee_sponsor_balance_stroops gauge",
    ...balances,
    "# HELP tollway_fee_sponsor_balance_stale Whether the last balance read failed (1) or succeeded (0).",
    "# TYPE tollway_fee_sponsor_balance_stale gauge",
    ...staleness,
  ].join("\n")}\n`;
}
