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
        ok: true,
        channelId: "ch-ok",
        amounts: { expected: "10000000", settled: "10000000", remainder: "0" },
      },
      {
        ok: false,
        channelId: "ch-drift",
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
            "duplicate-sequence": 0,
            "foreign-commitment": 0,
            "malformed-record": 0,
            "missing-commitment": 0,
            "non-monotonic-cumulative": 0,
            "over-settled": 0,
            "sequence-gap": 1,
            "under-settled": 1,
            "unexpected-remainder": 0,
          },
          "driftItems": 2,
          "drifted": 1,
          "ok": 1,
          "total": 2,
        },
        "version": 1,
      }
    `);
    expect(report.version).toBe(RECONCILIATION_REPORT_VERSION);
  });

  it("sums large integer-string amounts with bigint precision", () => {
    const report = buildReconciliationReport(
      [
        { ok: true, channelId: "ch-1", amounts: { expected: "9007199254740993" } },
        { ok: true, channelId: "ch-2", amounts: { expected: "2" } },
      ],
      { generatedAt: "2026-11-24T00:00:00.000Z" },
    );

    expect(report.totals.amounts?.expected).toBe("9007199254740995");
  });

  it("rejects non-integer amounts", () => {
    expect(() =>
      buildReconciliationReport([{ ok: true, channelId: "ch-1", amounts: { settled: "12.34" } }]),
    ).toThrow(/not a valid non-negative integer string/);
    expect(() =>
      buildReconciliationReport([{ ok: true, channelId: "ch-1", amounts: { expected: "-1" } }]),
    ).toThrow(expect.objectContaining({ code: "invalid-amount" }));
  });
});

describe("reconciliationReportToCsv", () => {
  it("round-trips RFC 4180 CSV with commas, quotes, and newlines", () => {
    const report = buildReconciliationReport(
      [
        { ok: true, channelId: "ch-ok" },
        {
          ok: false,
          channelId: 'ch,"quoted"',
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
    const report = buildReconciliationReport([{ ok: true, channelId: "ch-1" }], {
      generatedAt: "2026-11-24T00:00:00.000Z",
    });
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
          ok: false,
          channelId: payload,
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
    const report = buildReconciliationReport([{ ok: true, channelId: "ch-1" }], {
      generatedAt: "2026-11-24T00:00:00.000Z",
    });

    const json = exportReconciliationReport(report, "json");
    expect(JSON.parse(json)).toEqual(report);

    const csv = exportReconciliationReport(report, "csv");
    expect(csv).toBe(RECONCILIATION_CSV_COLUMNS.join(","));
  });
});
