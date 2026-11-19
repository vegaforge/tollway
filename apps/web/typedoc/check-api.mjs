// @ts-check
/**
 * Fails the web build when the generated API reference is incomplete: every
 * entry point in modules.mjs must have produced a page with a title, and the
 * generated sidebar must list each of them. Run after TypeDoc in
 * `pnpm run api`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { modules } from "./modules.mjs";

/**
 * @param {string} directory the generated folder, src/content/docs/api
 * @returns {string[]} one message per problem; empty when the reference is complete
 */
export function checkApiReference(directory) {
  const problems = [];
  const metaPath = join(directory, "meta.json");
  /** @type {{ pages?: unknown }} */
  let meta = {};
  if (existsSync(metaPath)) {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } else {
    problems.push(`${metaPath} is missing, so the sidebar has no API section.`);
  }
  const pages = Array.isArray(meta.pages) ? meta.pages : [];

  for (const entry of [{ slug: "index", importPath: "API reference index" }, ...modules]) {
    const page = join(directory, `${entry.slug}.mdx`);
    if (!existsSync(page)) {
      problems.push(`No page was generated for ${entry.importPath} (${page}).`);
      continue;
    }
    const text = readFileSync(page, "utf8");
    if (!/^---\ntitle: .+\ndescription: .+\n---\n/.test(text)) {
      problems.push(`${page} has no title and description frontmatter.`);
    }
    if (/\]\([^)]*\.mdx[#)]/.test(text)) {
      problems.push(`${page} still links to a .mdx file instead of a site URL.`);
    }
    if (!pages.includes(entry.slug)) {
      problems.push(`The sidebar (meta.json) does not list ${entry.slug}.`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = fileURLToPath(new URL("../src/content/docs/api", import.meta.url));
  const problems = checkApiReference(directory);
  if (problems.length > 0) {
    console.error(
      `The API reference is incomplete:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    process.exit(1);
  }
  console.log(`API reference complete: ${modules.length} package entry points.`);
}
