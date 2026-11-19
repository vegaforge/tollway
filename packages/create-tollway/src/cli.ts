import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export type TemplateName = "express" | "hono" | "next";
export type PackageManager = "npm" | "pnpm" | "yarn";

type BuildVersionSource = typeof globalThis & { __TOLLWAY_VERSIONS__?: Record<string, string> };

export interface Options {
  template?: TemplateName;
  dir?: string;
  packageManager?: PackageManager;
  yes: boolean;
  force: boolean;
}

const templatesDirectory = join(dirname(fileURLToPath(import.meta.url)), "../templates");

export function parseOptions(args: string[]): Options {
  const parsed = parseArgs({
    args,
    options: {
      template: { type: "string" },
      dir: { type: "string" },
      "package-manager": { type: "string" },
      yes: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (parsed.values.help) {
    stdout.write(
      "Usage: create-tollway [--template express|hono|next] [--dir path] [--package-manager npm|pnpm|yarn] [--yes] [--force]\n",
    );
    return { yes: true, force: false };
  }
  const template = parsed.values.template;
  if (template !== undefined && !isTemplate(template))
    throw new Error("--template must be express, hono, or next");
  const packageManager = parsed.values["package-manager"];
  if (packageManager !== undefined && !isPackageManager(packageManager)) {
    throw new Error("--package-manager must be npm, pnpm, or yarn");
  }
  return {
    template: template as TemplateName | undefined,
    dir: parsed.values.dir,
    packageManager: packageManager as PackageManager | undefined,
    yes: parsed.values.yes ?? false,
    force: parsed.values.force ?? false,
  };
}

function isTemplate(value: string): value is TemplateName {
  return value === "express" || value === "hono" || value === "next";
}

function isPackageManager(value: string): value is PackageManager {
  return value === "npm" || value === "pnpm" || value === "yarn";
}

async function ask(question: string, fallback: string): Promise<string> {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await terminal.question(`${question} (${fallback}): `);
    return answer.trim() || fallback;
  } finally {
    terminal.close();
  }
}

async function fillVersions(
  template: TemplateName,
  target: string,
  packageManager: PackageManager,
): Promise<void> {
  const packageFile = join(target, "package.json");
  const manifest = JSON.parse(await readFile(packageFile, "utf8")) as {
    dependencies: Record<string, string>;
  };
  const dependencies = Object.keys(manifest.dependencies);
  for (const dependency of dependencies) {
    if (dependency.startsWith("@vegaforge/tollway-")) {
      manifest.dependencies[dependency] = `^${await workspaceVersion(dependency)}`;
    }
  }
  manifest.dependencies[frameworkPackage(template)] = frameworkVersion(template);
  await writeFile(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const readmePath = join(target, "README.md");
  const readme = await readFile(readmePath, "utf8");
  await writeFile(readmePath, readme.replaceAll("__PACKAGE_MANAGER__", packageManager));
}

async function workspaceVersion(name: string): Promise<string> {
  const buildVersion = (globalThis as BuildVersionSource).__TOLLWAY_VERSIONS__?.[name];
  if (buildVersion) return buildVersion;
  const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const packageDirectory = name.replace("@vegaforge/tollway-", "");
  const candidates = [join(workspaceRoot, "packages", packageDirectory, "package.json")];
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(await readFile(candidate, "utf8")) as { version: string };
      return manifest.version;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Could not determine the installed version for ${name}`);
}

function frameworkPackage(template: TemplateName): string {
  return template === "express" ? "express" : template === "hono" ? "hono" : "next";
}

function frameworkVersion(template: TemplateName): string {
  return template === "express" ? "^5.1.0" : template === "hono" ? "^4.6.0" : "^15.5.0";
}

export async function scaffold(options: Options): Promise<string> {
  let template = options.template;
  let dir = options.dir;
  if (!options.yes && stdin.isTTY) {
    template ??= (await ask("Template: express, hono, or next", "express")) as TemplateName;
    dir ??= await ask("Project directory", "my-tollway-api");
    options.packageManager ??= (await ask(
      "Package manager: npm, pnpm, or yarn",
      "npm",
    )) as PackageManager;
  }
  template ??= "express";
  dir ??= "my-tollway-api";
  if (!isTemplate(template)) throw new Error("Template must be express, hono, or next");
  const target = resolve(dir);
  await mkdir(target, { recursive: true });
  const entries = await readdir(target);
  if (entries.length > 0 && !options.force)
    throw new Error(`Refusing to write into non-empty directory: ${target} (pass --force)`);
  const source = join(templatesDirectory, template);
  await cp(source, target, {
    recursive: true,
    filter: (sourcePath) => basename(sourcePath) !== ".env",
  });
  await fillVersions(template, target, options.packageManager ?? "npm");
  return target;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.yes && !options.template && !options.dir) return;
  const target = await scaffold(options);
  stdout.write(`Created ${options.template ?? "express"} project in ${target}\n`);
  stdout.write("Mock payment mode is enabled. See README.md to run the test.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`create-tollway: ${message}\n`);
    process.exitCode = 1;
  });
}
