import { defineConfig } from "tsup";

export default defineConfig({
  // `index` is the library entry (the commands as functions); `cli` is the
  // `tollway` binary, whose shebang tsup keeps.
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  dts: { entry: "src/index.ts" },
  sourcemap: true,
  clean: true,
});
