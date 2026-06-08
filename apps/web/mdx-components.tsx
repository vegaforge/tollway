import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

/**
 * The MDX component map for the docs corpus. Every MDX file picks these up
 * without an explicit import. Add shared components (callouts, tabs, cards)
 * here as the docs grow.
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    ...components,
  };
}
