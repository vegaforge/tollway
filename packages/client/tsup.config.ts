import { defineConfig } from "tsup";

export default defineConfig({
  // Three entries: the runtime-agnostic main entry, the SQLite store that
  // imports node:sqlite, and the MCP client wrapper. Only callers of a
  // subpath pull in what it imports.
  entry: ["src/index.ts", "src/sqlite-store.ts", "src/mcp.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  // Keep "node:sqlite" as written. tsup strips the node: prefix by default,
  // which would make the built subpath import the npm package "sqlite".
  removeNodeProtocol: false,
});
