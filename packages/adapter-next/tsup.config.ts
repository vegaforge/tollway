import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/proxy.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["next", "next/server", "@vegaforge/tollway-server", "@vegaforge/tollway-core"],
});
