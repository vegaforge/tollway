// Runs the bundled edge scenario inside workerd, through Miniflare, and
// reports each step. Run `node src/bundle.mjs` first.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const { version } = JSON.parse(
  await readFile(here("../node_modules/miniflare/package.json"), "utf8"),
);

const miniflare = new Miniflare({
  modules: true,
  scriptPath: here("../dist/worker.js"),
  // Pinned so a new workerd default cannot change behaviour under the test.
  compatibilityDate: "2026-07-01",
  compatibilityFlags: ["nodejs_compat"],
});

let passed = false;
try {
  const response = await miniflare.dispatchFetch("http://edge.test/");
  const results = await response.json();
  const runtime = `workerd (miniflare ${version})`;
  for (const result of results) {
    console.log(
      `${result.ok ? "ok  " : "FAIL"} [${runtime}] ${result.step}${result.detail ? ` (${result.detail})` : ""}`,
    );
  }
  passed = results.length > 0 && results.every((result) => result.ok);
} finally {
  await miniflare.dispose();
}
process.exit(passed ? 0 : 1);
