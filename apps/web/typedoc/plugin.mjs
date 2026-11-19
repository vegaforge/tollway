// @ts-check
/**
 * Local TypeDoc plugin that turns typedoc-plugin-markdown output into pages
 * the Fumadocs site can serve under /docs/api. It:
 *
 * 1. names each module after its package, so the page is /docs/api/core
 *    rather than /docs/api/core/src;
 * 2. gives every page the `title` and `description` frontmatter that
 *    `frontmatterSchema` in source.config.ts requires;
 * 3. rewrites relative `.mdx` links to absolute site URLs, because Fumadocs
 *    routes by slug and does not resolve a file link;
 * 4. writes the folder's meta.json so the sidebar gets its own section;
 * 5. prints the exports that have no doc comment.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Comment, Converter, ReflectionKind, RendererEvent } from "typedoc";
import { MarkdownPageEvent } from "typedoc-plugin-markdown";

import { modules, packageForEntry } from "./modules.mjs";

const BASE_URL = "/docs/api";

/** Undocumented exports per page slug, filled while converting. */
const undocumented = new Map();

/**
 * @param {import("typedoc").Reflection} reflection
 * @returns {boolean}
 */
function hasDocs(reflection) {
  if (reflection.hasComment()) return true;
  // Functions and methods carry their comment on the signature.
  if ("signatures" in reflection && Array.isArray(reflection.signatures)) {
    return reflection.signatures.some((signature) => signature.hasComment());
  }
  return false;
}

/**
 * @param {import("typedoc").Application} app
 */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const module of context.project.children ?? []) {
      const entry = packageForEntry(module.name);
      if (!entry) {
        throw new Error(
          `TypeDoc produced a module "${module.name}" that typedoc/modules.mjs does not list.`,
        );
      }
      module.name = entry.slug;
    }
  });

  app.converter.on(Converter.EVENT_RESOLVE_END, (context) => {
    for (const module of context.project.children ?? []) {
      const missing = (module.children ?? [])
        .filter((child) => !child.kindOf(ReflectionKind.Reference) && !hasDocs(child))
        .map((child) => child.name)
        .sort();
      undocumented.set(module.name, missing);
    }
  });

  app.renderer.on(MarkdownPageEvent.BEGIN, (page) => {
    if (page.model.kindOf(ReflectionKind.Project)) {
      page.frontmatter = {
        title: "API reference",
        description: "Generated from the TSDoc comments of every publishable Tollway package.",
      };
      return;
    }
    const entry = modules.find((candidate) => candidate.slug === page.model.name);
    if (!entry) return;
    const comment = page.model.comment;
    const summary = comment ? Comment.combineDisplayParts(comment.summary).trim() : "";
    page.frontmatter = {
      title: entry.importPath,
      description: summary.split("\n\n")[0]?.replace(/\s+/g, " ") || entry.description,
    };
  });

  app.renderer.on(MarkdownPageEvent.END, (page) => {
    if (!page.contents) return;
    // "core.mdx#signedreceipt" and "index.mdx" become site URLs.
    page.contents = page.contents.replace(
      /\]\((?:\.\/)?([a-z-]+)\.mdx(#[^)]*)?\)/g,
      (_match, slug, anchor = "") =>
        `](${slug === "index" ? BASE_URL : `${BASE_URL}/${slug}`}${anchor})`,
    );
  });

  app.renderer.on(RendererEvent.END, (event) => {
    mkdirSync(event.outputDirectory, { recursive: true });
    const meta = {
      title: "API reference",
      pages: ["index", ...modules.map((entry) => entry.slug)],
    };
    writeFileSync(join(event.outputDirectory, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

    const lines = [];
    let total = 0;
    for (const entry of modules) {
      const missing = undocumented.get(entry.slug) ?? [];
      total += missing.length;
      if (missing.length > 0) lines.push(`  ${entry.importPath}: ${missing.join(", ")}`);
    }
    app.logger.info(
      total === 0
        ? "Every export has a doc comment."
        : `Exports with no doc comment (${total}):\n${lines.join("\n")}`,
    );
  });
}
