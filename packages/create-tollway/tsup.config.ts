import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const packageNames = ["adapter-express", "adapter-hono", "adapter-next", "core", "server"];
const versions = Object.fromEntries(
  packageNames.map((name) => {
    const packagePath = resolve(workspaceRoot, "packages", name, "package.json");
    const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
      name: string;
      version: string;
    };
    return [manifest.name, manifest.version];
  }),
);

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  define: { "globalThis.__TOLLWAY_VERSIONS__": JSON.stringify(versions) },
});
