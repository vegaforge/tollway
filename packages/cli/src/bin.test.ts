import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../tsup.config.js";

/**
 * Builds the package with its real tsup config and runs the built `tollway`
 * binary, so a packaging mistake (a lost shebang, a missing entry, an import
 * that only resolves from source) fails here. The binary runs in a worker
 * thread with its own argv. The output goes under this package's
 * node_modules so the built file resolves its dependencies like an install.
 */

const OUT_DIR = fileURLToPath(new URL("../node_modules/.cache/tollway-cli-bin", import.meta.url));
const CLI = `${OUT_DIR}/cli.js`;

beforeAll(async () => {
  if (Array.isArray(config) || typeof config === "function") {
    throw new Error("expected tsup.config.ts to export a single options object");
  }
  await build({ ...config, outDir: OUT_DIR, dts: false, sourcemap: false, silent: true });
}, 60_000);

afterAll(async () => {
  await rm(OUT_DIR, { recursive: true, force: true });
});

function runBin(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(CLI, { argv, stdout: true, stderr: true });
    let stdout = "";
    let stderr = "";
    worker.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    worker.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    worker.on("error", reject);
    worker.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("the built tollway binary", () => {
  it("keeps its shebang", async () => {
    expect((await readFile(CLI, "utf8")).startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("runs --help", async () => {
    const { code, stdout } = await runBin(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: tollway");
  });

  it("exits 2 on a usage error", async () => {
    const { code, stderr } = await runBin(["no-such-command"]);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown command "no-such-command"');
  });
});
