import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseOptions, scaffold } from "../src/cli.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "create-tollway-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("create-tollway arguments", () => {
  it("parses all supported flags", () => {
    expect(
      parseOptions([
        "--template",
        "hono",
        "--dir",
        "paid-api",
        "--package-manager",
        "pnpm",
        "--yes",
        "--force",
      ]),
    ).toEqual({
      template: "hono",
      dir: "paid-api",
      packageManager: "pnpm",
      yes: true,
      force: true,
    });
  });

  it("rejects unknown templates and package managers", () => {
    expect(() => parseOptions(["--template", "fastify"])).toThrow(
      "--template must be express, hono, or next",
    );
    expect(() => parseOptions(["--package-manager", "bun"])).toThrow(
      "--package-manager must be npm, pnpm, or yarn",
    );
  });
});

describe("create-tollway directory safety and versions", () => {
  it("refuses a non-empty directory without force", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "project");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "keep");
    await expect(
      scaffold({ template: "express", dir: target, yes: true, force: false }),
    ).rejects.toThrow("Refusing to write into non-empty directory");
  });

  it("preserves .env when forced and substitutes workspace versions", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "project");
    await mkdir(target);
    await writeFile(join(target, ".env"), "PRIVATE=value\n");
    await scaffold({
      template: "hono",
      dir: target,
      packageManager: "pnpm",
      yes: true,
      force: true,
    });
    const env = await readFile(join(target, ".env"), "utf8");
    const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const readme = await readFile(join(target, "README.md"), "utf8");
    const entries = await readdir(target);
    expect(env).toBe("PRIVATE=value\n");
    expect(manifest.dependencies["@vegaforge/tollway-server"]).toBe("^0.0.1");
    expect(Object.values(manifest.dependencies)).not.toContain("workspace:*");
    expect(Object.values(manifest.dependencies)).not.toContain("latest");
    expect(entries).toContain(".env");
    expect(readme).toContain("pnpm install");
  });

  it.each(["express", "hono", "next"] as const)("ships the %s project files", async (template) => {
    const parent = await temporaryDirectory();
    const target = join(parent, "project");
    await scaffold({ template, dir: target, yes: true, force: false });
    await expect(readFile(join(target, ".env.example"), "utf8")).resolves.toContain(
      "MOCK_MODE=true",
    );
    await expect(readFile(join(target, "README.md"), "utf8")).resolves.toContain("run test");
    await expect(readFile(join(target, "test/paid-route.test.ts"), "utf8")).resolves.toContain(
      "verifyReceipt",
    );
  });
});
