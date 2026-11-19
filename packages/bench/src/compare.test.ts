import { describe, expect, it } from "vitest";
import {
  compareRuns,
  decide,
  isGateLevel,
  parseBenchResult,
  type Row,
  renderMarkdown,
} from "./compare.js";

const GATE = "bench/gate.bench.ts > gate";
const MICRO = "bench/micro.bench.ts > micro";

type Entry = { group: string; name: string; median: number; p99?: number; samples?: number };

/** Builds a document in the shape `vitest bench --outputJson` writes. */
function vitestJson(entries: Entry[]): unknown {
  const groups = new Map<string, unknown[]>();
  for (const entry of entries) {
    const list = groups.get(entry.group) ?? [];
    list.push({
      id: `${entry.group}-${entry.name}`,
      name: entry.name,
      rank: 1,
      rme: 1,
      samples: [],
      totalTime: 1000,
      min: entry.median / 2,
      max: entry.median * 3,
      hz: 1000 / entry.median,
      mean: entry.median,
      median: entry.median,
      p75: entry.median,
      p99: entry.p99 ?? entry.median * 2,
      p995: entry.median * 2,
      p999: entry.median * 2,
      sampleCount: entry.samples ?? 1000,
    });
    groups.set(entry.group, list);
  }
  return {
    files: [
      {
        filepath: "/abs/bench/x.bench.ts",
        groups: [...groups].map(([fullName, benchmarks]) => ({ fullName, benchmarks })),
      },
    ],
  };
}

function run(entries: Entry[]) {
  return parseBenchResult(vitestJson(entries));
}

function statusOf(rows: Row[], key: string) {
  const row = rows.find((candidate) => candidate.key === key);
  if (!row) throw new Error(`no row for ${key}`);
  return row.status;
}

describe("parseBenchResult", () => {
  it("keys each benchmark by group and name and keeps median, p99 and sample count", () => {
    const result = run([{ group: GATE, name: "402 challenge", median: 0.01, p99: 0.05 }]);
    expect(result.get(`${GATE} > 402 challenge`)).toEqual({
      median: 0.01,
      p99: 0.05,
      samples: 1000,
    });
  });

  it("rejects a document that is not a Vitest benchmark result", () => {
    expect(() => parseBenchResult({ results: [] })).toThrow(/not a Vitest benchmark result/);
    expect(() =>
      parseBenchResult({
        files: [{ groups: [{ fullName: GATE, benchmarks: [{ name: "x", median: "fast" }] }] }],
      }),
    ).toThrow(/not a Vitest benchmark result/);
  });

  it("rejects a benchmark with no samples", () => {
    expect(() => run([{ group: GATE, name: "empty", median: 0, samples: 0 }])).toThrow(
      /has no samples/,
    );
  });

  it("rejects a benchmark name that appears twice", () => {
    expect(() =>
      run([
        { group: GATE, name: "same", median: 1 },
        { group: GATE, name: "same", median: 1 },
      ]),
    ).toThrow(/more than once/);
  });
});

describe("compareRuns", () => {
  const base = run([
    { group: GATE, name: "noise up", median: 0.1 },
    { group: GATE, name: "noise down", median: 0.1 },
    { group: GATE, name: "edge of noise", median: 20 },
    { group: GATE, name: "slower", median: 0.1 },
    { group: GATE, name: "at threshold", median: 20 },
    { group: GATE, name: "regressed", median: 0.1 },
    { group: GATE, name: "faster", median: 0.1 },
    { group: GATE, name: "removed", median: 0.1 },
    { group: MICRO, name: "micro regressed", median: 0.001 },
  ]);
  const head = run([
    { group: GATE, name: "noise up", median: 0.104 },
    { group: GATE, name: "noise down", median: 0.096 },
    // Exactly 5% and exactly 15%: 1/20 and 3/20 are the same doubles as the constants.
    { group: GATE, name: "edge of noise", median: 21 },
    { group: GATE, name: "slower", median: 0.11 },
    { group: GATE, name: "at threshold", median: 23 },
    { group: GATE, name: "regressed", median: 0.12 },
    { group: GATE, name: "faster", median: 0.08 },
    { group: GATE, name: "new", median: 0.1 },
    { group: MICRO, name: "micro regressed", median: 0.002 },
  ]);
  const rows = compareRuns(base, head);

  it("ignores changes inside the 5% noise floor, in either direction", () => {
    expect(statusOf(rows, `${GATE} > noise up`)).toBe("unchanged");
    expect(statusOf(rows, `${GATE} > noise down`)).toBe("unchanged");
    expect(statusOf(rows, `${GATE} > edge of noise`)).toBe("unchanged");
  });

  it("reports a change between the noise floor and the threshold as slower, not regressed", () => {
    expect(statusOf(rows, `${GATE} > slower`)).toBe("slower");
    expect(statusOf(rows, `${GATE} > at threshold`)).toBe("slower");
  });

  it("flags a gate-level median more than 15% slower as regressed", () => {
    expect(statusOf(rows, `${GATE} > regressed`)).toBe("regressed");
    const row = rows.find((candidate) => candidate.key === `${GATE} > regressed`);
    expect(row?.change).toBeCloseTo(0.2);
  });

  it("never flags a micro-benchmark as regressed, only as slower", () => {
    expect(isGateLevel(`${MICRO} > micro regressed`)).toBe(false);
    expect(statusOf(rows, `${MICRO} > micro regressed`)).toBe("slower");
  });

  it("reports improvements, and benchmarks present on only one side", () => {
    expect(statusOf(rows, `${GATE} > faster`)).toBe("faster");
    expect(statusOf(rows, `${GATE} > new`)).toBe("new");
    expect(statusOf(rows, `${GATE} > removed`)).toBe("removed");
  });

  it("treats a zero base median as unmeasurably small rather than dividing by zero", () => {
    const zero = compareRuns(
      run([{ group: GATE, name: "tiny", median: 0 }]),
      run([{ group: GATE, name: "tiny", median: 0.001 }]),
    );
    expect(zero[0]?.change).toBe(Number.POSITIVE_INFINITY);
    expect(zero[0]?.status).toBe("regressed");
  });
});

describe("decide (repeat on failure, two of three)", () => {
  const regressedA = compareRuns(
    run([{ group: GATE, name: "a", median: 1 }]),
    run([{ group: GATE, name: "a", median: 1.5 }]),
  );
  const clean = compareRuns(
    run([{ group: GATE, name: "a", median: 1 }]),
    run([{ group: GATE, name: "a", median: 1 }]),
  );
  const regressedB = compareRuns(
    run([
      { group: GATE, name: "a", median: 1 },
      { group: GATE, name: "b", median: 1 },
    ]),
    run([
      { group: GATE, name: "a", median: 1 },
      { group: GATE, name: "b", median: 1.5 },
    ]),
  );

  it("passes a clean first round without repeating", () => {
    expect(decide([clean]).decision).toBe("pass");
  });

  it("asks for another round after a single regression", () => {
    expect(decide([regressedA]).decision).toBe("repeat");
  });

  it("fails once the same benchmark regresses in two rounds", () => {
    const verdict = decide([regressedA, regressedA]);
    expect(verdict.decision).toBe("fail");
    expect(verdict.confirmed).toEqual([`${GATE} > a`]);
  });

  it("asks for a third round when the second does not repeat the regression", () => {
    expect(decide([regressedA, clean]).decision).toBe("repeat");
  });

  it("fails on two of three and passes on one of three", () => {
    expect(decide([regressedA, clean, regressedA]).decision).toBe("fail");
    const verdict = decide([regressedA, clean, clean]);
    expect(verdict.decision).toBe("pass");
    expect(verdict.failures.get(`${GATE} > a`)).toBe(1);
  });

  it("counts regressions per benchmark, so two different one-off regressions do not fail", () => {
    expect(decide([regressedA, regressedB, clean]).decision).toBe("pass");
  });

  it("refuses more rounds than the rule allows", () => {
    expect(() => decide([clean, clean, clean, clean])).toThrow(/at most 3 rounds/);
    expect(() => decide([])).toThrow(/at least one round/);
  });
});

describe("renderMarkdown", () => {
  it("states the verdict and lists every benchmark of the latest round", () => {
    const rows = compareRuns(
      run([
        { group: GATE, name: "a", median: 0.1 },
        { group: MICRO, name: "m", median: 0.001 },
      ]),
      run([
        { group: GATE, name: "a", median: 0.2 },
        { group: MICRO, name: "m", median: 0.001 },
      ]),
    );
    const markdown = renderMarkdown([rows, rows], decide([rows, rows]), ["base run note"]);
    expect(markdown).toContain("**Fail.**");
    expect(markdown).toContain("> base run note");
    expect(markdown).toContain(`| ${GATE} > a | gate | 100.00 µs | 200.00 µs | +100.0% |`);
    expect(markdown).toContain(`| ${GATE} > a | 2 of 2 |`);
    expect(markdown).toContain(`| ${MICRO} > m | micro | 1.00 µs | 1.00 µs | 0.0% |`);
  });
});
