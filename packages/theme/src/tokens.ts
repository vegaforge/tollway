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

/** The semantic roles every surface in web, dashboard, and docs consumes. */
export interface SemanticTokens {
  background: string;
  foreground: string;
  /** Secondary foreground for supporting copy. */
  muted: string;
  primary: string;
  primaryForeground: string;
  accent: string;
  accentForeground: string;
  /** Base card surface, one step off the background. */
  surface: string;
  /** Raised surface, one step above the base card. */
  surfaceElevated: string;
  border: string;
  /** Higher-contrast border for emphasis and dividers. */
  borderStrong: string;
}

export const light: SemanticTokens = {
  background: brand.offWhite,
  foreground: brand.ink,
  muted: "#6A6675",
  primary: brand.vermilion,
  primaryForeground: "#FFFFFF",
  accent: brand.amber,
  accentForeground: brand.ink,
  surface: "#FFFFFF",
  surfaceElevated: "#F1EEF7",
  border: "#E4E0EC",
  borderStrong: "#D6D1E0",
};

export const dark: SemanticTokens = {
  background: "#141017",
  foreground: "#F4F2F8",
  muted: "#A39FB0",
  // A lifted vermilion holds contrast against the near-black background.
  primary: "#E2563F",
  primaryForeground: "#1A1119",
  accent: "#E9A648",
  accentForeground: brand.ink,
  surface: "#1D1924",
  surfaceElevated: "#24202D",
  border: "#2C2836",
  borderStrong: "#3A3546",
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
