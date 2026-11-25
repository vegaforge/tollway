import { defineConfig } from "tsup";

export default defineConfig({
  // The main entry is pure logic over Tollway-owned shapes. The Stellar
  // readers, which import the Stellar SDK and @stellar/mpp, sit behind the
  // ./stellar subpath so callers with their own chain access never load them.
  entry: ["src/index.ts", "src/stellar.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
});
