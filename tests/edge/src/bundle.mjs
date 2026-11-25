// Bundles the edge scenario as a Cloudflare Worker, and reports the size of
// a minimal Worker that uses @vegaforge/tollway-server. With --size-check it
// fails when that size grows past the recorded budget.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const OUT = here("../dist");

/** Options shared by both bundles: what wrangler would do for a Worker. */
const WORKER = {
  bundle: true,
  format: "esm",
  platform: "browser",
  conditions: ["workerd", "worker", "browser"],
  target: "es2022",
  // Node built-ins come from the runtime: a Worker needs the nodejs_compat
  // compatibility flag, because @x402/extensions (bazaar discovery) and the
  // Stellar SDK import them. See docs: "Supported runtimes".
  external: ["node:*", ...builtinModules],
  minify: false,
  logLevel: "warning",
};

await mkdir(OUT, { recursive: true });
await build({ ...WORKER, entryPoints: [here("./worker.ts")], outfile: `${OUT}/worker.js` });
await build({
  ...WORKER,
  minify: true,
  entryPoints: [here("./minimal-worker.ts")],
  outfile: `${OUT}/minimal-worker.js`,
});

const minimal = await readFile(`${OUT}/minimal-worker.js`);
const size = { bytes: minimal.byteLength, gzipBytes: gzipSync(minimal).byteLength };
await writeFile(`${OUT}/size.json`, `${JSON.stringify(size, null, 2)}\n`);
console.log(
  `minimal Worker with @vegaforge/tollway-server: ${(size.bytes / 1024).toFixed(0)} KiB, ${(size.gzipBytes / 1024).toFixed(0)} KiB gzipped`,
);

if (process.argv.includes("--size-check")) {
  const budget = JSON.parse(await readFile(here("../bundle-budget.json"), "utf8"));
  if (size.gzipBytes > budget.maxGzipBytes) {
    console.error(
      `the minimal Worker is ${size.gzipBytes} bytes gzipped, over the ${budget.maxGzipBytes} byte budget in tests/edge/bundle-budget.json`,
    );
    process.exit(1);
  }
  console.log(`within the ${budget.maxGzipBytes} byte gzipped budget`);
}
