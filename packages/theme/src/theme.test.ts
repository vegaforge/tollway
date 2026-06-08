import { describe, expect, it } from "vitest";
import { renderTokensCss } from "./css.js";
import { tollwayPreset } from "./preset.js";
import { brand, cssVar, cssVarName, dark, light } from "./tokens.js";

describe("brand palette", () => {
  it("matches the four brand colors", () => {
    expect(brand.ink).toBe("#232331");
    expect(brand.vermilion).toBe("#CF432F");
    expect(brand.amber).toBe("#E59B35");
    expect(brand.offWhite).toBe("#F8F6FB");
  });

  it("anchors the light theme on the brand palette", () => {
    expect(light.background).toBe(brand.offWhite);
    expect(light.foreground).toBe(brand.ink);
    expect(light.primary).toBe(brand.vermilion);
    expect(light.accent).toBe(brand.amber);
  });

  it("defines a near-black dark theme that keeps brand accents", () => {
    expect(dark.background).toBe("#141017");
    expect(dark.foreground).toBe("#F4F2F8");
    // A lifted vermilion and amber, tuned for contrast on the dark background.
    expect(dark.primary).toBe("#E2563F");
    expect(dark.accent).toBe("#E9A648");
  });

  it("carries the extended surface, border, and muted roles", () => {
    expect(light.surfaceElevated).toBe("#F1EEF7");
    expect(light.borderStrong).toBe("#D6D1E0");
    expect(light.muted).toBe("#6A6675");
    expect(dark.surfaceElevated).toBe("#24202D");
    expect(dark.borderStrong).toBe("#3A3546");
    expect(dark.muted).toBe("#A39FB0");
  });
});

describe("css variable naming", () => {
  it("converts camelCase tokens to kebab-case custom properties", () => {
    expect(cssVarName("primaryForeground")).toBe("--tollway-primary-foreground");
    expect(cssVarName("surfaceElevated")).toBe("--tollway-surface-elevated");
    expect(cssVarName("borderStrong")).toBe("--tollway-border-strong");
    expect(cssVar("background")).toBe("var(--tollway-background)");
  });
});

describe("renderTokensCss", () => {
  const css = renderTokensCss();

  it("declares light tokens on :root", () => {
    expect(css).toContain(":root {");
    expect(css).toContain("--tollway-background: #F8F6FB;");
    expect(css).toContain("--tollway-primary: #CF432F;");
    expect(css).toContain("--tollway-border: #E4E0EC;");
    expect(css).toContain("--tollway-muted: #6A6675;");
    expect(css).toContain("--tollway-surface-elevated: #F1EEF7;");
  });

  it("declares dark tokens under .dark and data-theme", () => {
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain("--tollway-background: #141017;");
    expect(css).toContain("--tollway-surface: #1D1924;");
    expect(css).toContain("--tollway-border-strong: #3A3546;");
  });

  it("exposes the raw brand palette", () => {
    expect(css).toContain("--tollway-off-white: #F8F6FB;");
    expect(css).toContain("--tollway-vermilion: #CF432F;");
  });
});

describe("tailwind preset", () => {
  it("points every color at a css variable instead of a hex value", () => {
    const flat = JSON.stringify(tollwayPreset.theme.extend.colors);
    expect(flat).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(tollwayPreset.theme.extend.colors.background).toBe("var(--tollway-background)");
  });

  it("supports both class and data-attribute dark mode", () => {
    expect(tollwayPreset.darkMode).toEqual(["class", '[data-theme="dark"]']);
  });
});
