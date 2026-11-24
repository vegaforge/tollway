import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../tsup.config.js";

/**
 * The public API report (etc/tollway-service.api.md) is generated from the
 * built declarations, so the declarations must come out the same on every
 * build.
 *
 * TypeScript prints a union in the order its member types were created
 * inside the checker, not in source order. tsup's declaration build emits
 * one source file at a time, in the order rollup happens to transform them,
 * and that order varies between runs. An inferred `z.ZodEnum<{ ... }>` can
 * therefore list its keys in a different order on two builds of the same
 * commit, which fails the API report check.
 *
 * Every Zod enum in this package is built with core's `enumSchema`, whose
 * declared type keys the enum by the tuple of its values
 * (`EnumShape<readonly ["json", "csv"]>`). A tuple prints in source order,
 * whatever the checker's creation order. This test builds the declarations
 * with the real tsup config and fails if an enum shape is printed from a
 * union again. The same test guards core in
 * packages/core/src/declaration-output.test.ts.
 */

let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "tollway-service-dts-"));
  if (Array.isArray(config) || typeof config === "function") {
    throw new Error("expected tsup.config.ts to export a single options object");
  }
  await build({ ...config, outDir, format: ["esm"], sourcemap: false, silent: true });
}, 120_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

async function readDeclarations(): Promise<string> {
  // Shared declarations can land in a hashed chunk next to the entry files,
  // so read every one rather than guess the chunk name.
  const names = (await readdir(outDir)).filter((name) => name.endsWith(".d.ts")).sort();
  const texts = await Promise.all(names.map((name) => readFile(join(outDir, name), "utf8")));
  return texts.join("\n");
}

describe("built declarations", () => {
  it("never print a Zod enum shape from a union, so key order cannot drift", async () => {
    const declarations = await readDeclarations();
    // An inferred shape prints as `z.ZodEnum<{ a: "a"; ... }>`.
    expect(declarations).not.toMatch(/ZodEnum<\{/);
    // EnumShape comes from core, so the declarations name it through the
    // namespace import tsup generates for that package.
    expect(declarations).toContain(
      'z.ZodEnum<_vegaforge_tollway_core.EnumShape<readonly ["read", "ingest", "admin"]>>',
    );
  });
});
