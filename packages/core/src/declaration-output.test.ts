import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../tsup.config.js";

/**
 * The public API report (etc/tollway-core.api.md) is generated from the
 * built declarations, so the declarations must come out the same on every
 * build.
 *
 * TypeScript prints a union in the order its member types were created
 * inside the checker, not in source order. tsup's declaration build emits
 * one source file at a time, in the order rollup happens to transform them,
 * and that order varies between runs. A literal such as "anomaly" that more
 * than one file mentions is therefore created at a different moment on
 * different builds, and an inferred `z.ZodEnum<{ ... }>` printed from it
 * changes its key order. That flipped the API report check in CI on pull
 * requests that never touched this package.
 *
 * The fix builds every Zod enum in this package with `enumSchema`, whose
 * declared type keys the enum by the tuple of its values
 * (`EnumShape<readonly ["enforce", "dry-run"]>`). A tuple prints in source
 * order, whatever the checker's creation order. This test builds the
 * declarations with the real tsup config and fails if an enum shape is
 * printed from a union again.
 */

let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "tollway-core-dts-"));
  if (Array.isArray(config) || typeof config === "function") {
    throw new Error("expected tsup.config.ts to export a single options object");
  }
  await build({ ...config, outDir, format: ["esm"], sourcemap: false, silent: true });
}, 60_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

async function readDeclarations(): Promise<string> {
  // Shared declarations land in a hashed chunk next to the entry files, so
  // read every one rather than guess the chunk name.
  const names = (await readdir(outDir)).filter((name) => name.endsWith(".d.ts")).sort();
  const texts = await Promise.all(names.map((name) => readFile(join(outDir, name), "utf8")));
  return texts.join("\n");
}

describe("built declarations", () => {
  it("never print a Zod enum shape from a union, so key order cannot drift", async () => {
    const declarations = await readDeclarations();
    // An inferred shape prints as `z.ZodEnum<{ a: "a"; ... }>`.
    expect(declarations).not.toMatch(/ZodEnum<\{/);
    expect(declarations).toContain(
      'z.ZodEnum<EnumShape<readonly ["per-model-disabled", "min-channel-deposit", "budget-daily",',
    );
  });
});
