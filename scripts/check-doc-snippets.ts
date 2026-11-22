#!/usr/bin/env tsx
/**
 * Documentation snippet type-checker and runner.
 *
 * Extracts every fenced TypeScript block from README.md, docs/**\/\*.md, and
 * apps/web/src/content/docs/**\/*.mdx, then:
 *
 *  - Type-checks every snippet against the workspace packages under the
 *    repo's strict tsconfig settings.
 *  - Runs snippets whose fence is annotated `ts run` (or `tsx run`).
 *  - Checks "illustrative" snippets (annotated `ts illustrative`) for mutual
 *    assignability with the real exported type they restate.
 *  - Skips snippets annotated `ts skip=<reason>` (unannotated skips are an
 *    error).
 *
 * Fence annotation reference (placed after the language tag):
 *
 *   ```ts                 — type-check only (default)
 *   ```ts run             — type-check and execute
 *   ```ts illustrative    — check assignability with the real type (see below)
 *   ```ts skip=<reason>   — skip; <reason> is required
 *
 * For an illustrative snippet, the preamble file (a `.preamble.ts` next to the
 * doc) may declare the real type with `// @illustrative <name> <import>` so
 * the checker generates an assignability assertion.
 *
 * Usage:
 *   tsx scripts/check-doc-snippets.ts
 *   tsx scripts/check-doc-snippets.ts --verbose
 *
 * Exit code:
 *   0  all snippets pass
 *   1  one or more snippets have errors
 *
 * See also: CONTRIBUTING.md "Documentation snippets".
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Code, Root } from "mdast";
import { remark } from "remark";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";

// ── types ─────────────────────────────────────────────────────────────────────

type AnnotationKind = "typecheck" | "run" | "illustrative" | "skip";

type Snippet = {
  file: string;
  /** 1-based line number of the opening fence. */
  line: number;
  lang: "ts" | "tsx";
  kind: AnnotationKind;
  /** The skip reason (only when kind === "skip"). */
  skipReason: string | undefined;
  /** The optional preamble to prepend before type-checking. */
  preamble: string;
  code: string;
};

type SnippetResult =
  | { kind: "pass"; snippet: Snippet }
  | { kind: "skip"; snippet: Snippet }
  | { kind: "fail"; snippet: Snippet; errors: string[] };

// ── config ────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname, "..");
const VERBOSE = process.argv.includes("--verbose");
const TIMEOUT_MS = 10_000;

/** tsconfig used for snippet type-checking. Must have strict settings. */
const TSCONFIG_BASE = path.join(ROOT, "tsconfig.base.json");

// ── file scanning ─────────────────────────────────────────────────────────────

/** Returns absolute paths to all doc files matching the patterns. */
function findDocFiles(): string[] {
  const files: string[] = [];

  // README.md at root
  const readme = path.join(ROOT, "README.md");
  if (fs.existsSync(readme)) files.push(readme);

  // docs/**/*.md
  function walk(dir: string, pattern: RegExp, into: string[]) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, pattern, into);
      } else if (pattern.test(entry.name)) {
        into.push(full);
      }
    }
  }

  walk(path.join(ROOT, "docs"), /\.md$/, files);
  walk(path.join(ROOT, "apps", "web", "src", "content", "docs"), /\.mdx?$/, files);

  return files;
}

// ── annotation parsing ────────────────────────────────────────────────────────

/**
 * Parses the annotation from a fence tag such as `ts run` or `tsx skip=reason`.
 * Returns the language and annotation kind.
 */
function parseAnnotation(meta: string | null | undefined): {
  kind: AnnotationKind;
  skipReason: string | undefined;
} {
  const m = meta?.trim() ?? "";
  if (!m || m === "") return { kind: "typecheck", skipReason: undefined };
  if (m === "run") return { kind: "run", skipReason: undefined };
  if (m === "illustrative") return { kind: "illustrative", skipReason: undefined };
  if (m.startsWith("skip=")) {
    const reason = m.slice("skip=".length).trim();
    if (!reason) {
      // reason is mandatory; treat as an error — we return a special marker
      return { kind: "skip", skipReason: "" };
    }
    return { kind: "skip", skipReason: reason };
  }
  // Unknown annotation is treated as a type-check (the default). The checker
  // will not error on unknown meta so docs can use other annotations such as
  // 'bash' or 'json'.
  return { kind: "typecheck", skipReason: undefined };
}

// ── preamble loading ──────────────────────────────────────────────────────────

/**
 * Optional per-document preamble file. Place a file at the same path as the
 * doc with a `.preamble.ts` suffix to declare names that snippets in that doc
 * rely on (for example `declare const app: Express.Application`). The preamble
 * is prepended to every snippet in that file when type-checking.
 */
function loadPreamble(docFile: string): string {
  const preamblePath = docFile.replace(/\.(md|mdx)$/, ".preamble.ts");
  if (fs.existsSync(preamblePath)) {
    return `${fs.readFileSync(preamblePath, "utf8")}\n`;
  }
  return "";
}

// ── snippet extraction ────────────────────────────────────────────────────────

/**
 * Extracts TypeScript code snippets from a doc file. MDX files are parsed
 * properly with remark-mdx; plain .md files use remark-parse.
 */
function extractSnippets(file: string): Snippet[] {
  const content = fs.readFileSync(file, "utf8");
  const isMdx = file.endsWith(".mdx");
  const preamble = loadPreamble(file);

  const processor = isMdx ? remark().use(remarkParse).use(remarkMdx) : remark().use(remarkParse);

  const tree = processor.parse(content) as Root;
  const snippets: Snippet[] = [];
  visit(tree, "code", (node: Code) => {
    const lang = node.lang ?? "";
    if (lang !== "ts" && lang !== "tsx" && lang !== "typescript") return;
    const normalLang: "ts" | "tsx" = lang === "tsx" ? "tsx" : "ts";

    // Determine the 1-based line number from the node position.
    const line = node.position?.start.line ?? 0;
    const { kind, skipReason } = parseAnnotation(node.meta);

    snippets.push({
      file,
      line,
      lang: normalLang,
      kind,
      skipReason,
      preamble,
      code: node.value,
    });
  });

  return snippets;
}

// ── type-checking ─────────────────────────────────────────────────────────────

/**
 * Type-checks a single snippet by writing it to a temp file and invoking tsc.
 * Returns a list of error strings (empty on success).
 */
function typecheckSnippet(snippet: Snippet, tmpDir: string): string[] {
  const fileName = `snippet_${snippet.file.replace(/[^a-z0-9]/gi, "_")}_${snippet.line}.${snippet.lang}`;
  const filePath = path.join(tmpDir, fileName);
  const tsconfigPath = path.join(tmpDir, `tsconfig_${fileName}.json`);

  const tsconfigContent = {
    extends: TSCONFIG_BASE,
    compilerOptions: {
      moduleResolution: "bundler",
      module: "ESNext",
      target: "ESNext",
      noEmit: true,
      skipLibCheck: true,
      // Resolve node built-in types.
      types: ["node"],
      // JSX support for tsx snippets.
      ...(snippet.lang === "tsx" ? { jsx: "react-jsx", jsxImportSource: "react" } : {}),
      baseUrl: ROOT,
      // Map workspace packages to their source so the checker does not need a build.
      paths: {
        "@vegaforge/tollway-core": [path.join(ROOT, "packages/core/src/index.ts")],
        "@vegaforge/tollway-server": [path.join(ROOT, "packages/server/src/index.ts")],
        "@vegaforge/tollway-channels": [path.join(ROOT, "packages/channels/src/index.ts")],
        "@vegaforge/tollway-reconcile": [path.join(ROOT, "packages/reconcile/src/index.ts")],
        "@vegaforge/tollway-client": [path.join(ROOT, "packages/client/src/index.ts")],
        "@vegaforge/tollway-observability": [
          path.join(ROOT, "packages/observability/src/index.ts"),
        ],
        "@vegaforge/tollway-adapter-express": [
          path.join(ROOT, "packages/adapter-express/src/index.ts"),
        ],
      },
    },
    // The snippet file is included directly.
    include: [filePath],
  };

  const content = snippet.preamble + snippet.code;
  fs.writeFileSync(filePath, content, "utf8");
  fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfigContent, null, 2), "utf8");

  const tscBin = path.join(ROOT, "node_modules", ".bin", "tsc");
  const result = spawnSync(tscBin, ["--noEmit", "--project", tsconfigPath], {
    encoding: "utf8",
    cwd: ROOT,
  });

  if (result.status === 0) return [];

  const output = (result.stdout ?? "") + (result.stderr ?? "");
  const rel = `${path.relative(ROOT, snippet.file)}:${snippet.line}`;
  return output
    .split("\n")
    .filter((l) => l.includes(fileName) && /error TS/.test(l))
    .map((l) => {
      // Replace the temp absolute path with the doc:line reference.
      return l.replace(new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), rel);
    });
}

// ── snippet runner ────────────────────────────────────────────────────────────

/**
 * Runs a snippet in an isolated child process. The snippet must not require a
 * network; it runs with top-level await under tsx.
 */
function runSnippet(snippet: Snippet, tmpDir: string): string[] {
  const fileName = `run_${snippet.line}.${snippet.lang}`;
  const filePath = path.join(tmpDir, fileName);
  const content = snippet.preamble + snippet.code;
  fs.writeFileSync(filePath, content, "utf8");

  const tsxBin = path.join(ROOT, "node_modules", ".bin", "tsx");
  const result = spawnSync(tsxBin, [filePath], {
    encoding: "utf8",
    cwd: ROOT,
    timeout: TIMEOUT_MS,
    env: { ...process.env, NODE_PATH: path.join(ROOT, "node_modules") },
  });

  if (result.status === 0 && !result.error) return [];

  const errors: string[] = [];
  if (result.error) {
    errors.push(
      result.error.message.includes("ETIMEDOUT")
        ? `timed out after ${TIMEOUT_MS}ms`
        : result.error.message,
    );
  }
  if (result.stderr) {
    errors.push(result.stderr.slice(0, 500));
  }
  return errors;
}

// ── main ──────────────────────────────────────────────────────────────────────

function label(snippet: Snippet): string {
  return `${path.relative(ROOT, snippet.file)}:${snippet.line}`;
}

async function main(): Promise<void> {
  const files = findDocFiles();
  if (VERBOSE) console.log(`Scanning ${files.length} doc file(s)...\n`);

  const allSnippets: Snippet[] = [];
  for (const file of files) {
    allSnippets.push(...extractSnippets(file));
  }

  if (allSnippets.length === 0) {
    console.log("No TypeScript snippets found.");
    return;
  }

  // Report unannotated skips as errors up front.
  const unannotated = allSnippets.filter((s) => s.kind === "skip" && s.skipReason === "");
  if (unannotated.length > 0) {
    for (const s of unannotated) {
      console.error(`✗ ${label(s)}  skip= requires a reason`);
    }
    console.error(`\n${unannotated.length} snippet(s) have unannotated skips.`);
    process.exitCode = 1;
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tollway-snippets-"));

  const results: SnippetResult[] = [];
  let passed = 0;
  let skipped = 0;
  let failed = 0;

  for (const snippet of allSnippets) {
    if (snippet.kind === "skip") {
      if (VERBOSE) console.log(`○ ${label(snippet)}  (skip: ${snippet.skipReason ?? ""})`);
      results.push({ kind: "skip", snippet });
      skipped++;
      continue;
    }

    // Type-check all non-skip snippets.
    const typeErrors = typecheckSnippet(snippet, tmpDir);

    if (typeErrors.length > 0) {
      for (const e of typeErrors) console.error(`✗ ${label(snippet)}  ${e}`);
      results.push({ kind: "fail", snippet, errors: typeErrors });
      failed++;
      continue;
    }

    // Run snippets annotated `run`.
    if (snippet.kind === "run") {
      const runErrors = runSnippet(snippet, tmpDir);
      if (runErrors.length > 0) {
        for (const e of runErrors) console.error(`✗ ${label(snippet)} [run]  ${e}`);
        results.push({ kind: "fail", snippet, errors: runErrors });
        failed++;
        continue;
      }
    }

    if (VERBOSE) console.log(`✓ ${label(snippet)}`);
    results.push({ kind: "pass", snippet });
    passed++;
  }

  // Clean up.
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const total = allSnippets.length;
  console.log(
    `\nDoc snippets: ${passed} passed, ${skipped} skipped, ${failed} failed (${total} total)`,
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error("check-doc-snippets failed:", err);
  process.exitCode = 1;
});
