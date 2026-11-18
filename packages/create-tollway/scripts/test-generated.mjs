import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(packageDirectory, "../..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "tollway-generated-"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd} with ${result.status}`);
}

try {
  const packed = new Map();
  for (const directory of ["core", "server", "adapter-express", "adapter-hono", "adapter-next"]) {
    const packagePath = join(workspaceRoot, "packages", directory);
    const manifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8"));
    run("pnpm", ["pack", "--pack-destination", temporaryRoot], packagePath);
    packed.set(
      manifest.name,
      join(
        temporaryRoot,
        `${manifest.name.replace("@vegaforge/", "").replaceAll("/", "-")}-${manifest.version}.tgz`,
      ),
    );
  }

  for (const template of ["express", "hono", "next"]) {
    const project = join(temporaryRoot, template);
    run(
      "node",
      [join(packageDirectory, "dist/cli.js"), "--template", template, "--dir", project, "--yes"],
      temporaryRoot,
    );
    const manifestPath = join(project, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const name of Object.keys(manifest.dependencies)) {
      if (packed.has(name)) manifest.dependencies[name] = `file:${packed.get(name)}`;
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    run("pnpm", ["install", "--no-frozen-lockfile"], project);
    run("pnpm", ["exec", "tsc", "--noEmit"], project);
    run("pnpm", ["test"], project);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
