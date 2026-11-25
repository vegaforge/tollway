import { report, runScenario } from "./scenario.ts";

/** Runs the edge scenario on Deno, against the packages' built ESM output. */
const runtime = `deno ${Deno.version.deno}`;
const passed = report(runtime, await runScenario());
Deno.exit(passed ? 0 : 1);
