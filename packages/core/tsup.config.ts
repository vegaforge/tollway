import { defineConfig } from "tsup";

export default defineConfig({
  // The loader is its own entry so `node:fs` never reaches the main bundle.
  entry: ["src/index.ts", "src/policy-loader.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
});
