// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Application, LogLevel, TSConfigReader, TypeDocReader } from "typedoc";
import { afterAll, describe, expect, it } from "vitest";

import { checkApiReference } from "../../typedoc/check-api.mjs";

const configPath = fileURLToPath(new URL("../../typedoc.json", import.meta.url));
// realpath: on macOS the temp directory is a symlink, and TypeDoc compares
// the entry point with the tsconfig file list by resolved path.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "tollway-api-")));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Runs TypeDoc the way `pnpm run api` does, including validation, which the
 * CLI runs but `convert()` does not.
 */
async function generate(options: Record<string, unknown>) {
  const app = await Application.bootstrapWithPlugins({ logLevel: LogLevel.Error, ...options });
  const project = await app.convert();
  if (!project) {
    return { app, project };
  }
  app.validate(project);
  if (!app.logger.hasErrors()) {
    await app.generateOutputs(project);
  }
  return { app, project };
}

// TypeDoc type-checks every package's source in one program, which takes
// several seconds; the default five-second test timeout is for unit tests.
const GENERATION_TIMEOUT_MS = 120_000;

describe("API reference", () => {
  it(
    "produces a page for every package entry point, listed in the sidebar, with cross-package links",
    async () => {
      const out = join(scratch, "api");
      const { app, project } = await generate({ options: configPath, out });
      expect(project).toBeDefined();
      expect(app.logger.hasErrors()).toBe(false);
      expect(app.logger.hasWarnings()).toBe(false);
      expect(checkApiReference(out)).toEqual([]);

      // SignedReceipt is declared in core and used by the server's GateOutcome.
      const server = readFileSync(join(out, "server.mdx"), "utf8");
      expect(server).toContain("[`SignedReceipt`](/docs/api/core#signedreceipt)");
      const core = readFileSync(join(out, "core.mdx"), "utf8");
      expect(core).toMatch(/^### SignedReceipt$/m);
    },
    GENERATION_TIMEOUT_MS,
  );

  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    validation: Record<string, boolean>;
    treatWarningsAsErrors: boolean;
  };

  /**
   * Runs TypeDoc on one fixture with the repository's validation settings and
   * reports whether `pnpm run api` would fail. It reads options the way the
   * CLI does (typedoc.json, then tsconfig.json) and applies the CLI's exit
   * rule: any error fails, and with treatWarningsAsErrors so does any warning.
   * It runs in-process because the security gate forbids spawning processes.
   */
  async function typedocFails(name: string, files: Record<string, string>): Promise<boolean> {
    const folder = join(scratch, name);
    mkdirSync(folder, { recursive: true });
    for (const [file, code] of Object.entries(files)) {
      writeFileSync(join(folder, file), code);
    }
    // TypeDoc only reports a missing export for code it can place in a
    // package, as every real entry point is.
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
    // An empty options file, so the repository's typedoc.json and its
    // plugins are not picked up: only the options below apply.
    writeFileSync(join(folder, "typedoc.json"), "{}");
    writeFileSync(
      join(folder, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, files: Object.keys(files) }),
    );
    const app = await Application.bootstrapWithPlugins(
      {
        options: join(folder, "typedoc.json"),
        tsconfig: join(folder, "tsconfig.json"),
        entryPoints: [join(folder, "index.ts").replaceAll("\\", "/")],
        plugin: [],
        logLevel: LogLevel.None,
        validation: {
          notExported: config.validation.notExported,
          invalidLink: config.validation.invalidLink,
        },
        treatWarningsAsErrors: config.treatWarningsAsErrors,
      },
      [new TypeDocReader(), new TSConfigReader()],
    );
    const failed = () =>
      app.logger.hasErrors() || (config.treatWarningsAsErrors && app.logger.hasWarnings());
    if (failed()) {
      return true;
    }
    const project = await app.convert();
    if (!project) {
      return true;
    }
    app.validate(project);
    return failed();
  }

  it(
    "accepts a documented, fully exported module",
    async () => {
      expect(
        await typedocFails("clean", { "index.ts": "/** A value. */\nexport const value = 1;\n" }),
      ).toBe(false);
    },
    GENERATION_TIMEOUT_MS,
  );

  it.each([
    ["broken-link", { "index.ts": "/** See {@link DoesNotExist}. */\nexport const value = 1;\n" }],
    [
      "not-exported",
      {
        "hidden.ts": "export interface Hidden { a: string }\n",
        "index.ts":
          'import type { Hidden } from "./hidden";\n/** Uses a hidden type. */\nexport function f(): Hidden { return { a: "" }; }\n',
      },
    ],
  ])(
    "fails the build on %s",
    async (name, files) => {
      expect(await typedocFails(name, files)).toBe(true);
    },
    GENERATION_TIMEOUT_MS,
  );
});
