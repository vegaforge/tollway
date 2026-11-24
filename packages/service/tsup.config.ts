import { defineConfig } from "tsup";

export default defineConfig({
  // `index` is the library: createService and its types, with no Node-only
  // imports. `bin` is the Node entry that reads the environment and listens.
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm", "cjs"],
  dts: { entry: "src/index.ts" },
  sourcemap: true,
  clean: true,
});
