import { defineConfig } from "tsup";

export default defineConfig({
  // The loader is its own entry so `node:fs` never reaches the main bundle.
  entry: ["src/index.ts", "src/policy-loader.ts"],
  format: ["esm", "cjs"],
  // Split shared code into chunks for CommonJS too, not only for ESM (the
  // default). Without it, dist/policy-loader.cjs carries its own copy of
  // TollwayError, and `instanceof` fails across the two entry points.
  splitting: true,
  dts: true,
  sourcemap: true,
  clean: true,
});
