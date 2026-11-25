import { report, runScenario } from "./scenario.ts";

/** Runs the edge scenario on Bun, against the packages' built ESM output. */
const runtime = `bun ${Bun.version}`;
const passed = report(runtime, await runScenario());
process.exit(passed ? 0 : 1);
