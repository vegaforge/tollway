import { TollwayError } from "@vegaforge/tollway-core";
import type { Drift, DriftKind, ReconciliationResult } from "./index.js";

export const RECONCILIATION_REPORT_VERSION = 1 as const;

export type DriftSeverity = "low" | "medium" | "high" | "critical";

/**
 * Conservative default severity for each drift kind. Financial loss and
 * tampering indicators are critical; unexpected settlements or invalid records
 * are high; stream anomalies are medium; foreign commitments are low.
 */
export const DEFAULT_DRIFT_SEVERITY: Record<DriftKind, DriftSeverity> = {
  "under-settled": "critical",
  "unexpected-remainder": "critical",
  "non-monotonic-cumulative": "critical",
  "over-settled": "high",
  "missing-commitment": "high",
  "malformed-record": "high",
  "sequence-gap": "medium",
  "duplicate-sequence": "medium",
  "foreign-commitment": "low",
};

/** Every drift kind, taken from the severity table so the two cannot drift apart. */
const ALL_DRIFT_KINDS = Object.keys(DEFAULT_DRIFT_SEVERITY) as DriftKind[];

export function resolveDriftSeverity(
  kind: DriftKind,
  overrides?: Partial<Record<DriftKind, DriftSeverity>>,
): DriftSeverity {
  return overrides?.[kind] ?? DEFAULT_DRIFT_SEVERITY[kind];
}

export type ReportRange = {
  from: string;
  to: string;
};

/** Optional integer-string amounts attached to a reconciliation result. */
export type ReconciliationAmounts = {
  expected?: string;
  settled?: string;
  remainder?: string;
};

export type ReconciliationReportInput = ReconciliationResult & {
  amounts?: ReconciliationAmounts;
};

export type BuildReconciliationReportOptions = {
  /** ISO 8601 timestamp when the report was generated. Defaults to now. */
  generatedAt?: string;
  /** Optional time window covered by the reconciliation run. */
  range?: ReportRange;
};

export type ReconciliationReportEntry = {
  subject: string;
  ok: boolean;
  drift: Drift[];
  amounts?: ReconciliationAmounts;
};

export type ReconciliationReportTotals = {
  total: number;
  ok: number;
  drifted: number;
  driftItems: number;
  byDriftKind: Record<DriftKind, number>;
  amounts?: {
    expected: string;
    settled: string;
    remainder: string;
  };
};

export type ReconciliationReport = {
  version: typeof RECONCILIATION_REPORT_VERSION;
  generatedAt: string;
  range?: ReportRange;
  totals: ReconciliationReportTotals;
  entries: ReconciliationReportEntry[];
};

const INTEGER_AMOUNT_RE = /^[0-9]+$/;

function parseIntegerAmount(value: string, field: string): bigint {
  if (!INTEGER_AMOUNT_RE.test(value)) {
    throw new TollwayError(
      "invalid-amount",
      `${field} "${value}" is not a valid non-negative integer string`,
    );
  }
  return BigInt(value);
}

function emptyDriftKindCounts(): Record<DriftKind, number> {
  const counts = {} as Record<DriftKind, number>;
  for (const kind of ALL_DRIFT_KINDS) {
    counts[kind] = 0;
  }
  return counts;
}

/**
 * Build a versioned JSON reconciliation report from an array of
 * `ReconciliationResult` values. Amounts, when supplied on entries, are
 * validated and summed as `bigint` and returned as integer strings.
 */
export function buildReconciliationReport(
  results: readonly ReconciliationReportInput[],
  options: BuildReconciliationReportOptions = {},
): ReconciliationReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const byDriftKind = emptyDriftKindCounts();

  let okCount = 0;
  let driftedCount = 0;
  let driftItems = 0;
  let hasAmounts = false;
  let totalExpected = 0n;
  let totalSettled = 0n;
  let totalRemainder = 0n;

  const entries: ReconciliationReportEntry[] = results.map((result) => {
    const drift = result.ok ? [] : result.drift.map((d) => ({ ...d }));

    if (result.ok) {
      okCount += 1;
    } else {
      driftedCount += 1;
      driftItems += drift.length;
      for (const item of drift) {
        byDriftKind[item.kind] += 1;
      }
    }

    const entry: ReconciliationReportEntry = {
      subject: result.channelId,
      ok: result.ok,
      drift,
    };

    if (result.amounts) {
      hasAmounts = true;
      const normalized: ReconciliationAmounts = {};
      if (result.amounts.expected !== undefined) {
        totalExpected += parseIntegerAmount(result.amounts.expected, "amounts.expected");
        normalized.expected = result.amounts.expected;
      }
      if (result.amounts.settled !== undefined) {
        totalSettled += parseIntegerAmount(result.amounts.settled, "amounts.settled");
        normalized.settled = result.amounts.settled;
      }
      if (result.amounts.remainder !== undefined) {
        totalRemainder += parseIntegerAmount(result.amounts.remainder, "amounts.remainder");
        normalized.remainder = result.amounts.remainder;
      }
      entry.amounts = normalized;
    }

    return entry;
  });

  const totals: ReconciliationReportTotals = {
    total: results.length,
    ok: okCount,
    drifted: driftedCount,
    driftItems,
    byDriftKind,
    ...(hasAmounts
      ? {
          amounts: {
            expected: totalExpected.toString(),
            settled: totalSettled.toString(),
            remainder: totalRemainder.toString(),
          },
        }
      : {}),
  };

  return {
    version: RECONCILIATION_REPORT_VERSION,
    generatedAt,
    ...(options.range ? { range: { ...options.range } } : {}),
    totals,
    entries,
  };
}

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * RFC 4180 escaping with spreadsheet formula-injection neutralization: cells
 * starting with `=`, `+`, `-`, `@`, a tab or a carriage return are prefixed
 * with a single quote before wrapping in double quotes and doubling embedded
 * double quotes.
 */
function csvEscape(value: string): string {
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export const RECONCILIATION_CSV_COLUMNS = [
  "generatedAt",
  "subject",
  "kind",
  "severity",
  "detail",
] as const;

export type ExportReportFormat = "json" | "csv";

export type CsvReportOptions = {
  severity?: Partial<Record<DriftKind, DriftSeverity>>;
};

/**
 * Serialize a reconciliation report as RFC 4180 CSV with one row per drift
 * item and spreadsheet formula-injection protection.
 */
export function reconciliationReportToCsv(
  report: ReconciliationReport,
  options: CsvReportOptions = {},
): string {
  const lines: string[] = [RECONCILIATION_CSV_COLUMNS.join(",")];

  for (const entry of report.entries) {
    for (const item of entry.drift) {
      const severity = resolveDriftSeverity(item.kind, options.severity);
      lines.push(
        [
          csvEscape(report.generatedAt),
          csvEscape(entry.subject),
          csvEscape(item.kind),
          csvEscape(severity),
          csvEscape(item.detail),
        ].join(","),
      );
    }
  }

  return lines.join("\r\n");
}

/** Serialize a reconciliation report as a JSON string. */
export function reconciliationReportToJson(report: ReconciliationReport): string {
  return JSON.stringify(report);
}

/** Serialize a reconciliation report in the requested format (`json` or `csv`). */
export function exportReconciliationReport(
  report: ReconciliationReport,
  format: ExportReportFormat,
  options: CsvReportOptions = {},
): string {
  if (format === "json") {
    return reconciliationReportToJson(report);
  }
  if (format === "csv") {
    return reconciliationReportToCsv(report, options);
  }
  throw new Error(`unsupported export format: ${format as string}`);
}
