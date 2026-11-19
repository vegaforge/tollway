import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { compareRuns, decide, parseBenchResult, renderMarkdown } from "./compare.js";

/**
 * Command-line entry for the comparison. Each round is one `--base` and one
 * `--head` file, paired in the order given:
 *
 *   tsx src/cli.ts --base base-1.json --head head-1.json [--base ... --head ...]
 *                  [--markdown summary.md] [--note "text"]
 *
 * Exit codes, read by scripts/compare-trees.sh:
 *   0  pass
 *   1  a gate-level regression is confirmed
 *   2  the input is unusable (missing file, wrong shape, unpaired rounds)
 *   3  a regression appeared and another round is needed to confirm it
 */

const EXIT = { pass: 0, fail: 1, usage: 2, repeat: 3 } as const;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      base: { type: "string", multiple: true, default: [] },
      head: { type: "string", multiple: true, default: [] },
      markdown: { type: "string" },
      note: { type: "string", multiple: true, default: [] },
    },
    strict: true,
  });
  if (values.base.length === 0 || values.base.length !== values.head.length) {
    console.error(
      `need one --head for every --base and at least one of each (got ${values.base.length} base, ${values.head.length} head)`,
    );
    return EXIT.usage;
  }

  const rounds = [];
  for (const [index, basePath] of values.base.entries()) {
    const headPath = values.head[index];
    if (headPath === undefined) {
      throw new Error(`round ${index + 1} has no head file`);
    }
    rounds.push(compareRuns(await load(basePath), await load(headPath)));
  }

  const verdict = decide(rounds);
  const markdown = renderMarkdown(rounds, verdict, values.note);
  process.stdout.write(markdown);
  if (values.markdown) {
    await writeFile(values.markdown, markdown);
  }
  return EXIT[verdict.decision];
}

async function load(path: string) {
  const text = await readFile(path, "utf8");
  try {
    return parseBenchResult(JSON.parse(text));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = EXIT.usage;
  },
);
