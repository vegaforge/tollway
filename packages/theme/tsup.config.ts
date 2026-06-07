import { writeFile } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/preset.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // The stylesheet is generated from the token objects so the CSS can never
  // drift from what the TypeScript exports say.
  onSuccess: async () => {
    const { renderTokensCss } = await import("./src/css.js");
    await writeFile("dist/tokens.css", renderTokensCss());
  },
});
