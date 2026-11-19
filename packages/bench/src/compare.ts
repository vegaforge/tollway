import { z } from "zod";

/**
 * Compares two `vitest bench --outputJson` results (base and head of a pull
 * request, measured in the same CI job) and decides whether the head made
 * the gate measurably slower. The rule was agreed in issue #248:
 *
 * - A gate-level benchmark regresses when its median is more than 15% slower
 *   than the base's.
 * - A change of 5% or less either way is noise and is reported as unchanged.
 * - A regression is only confirmed if it shows up in at least two of up to
 *   three rounds. One round is a base run and a head run. A round with a
 *   regression triggers another, so a single noisy round cannot fail a pull
 *   request on its own.
 *
 * Micro-benchmarks (bench/micro.bench.ts) are reported with the same
 * statuses but never fail the check: they exist to attribute a gate-level
 * regression to a step, not to gate on their own.
 */

/** A median more than this fraction slower than the base is a regression. */
export const REGRESSION_THRESHOLD = 0.15;
/** A median within this fraction of the base, either way, is noise. */
export const NOISE_FLOOR = 0.05;
/** At most this many rounds are run. */
export const MAX_ROUNDS = 3;
/** A benchmark must regress in this many rounds to fail the check. */
export const REQUIRED_FAILURES = 2;

/** Benchmarks in these files are for attribution only and never fail the check. */
const ATTRIBUTION_ONLY_PREFIXES = ["bench/micro.bench.ts"];

/**
 * The part of Vitest's benchmark JSON this script reads. Vitest marks its
 * benchmark output as experimental, which is why the bench package pins
 * Vitest to an exact version; parsing here fails loudly if the shape moves.
 * Times are in milliseconds.
 */
const benchmarkSchema = z.object({
  name: z.string().min(1),
  median: z.number().finite().nonnegative(),
  p99: z.number().finite().nonnegative(),
  sampleCount: z.number().int().nonnegative(),
});

const benchResultSchema = z.object({
  files: z.array(
    z.object({
      groups: z.array(
        z.object({
          fullName: z.string().min(1),
          benchmarks: z.array(benchmarkSchema),
        }),
      ),
    }),
  ),
});

export type Measurement = {
  /** Median time per operation, in milliseconds. */
  median: number;
  /** 99th percentile time per operation, in milliseconds. */
  p99: number;
  samples: number;
};

/** Measurements keyed by `<file> > <describe block> > <benchmark name>`. */
export type BenchResult = Map<string, Measurement>;

/**
 * Parses one Vitest benchmark JSON document. Throws on a document that does
 * not match the expected shape, on a benchmark with no samples, and on a
 * duplicated benchmark name, since any of those would make the comparison
 * quietly compare the wrong things.
 */
export function parseBenchResult(json: unknown): BenchResult {
  const parsed = benchResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`not a Vitest benchmark result: ${z.prettifyError(parsed.error)}`);
  }
  const result: BenchResult = new Map();
  for (const file of parsed.data.files) {
    for (const group of file.groups) {
      for (const benchmark of group.benchmarks) {
        const key = `${group.fullName} > ${benchmark.name}`;
        if (result.has(key)) {
          throw new Error(`benchmark "${key}" appears more than once`);
        }
        if (benchmark.sampleCount === 0) {
          throw new Error(`benchmark "${key}" has no samples`);
        }
        result.set(key, {
          median: benchmark.median,
          p99: benchmark.p99,
          samples: benchmark.sampleCount,
        });
      }
    }
  }
  return result;
}

export type Status =
  /** Gate-level and more than REGRESSION_THRESHOLD slower. */
  | "regressed"
  /** Slower beyond the noise floor, but not a gate-level regression. */
  | "slower"
  | "unchanged"
  | "faster"
  /** Only in the head run. */
  | "new"
  /** Only in the base run. */
  | "removed";

export type Row = {
  key: string;
  gateLevel: boolean;
  base?: Measurement;
  head?: Measurement;
  /** (head median - base median) / base median; undefined when either side is missing. */
  change?: number;
  status: Status;
};

export function isGateLevel(key: string): boolean {
  return !ATTRIBUTION_ONLY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Compares one base run with one head run, benchmark by benchmark. */
export function compareRuns(base: BenchResult, head: BenchResult): Row[] {
  const keys = [...new Set([...base.keys(), ...head.keys()])].sort();
  return keys.map((key) => {
    const gateLevel = isGateLevel(key);
    const baseMeasurement = base.get(key);
    const headMeasurement = head.get(key);
    if (!baseMeasurement) {
      return { key, gateLevel, head: headMeasurement, status: "new" };
    }
    if (!headMeasurement) {
      return { key, gateLevel, base: baseMeasurement, status: "removed" };
    }
    const change = relativeChange(baseMeasurement.median, headMeasurement.median);
    return {
      key,
      gateLevel,
      base: baseMeasurement,
      head: headMeasurement,
      change,
      status: classify(change, gateLevel),
    };
  });
}

/**
 * A base median of zero means the operation is faster than the timer's
 * resolution. Any positive head median is then reported as infinitely
 * slower, which is honest: the comparison cannot say how much.
 */
function relativeChange(base: number, head: number): number {
  if (base === 0) {
    return head === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return (head - base) / base;
}

function classify(change: number, gateLevel: boolean): Status {
  if (change > REGRESSION_THRESHOLD && gateLevel) return "regressed";
  if (change > NOISE_FLOOR) return "slower";
  if (change < -NOISE_FLOOR) return "faster";
  return "unchanged";
}

export type Decision = "pass" | "fail" | "repeat";

export type Verdict = {
  decision: Decision;
  /** Benchmarks that regressed in at least REQUIRED_FAILURES rounds. */
  confirmed: string[];
  /** For every benchmark that regressed in any round, how many rounds it regressed in. */
  failures: Map<string, number>;
  rounds: number;
};

/**
 * Applies the repeat-on-failure rule to the rounds run so far, in order.
 * Another round is only asked for when some benchmark has regressed and
 * could still reach REQUIRED_FAILURES in the rounds that are left; a clean
 * round never triggers one.
 */
export function decide(rounds: Row[][]): Verdict {
  if (rounds.length === 0) {
    throw new Error("decide needs at least one round");
  }
  if (rounds.length > MAX_ROUNDS) {
    throw new Error(`at most ${MAX_ROUNDS} rounds are allowed, got ${rounds.length}`);
  }
  const failures = new Map<string, number>();
  for (const round of rounds) {
    for (const row of round) {
      if (row.status === "regressed") {
        failures.set(row.key, (failures.get(row.key) ?? 0) + 1);
      }
    }
  }
  const confirmed = [...failures]
    .filter(([, count]) => count >= REQUIRED_FAILURES)
    .map(([key]) => key)
    .sort();
  const remaining = MAX_ROUNDS - rounds.length;
  const couldStillConfirm = [...failures.values()].some(
    (count) => count + remaining >= REQUIRED_FAILURES,
  );

  let decision: Decision;
  if (confirmed.length > 0) decision = "fail";
  else if (couldStillConfirm) decision = "repeat";
  else decision = "pass";

  return { decision, confirmed, failures, rounds: rounds.length };
}

/** Renders the verdict and the latest round as Markdown for the CI job summary. */
export function renderMarkdown(rounds: Row[][], verdict: Verdict, notes: string[] = []): string {
  const latest = rounds.at(-1);
  if (!latest) {
    throw new Error("renderMarkdown needs at least one round");
  }
  const lines: string[] = [];
  lines.push("## Gate benchmarks: base vs head", "");
  lines.push(headline(verdict), "");
  lines.push(
    `Rule: a gate-level median more than ${percent(REGRESSION_THRESHOLD)} slower than base is a regression; ` +
      `changes within ${percent(NOISE_FLOOR)} are noise. A regression must repeat in ${REQUIRED_FAILURES} ` +
      `of up to ${MAX_ROUNDS} rounds to fail the check. Micro-benchmarks are for attribution and never fail it.`,
    "",
  );
  for (const note of notes) {
    lines.push(`> ${note}`, "");
  }
  if (verdict.failures.size > 0) {
    lines.push("| Benchmark | Rounds regressed |", "| --- | --- |");
    for (const [key, count] of [...verdict.failures].sort()) {
      lines.push(`| ${escapeCell(key)} | ${count} of ${verdict.rounds} |`);
    }
    lines.push("");
  }
  lines.push(
    `Round ${rounds.length} of ${MAX_ROUNDS} max. Times are per operation; medians are compared, p99 is shown for context.`,
    "",
  );
  lines.push(
    "| Benchmark | Scope | Base median | Head median | Change | Base p99 | Head p99 | Status |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  );
  for (const row of latest) {
    lines.push(
      [
        "",
        escapeCell(row.key),
        row.gateLevel ? "gate" : "micro",
        time(row.base?.median),
        time(row.head?.median),
        row.change === undefined ? "" : signedPercent(row.change),
        time(row.base?.p99),
        time(row.head?.p99),
        STATUS_LABEL[row.status],
        "",
      ]
        .join(" | ")
        .trim(),
    );
  }
  return `${lines.join("\n")}\n`;
}

const STATUS_LABEL: Record<Status, string> = {
  regressed: "REGRESSED",
  slower: "slower",
  unchanged: "unchanged",
  faster: "faster",
  new: "new (no base)",
  removed: "removed",
};

function headline(verdict: Verdict): string {
  switch (verdict.decision) {
    case "pass":
      return verdict.failures.size > 0
        ? `**Pass.** A regression appeared in one round but did not repeat in ${REQUIRED_FAILURES} of ${verdict.rounds}.`
        : "**Pass.** No gate-level benchmark regressed.";
    case "fail":
      return `**Fail.** Confirmed regression in: ${verdict.confirmed.map((key) => `\`${key}\``).join(", ")}.`;
    case "repeat":
      return "**Repeating.** A gate-level benchmark regressed in this round; running another round to confirm.";
  }
}

/** Formats milliseconds as microseconds, the natural unit for these benchmarks. */
function time(ms: number | undefined): string {
  return ms === undefined ? "" : `${(ms * 1000).toFixed(2)} µs`;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

function signedPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "+inf";
  const value = (fraction * 100).toFixed(1);
  return fraction > 0 ? `+${value}%` : `${value}%`;
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}
