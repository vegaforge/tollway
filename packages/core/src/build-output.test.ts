import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../tsup.config.js";

/**
 * The package ships two entry points, `.` and `./policy-loader`. Both must
 * share one copy of the error classes in each module format, or a consumer's
 * `error instanceof TollwayError` is false for errors from the other entry.
 * This builds the package with its real tsup config into a temporary
 * directory and loads the output, so a config change that duplicates the
 * classes fails here.
 */

type CoreModule = typeof import("./index.js");
type LoaderModule = typeof import("./policy-loader.js");

let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "tollway-core-build-"));
  if (Array.isArray(config) || typeof config === "function") {
    throw new Error("expected tsup.config.ts to export a single options object");
  }
  await build({ ...config, outDir, dts: false, sourcemap: false, silent: true });
});

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

async function loaderError(loader: LoaderModule): Promise<unknown> {
  try {
    await loader.loadPolicyFile(join(outDir, "missing-policy.json"));
  } catch (error) {
    return error;
  }
  throw new Error("expected loadPolicyFile to reject for a missing file");
}

describe("built entry points", () => {
  it("share TollwayError across the CommonJS entries", async () => {
    const require = createRequire(import.meta.url);
    const core = require(join(outDir, "index.cjs")) as CoreModule;
    const loader = require(join(outDir, "policy-loader.cjs")) as LoaderModule;
    const error = await loaderError(loader);
    expect(error).toBeInstanceOf(loader.PolicyLoadError);
    expect(error).toBeInstanceOf(core.TollwayError);
  });

  it("share TollwayError across the ESM entries", async () => {
    const core = (await import(join(outDir, "index.js"))) as CoreModule;
    const loader = (await import(join(outDir, "policy-loader.js"))) as LoaderModule;
    const error = await loaderError(loader);
    expect(error).toBeInstanceOf(core.TollwayError);
  });
});
