import { defineConfig } from "tsup";

export default defineConfig({
  // The conformance suite is a separate entry so adapters can import it from
  // `@vegaforge/tollway-server/testing` without pulling test helpers into the
  // gate's main bundle. Shared chunks keep one copy of the gate's types.
  entry: {
    index: "src/index.ts",
    testing: "src/testing/adapter-conformance.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  splitting: true,
  clean: true,
});
