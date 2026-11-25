import { describe, expect, it } from "vitest";
import {
  buildReconciliationReport,
  exportReconciliationReport,
  RECONCILIATION_CSV_COLUMNS,
  RECONCILIATION_REPORT_VERSION,
  type ReconciliationReportInput,
  reconciliationReportToCsv,
} from "./index.js";

/** Minimal RFC 4180 CSV parser for round-trip verification in tests. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

describe("buildReconciliationReport", () => {
  it("produces a versioned JSON snapshot for mixed ok and drifted results", () => {
    const results: ReconciliationReportInput[] = [
      {
        status: "ok",
        ok: true,
        subject: { kind: "channel", channelId: "ch-ok" },
        amounts: { expected: "10000000", settled: "10000000", remainder: "0" },
      },
      {
        status: "drift" as const,
        ok: false,
        subject: { kind: "channel" as const, channelId: "ch-drift" },
        drift: [
          {
            kind: "under-settled",
            detail: "channel settled 5000000 but last commitment was 8000000; shortfall: 3000000",
          },
          {
            kind: "sequence-gap",
            detail: "sequence gap at position 1: expected sequence 1, got 2",
          },
        ],
        amounts: { expected: "8000000", settled: "5000000", remainder: "3000000" },
      },
    ];

    const report = buildReconciliationReport(results, {
      generatedAt: "2026-11-24T00:00:00.000Z",
      range: { from: "2026-11-23T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" },
    });

    expect(report).toMatchInlineSnapshot(`
      {
        "entries": [
          {
            "amounts": {
              "expected": "10000000",
              "remainder": "0",
              "settled": "10000000",
            },
            "drift": [],
            "ok": true,
            "status": "ok",
            "subject": "ch-ok",
          },
          {
            "amounts": {
              "expected": "8000000",
              "remainder": "3000000",
              "settled": "5000000",
            },
            "drift": [
              {
                "detail": "channel settled 5000000 but last commitment was 8000000; shortfall: 3000000",
                "kind": "under-settled",
              },
              {
                "detail": "sequence gap at position 1: expected sequence 1, got 2",
                "kind": "sequence-gap",
              },
            ],
            "ok": false,
            "status": "drift",
            "subject": "ch-drift",
          },
        ],
        "generatedAt": "2026-11-24T00:00:00.000Z",
        "range": {
          "from": "2026-11-23T00:00:00.000Z",
          "to": "2026-11-24T00:00:00.000Z",
        },
        "totals": {
          "amounts": {
            "expected": "18000000",
            "remainder": "3000000",
            "settled": "15000000",
          },
          "byDriftKind": {
            "amount-mismatch": 0,
            "asset-mismatch": 0,
            "balance-mismatch": 0,
            "closed-on-chain": 0,
            "duplicate-sequence": 0,
            "foreign-commitment": 0,
            "funder-mismatch": 0,
            "malformed-record": 0,
            "missing-commitment": 0,
            "network-mismatch": 0,
            "non-monotonic-cumulative": 0,
            "over-settled": 0,
            "payee-mismatch": 0,
            "payer-mismatch": 0,
            "recipient-mismatch": 0,
            "sequence-gap": 1,
            "token-mismatch": 0,
            "transfer-missing": 0,
            "tx-failed": 0,
            "tx-not-found": 0,
            "under-settled": 1,
            "unexpected-remainder": 0,
          },
          "driftItems": 2,
          "drifted": 1,
          "ok": 1,
          "retryable": 0,
          "total": 2,
          "unverifiable": 0,
        },
        "version": 1,
      }
    `);
    expect(report.version).toBe(RECONCILIATION_REPORT_VERSION);
  });

  it("sums large integer-string amounts with bigint precision", () => {
    const report = buildReconciliationReport(
      [
        {
          status: "ok",
          ok: true,
          subject: { kind: "channel", channelId: "ch-1" },
          amounts: { expected: "9007199254740993" },
        },
        {
          status: "ok",
          ok: true,
          subject: { kind: "channel", channelId: "ch-2" },
          amounts: { expected: "2" },
        },
      ],
      { generatedAt: "2026-11-24T00:00:00.000Z" },
    );

    expect(report.totals.amounts?.expected).toBe("9007199254740995");
  });

  it("rejects non-integer amounts", () => {
    expect(() =>
      buildReconciliationReport([
        {
          status: "ok",
          ok: true,
          subject: { kind: "channel", channelId: "ch-1" },
          amounts: { settled: "12.34" },
        },
      ]),
    ).toThrow(/not a valid non-negative integer string/);
    expect(() =>
      buildReconciliationReport([
        {
          status: "ok",
          ok: true,
          subject: { kind: "channel", channelId: "ch-1" },
          amounts: { expected: "-1" },
        },
      ]),
    ).toThrow(expect.objectContaining({ code: "invalid-amount" }));
  });
});

describe("reconciliationReportToCsv", () => {
  it("round-trips RFC 4180 CSV with commas, quotes, and newlines", () => {
    const report = buildReconciliationReport(
      [
        { status: "ok", ok: true, subject: { kind: "channel", channelId: "ch-ok" } },
        {
          status: "drift" as const,
          ok: false,
          subject: { kind: "channel" as const, channelId: 'ch,"quoted"' },
          drift: [
            {
              kind: "over-settled",
              detail: 'excess "100", line1\nline2',
            },
          ],
        },
      ],
      { generatedAt: "2026-11-24T00:00:00.000Z" },
    );

    const csv = reconciliationReportToCsv(report);
    const parsed = parseCsv(csv);

    expect(parsed).toEqual([
      [...RECONCILIATION_CSV_COLUMNS],
      [
        "2026-11-24T00:00:00.000Z",
        'ch,"quoted"',
        "over-settled",
        "high",
        'excess "100", line1\nline2',
      ],
    ]);
  });

  it("outputs only the header row when there are no drift items", () => {
    const report = buildReconciliationReport(
      [{ status: "ok", ok: true, subject: { kind: "channel", channelId: "ch-1" } }],
      {
        generatedAt: "2026-11-24T00:00:00.000Z",
      },
    );
    expect(reconciliationReportToCsv(report)).toBe(RECONCILIATION_CSV_COLUMNS.join(","));
  });

  it.each([
    ["=", "=cmd|' /C calc'!A0"],
    ["+", "+1+1"],
    ["-", "-1+1"],
    ["@", "@SUM(1+1)*cmd"],
    ["tab", "\t=1+1"],
    ["carriage return", "\r=1+1"],
  ])("neutralizes spreadsheet formula injection starting with %s", (_label, payload) => {
    const report = buildReconciliationReport(
      [
        {
          status: "drift" as const,
          ok: false,
          subject: { kind: "channel" as const, channelId: payload },
          drift: [{ kind: "malformed-record", detail: payload }],
        },
      ],
      { generatedAt: "2026-11-24T00:00:00.000Z" },
    );

    const parsed = parseCsv(reconciliationReportToCsv(report));
    expect(parsed[1]?.[1]).toBe(`'${payload}`);
    expect(parsed[1]?.[4]).toBe(`'${payload}`);
  });

  it("supports exportReconciliationReport for json and csv", () => {
    const report = buildReconciliationReport(
      [{ status: "ok", ok: true, subject: { kind: "channel", channelId: "ch-1" } }],
      {
        generatedAt: "2026-11-24T00:00:00.000Z",
      },
    );

    const json = exportReconciliationReport(report, "json");
    expect(JSON.parse(json)).toEqual(report);

    const csv = exportReconciliationReport(report, "csv");
    expect(csv).toBe(RECONCILIATION_CSV_COLUMNS.join(","));
  });
});

describe("buildReconciliationReport with checks that could not run", () => {
  it("counts unverifiable and retryable results apart from drift and keeps their reason", () => {
    const report = buildReconciliationReport(
      [
        {
          status: "unverifiable",
          ok: false,
          subject: { kind: "transaction", txHash: "tx-old", network: "testnet" },
          reason: "older than the RPC retention window",
        },
        {
          status: "retryable",
          ok: false,
          subject: { kind: "channel", channelId: "ch-1" },
          reason: "RPC timed out",
        },
      ],
      { generatedAt: "2026-11-24T00:00:00.000Z" },
    );
    expect(report.totals).toMatchObject({
      total: 2,
      ok: 0,
      drifted: 0,
      unverifiable: 1,
      retryable: 1,
      driftItems: 0,
    });
    expect(report.entries).toEqual([
      {
        subject: "tx-old",
        status: "unverifiable",
        ok: false,
        drift: [],
        reason: "older than the RPC retention window",
      },
      { subject: "ch-1", status: "retryable", ok: false, drift: [], reason: "RPC timed out" },
    ]);
    // No drift rows for results that were not checked.
    expect(reconciliationReportToCsv(report)).toBe(RECONCILIATION_CSV_COLUMNS.join(","));
  });
});
