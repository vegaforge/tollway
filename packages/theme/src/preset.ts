import { cssVar } from "./tokens.js";

/**
 * A Tailwind preset wiring the semantic roles to the CSS variables from
 * tokens.css. Deliberately typed without importing tailwindcss so this
 * package stays dependency free and works with both v3 and v4 configs.
 *
 * Usage:
 *   import { tollwayPreset } from "@tollway/theme/preset";
 *   export default { presets: [tollwayPreset], ... };
 *
 * and import "@tollway/theme/tokens.css" once in the app's root stylesheet.
 */
export interface TollwayTailwindPreset {
  darkMode: [string, string];
  theme: {
    extend: {
      colors: Record<string, string | Record<string, string>>;
    };
  };
}

export const tollwayPreset: TollwayTailwindPreset = {
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        background: cssVar("background"),
        foreground: cssVar("foreground"),
        muted: cssVar("muted"),
        primary: {
          DEFAULT: cssVar("primary"),
          foreground: cssVar("primaryForeground"),
        },
        accent: {
          DEFAULT: cssVar("accent"),
          foreground: cssVar("accentForeground"),
        },
        surface: {
          DEFAULT: cssVar("surface"),
          elevated: cssVar("surfaceElevated"),
        },
        border: {
          DEFAULT: cssVar("border"),
          strong: cssVar("borderStrong"),
        },
      },
    },
  },
};

export default tollwayPreset;
