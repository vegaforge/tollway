import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["express"],
  // Keep the adapter's build output consistent with the shared service
  // packages, which are built with the same tsup defaults.
  target: "node18",
});
