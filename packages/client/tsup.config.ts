import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries: the runtime-agnostic main entry, and the SQLite store that
  // imports node:sqlite, so only callers of the subpath pull that in.
  entry: ["src/index.ts", "src/sqlite-store.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
});
