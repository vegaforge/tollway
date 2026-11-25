import { defineConfig } from "tsup";

export default defineConfig({
  // The SQLite metrics store is its own entry, `@vegaforge/tollway-observability/sqlite`.
  // Named entries keep the output at dist/sqlite.*, which package.json exports.
  entry: { index: "src/index.ts", sqlite: "src/sqlite-entry.ts" },
  format: ["esm", "cjs"],
  // Share code between the two entries in both formats, so an error class
  // such as InvalidMetricError is one class whichever entry threw it.
  splitting: true,
  dts: true,
  sourcemap: true,
  clean: true,
});
