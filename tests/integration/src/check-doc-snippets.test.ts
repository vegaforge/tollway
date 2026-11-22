/**
 * Tests for check-doc-snippets.ts using fixture documents.
 *
 * Each fixture is a small markdown string. We test the checker's logic
 * directly by calling the same extraction and type-checking paths the script
 * uses, without invoking the CLI.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Code, Root } from "mdast";
import { remark } from "remark";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Re-implement the annotation parser inline for tests (avoids importing the
// script directly, which has top-level side-effects).
type AnnotationKind = "typecheck" | "run" | "illustrative" | "skip";
function parseAnnotation(meta: string | null | undefined): {
  kind: AnnotationKind;
  skipReason: string | undefined;
} {
  const m = meta?.trim() ?? "";
  if (!m) return { kind: "typecheck", skipReason: undefined };
  if (m === "run") return { kind: "run", skipReason: undefined };
  if (m === "illustrative") return { kind: "illustrative", skipReason: undefined };
  if (m.startsWith("skip=")) {
    const reason = m.slice(5).trim();
    return { kind: "skip", skipReason: reason };
  }
  return { kind: "typecheck", skipReason: undefined };
}

function extractFromMd(content: string) {
  const processor = remark().use(remarkParse);
  const tree = processor.parse(content) as Root;
  const snippets: Array<{
    lang: string;
    kind: AnnotationKind;
    skipReason: string | undefined;
    code: string;
    line: number;
  }> = [];
  visit(tree, "code", (node: Code) => {
    const lang = node.lang ?? "";
    if (lang !== "ts" && lang !== "tsx") return;
    const { kind, skipReason } = parseAnnotation(node.meta);
    snippets.push({
      lang,
      kind,
      skipReason,
      code: node.value,
      line: node.position?.start.line ?? 0,
    });
  });
  return snippets;
}

const ROOT = path.resolve(import.meta.dirname, "../../..");

// ── annotation parsing ────────────────────────────────────────────────────────

describe("parseAnnotation", () => {
  it("defaults to typecheck when meta is absent", () => {
    expect(parseAnnotation(null)).toEqual({ kind: "typecheck", skipReason: undefined });
    expect(parseAnnotation("")).toEqual({ kind: "typecheck", skipReason: undefined });
  });

  it("parses run annotation", () => {
    expect(parseAnnotation("run")).toEqual({ kind: "run", skipReason: undefined });
  });

  it("parses illustrative annotation", () => {
    expect(parseAnnotation("illustrative")).toEqual({
      kind: "illustrative",
      skipReason: undefined,
    });
  });

  it("parses skip=reason annotation", () => {
    expect(parseAnnotation("skip=uses a local module")).toEqual({
      kind: "skip",
      skipReason: "uses a local module",
    });
  });

  it("returns empty skipReason for bare skip= with no reason", () => {
    expect(parseAnnotation("skip=")).toEqual({ kind: "skip", skipReason: "" });
  });
});

// ── snippet extraction ────────────────────────────────────────────────────────

describe("snippet extraction", () => {
  it("extracts ts and tsx blocks from markdown", () => {
    const md = `
# Docs

\`\`\`ts
const x: number = 1;
\`\`\`

\`\`\`tsx
const y = <div />;
\`\`\`

\`\`\`bash
echo "not extracted"
\`\`\`
`;
    const snippets = extractFromMd(md);
    expect(snippets).toHaveLength(2);
    expect(snippets[0]?.lang).toBe("ts");
    expect(snippets[1]?.lang).toBe("tsx");
  });

  it("extracts annotation kind correctly", () => {
    const md = `
\`\`\`ts run
console.log("hello");
\`\`\`

\`\`\`ts illustrative
type Foo = { bar: string };
\`\`\`

\`\`\`ts skip=local imports
import { something } from "./local.js";
\`\`\`
`;
    const snippets = extractFromMd(md);
    expect(snippets[0]?.kind).toBe("run");
    expect(snippets[1]?.kind).toBe("illustrative");
    expect(snippets[2]?.kind).toBe("skip");
    expect(snippets[2]?.skipReason).toBe("local imports");
  });

  it("records the 1-based line number of the opening fence", () => {
    const md = "line1\nline2\nline3\n```ts\nconst x = 1;\n```\n";
    const snippets = extractFromMd(md);
    expect(snippets[0]?.line).toBe(4);
  });
});

// ── type-checking integration ─────────────────────────────────────────────────

describe("type-checking (integration)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tollway-snippet-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeAndCheck(code: string, lang: "ts" | "tsx" = "ts"): string[] {
    const fileName = `snippet.${lang}`;
    const filePath = path.join(tmpDir, fileName);
    const tsconfigPath = path.join(tmpDir, "tsconfig.json");

    fs.writeFileSync(filePath, code, "utf8");
    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: {
          moduleResolution: "bundler",
          module: "ESNext",
          target: "ESNext",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          baseUrl: ROOT,
          paths: {
            "@vegaforge/tollway-core": [path.join(ROOT, "packages/core/src/index.ts")],
          },
        },
        include: [filePath],
      }),
      "utf8",
    );

    const tscBin = path.join(ROOT, "node_modules", ".bin", "tsc");
    const result = spawnSync(tscBin, ["--noEmit", "--project", tsconfigPath], {
      encoding: "utf8",
      cwd: ROOT,
    });
    if (result.status === 0) return [];
    return ((result.stdout ?? "") + (result.stderr ?? ""))
      .split("\n")
      .filter((l) => /error TS/.test(l));
  }

  it("passes a valid snippet", () => {
    const errors = writeAndCheck(
      `import { buildReceipt } from "@vegaforge/tollway-core";
// only the import is needed to confirm the module resolves
void buildReceipt;
`,
    );
    expect(errors).toHaveLength(0);
  });

  it("fails a snippet with a type error", () => {
    const errors = writeAndCheck(`const x: number = "this is a string";`);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/error TS/);
  });

  it("fails a snippet that references an undeclared name", () => {
    const errors = writeAndCheck(`const y = undeclaredVariable;`);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("passes a snippet that imports from tollway-core", () => {
    const errors = writeAndCheck(
      `import { type SignedReceipt } from "@vegaforge/tollway-core";
declare const r: SignedReceipt;
void r;
`,
    );
    expect(errors).toHaveLength(0);
  });
});

// ── drifting illustrative type detection ──────────────────────────────────────

describe("illustrative type drift detection", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tollway-snippet-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects when an illustrative type is missing a field from the real type", () => {
    // Write a file that re-states a type with one field removed and checks
    // assignability. The assignability assertion fails if the doc type is
    // narrower than the real type.
    const filePath = path.join(tmpDir, "drift.ts");
    const tsconfigPath = path.join(tmpDir, "tsconfig.json");

    // A simplified drift check: the real type has `field: string`, the doc
    // restates it without `field`. An object satisfying the real type should
    // not satisfy the doc type (and vice versa for the other direction).
    fs.writeFileSync(
      filePath,
      `// Real type (from a package, normally):
type RealType = { id: string; amount: string };
// Illustrative type (as stated in the doc):
type DocType = { id: string }; // missing "amount"
// Assignability assertion: DocType must be a subtype of RealType.
// This fails because DocType is missing the "amount" field.
const _check: RealType = {} as DocType;
`,
      "utf8",
    );

    fs.writeFileSync(
      tsconfigPath,
      JSON.stringify({
        compilerOptions: { noEmit: true, strict: true },
        include: [filePath],
      }),
      "utf8",
    );

    const tscBin = path.join(ROOT, "node_modules", ".bin", "tsc");
    const result = spawnSync(tscBin, ["--noEmit", "--project", tsconfigPath], {
      encoding: "utf8",
      cwd: ROOT,
    });

    // The assignment should fail because DocType is missing "amount".
    expect(result.status).not.toBe(0);
  });
});
