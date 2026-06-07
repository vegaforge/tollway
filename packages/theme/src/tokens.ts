/**
 * Tollway brand palette and semantic color roles.
 *
 * These objects are the single source of truth for color in the project.
 * The stylesheet (tokens.css) and the Tailwind preset are both derived from
 * them, and no app should hardcode a hex value outside this package.
 */

/** The four brand colors. Everything else is a role assignment. */
export const brand = {
  ink: "#232331",
  vermilion: "#CF432F",
  amber: "#E59B35",
  offWhite: "#F8F6FB",
} as const;

export type BrandColor = keyof typeof brand;

/** The semantic roles every surface in dashboard, web, and docs consumes. */
export interface SemanticTokens {
  background: string;
  foreground: string;
  primary: string;
  primaryForeground: string;
  accent: string;
  accentForeground: string;
  surface: string;
  border: string;
}

export const light: SemanticTokens = {
  background: brand.offWhite,
  foreground: brand.ink,
  primary: brand.vermilion,
  primaryForeground: brand.offWhite,
  accent: brand.amber,
  accentForeground: brand.ink,
  surface: "#FFFFFF",
  // Ink at low opacity, so borders pick up whatever sits behind them.
  border: "rgb(35 35 49 / 0.12)",
};

export const dark: SemanticTokens = {
  background: brand.ink,
  foreground: brand.offWhite,
  primary: brand.vermilion,
  primaryForeground: brand.offWhite,
  accent: brand.amber,
  accentForeground: brand.ink,
  // A step lighter than ink, enough for cards to read as raised.
  surface: "#2C2C3E",
  border: "rgb(248 246 251 / 0.14)",
};

/** Prefix shared by every CSS custom property this package emits. */
export const cssVarPrefix = "--tollway";

/** Maps a SemanticTokens key to its CSS custom property name. */
export function cssVarName(token: keyof SemanticTokens): string {
  const kebab = token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return `${cssVarPrefix}-${kebab}`;
}

/** A var() reference for use in Tailwind config or inline styles. */
export function cssVar(token: keyof SemanticTokens): string {
  return `var(${cssVarName(token)})`;
}
