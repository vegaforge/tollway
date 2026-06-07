import { brand, cssVarName, cssVarPrefix, dark, light, type SemanticTokens } from "./tokens.js";

function declarations(tokens: SemanticTokens, indent: string): string {
  return (Object.keys(tokens) as Array<keyof SemanticTokens>)
    .map((key) => `${indent}${cssVarName(key)}: ${tokens[key]};`)
    .join("\n");
}

function brandDeclarations(indent: string): string {
  const names: Record<keyof typeof brand, string> = {
    ink: "ink",
    vermilion: "vermilion",
    amber: "amber",
    offWhite: "off-white",
  };
  return (Object.keys(brand) as Array<keyof typeof brand>)
    .map((key) => `${indent}${cssVarPrefix}-${names[key]}: ${brand[key]};`)
    .join("\n");
}

/**
 * Renders the full tokens stylesheet. Light is the default on :root, dark
 * applies under a .dark class or a data-theme="dark" attribute, whichever
 * the consuming app prefers to toggle.
 */
export function renderTokensCss(): string {
  return `/* Generated from @tollway/theme. Edit src/tokens.ts, not this file. */

:root {
${brandDeclarations("  ")}

${declarations(light, "  ")}
}

.dark,
[data-theme="dark"] {
${declarations(dark, "  ")}
}
`;
}
