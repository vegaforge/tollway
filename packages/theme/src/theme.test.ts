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

  it("assigns roles from the palette, not new hex values", () => {
    expect(light.background).toBe(brand.offWhite);
    expect(light.primary).toBe(brand.vermilion);
    expect(dark.background).toBe(brand.ink);
    expect(dark.accent).toBe(brand.amber);
  });
});

describe("css variable naming", () => {
  it("converts camelCase tokens to kebab-case custom properties", () => {
    expect(cssVarName("primaryForeground")).toBe("--tollway-primary-foreground");
    expect(cssVar("background")).toBe("var(--tollway-background)");
  });
});

describe("renderTokensCss", () => {
  const css = renderTokensCss();

  it("declares light tokens on :root", () => {
    expect(css).toContain(":root {");
    expect(css).toContain("--tollway-background: #F8F6FB;");
    expect(css).toContain("--tollway-primary: #CF432F;");
    expect(css).toContain("--tollway-border: rgb(35 35 49 / 0.12);");
  });

  it("declares dark tokens under .dark and data-theme", () => {
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain("--tollway-surface: #2C2C3E;");
    expect(css).toContain("--tollway-border: rgb(248 246 251 / 0.14);");
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
