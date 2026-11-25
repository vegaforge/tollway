import { describe, expect, it } from "vitest";
import { trimSlashes, trimTrailingSlashes } from "./trim.js";

/**
 * The trimming here replaced `/^\/+|\/+$/g` and `/\/+$/`, which backtrack
 * quadratically on a long run of slashes that is not at the end of the
 * string. These inputs take seconds with those patterns and microseconds
 * with a loop, so they would time the test out if the regexes came back.
 */
const RUN = 100_000;

describe("trimSlashes", () => {
  it("removes leading and trailing slashes only", () => {
    expect(trimSlashes("/transit/")).toBe("transit");
    expect(trimSlashes("//team/transit//")).toBe("team/transit");
    expect(trimSlashes("team//transit")).toBe("team//transit");
    expect(trimSlashes("///")).toBe("");
    expect(trimSlashes("")).toBe("");
  });

  it("stays linear on a long run of slashes inside the value", () => {
    const value = `a${"/".repeat(RUN)}b`;
    expect(trimSlashes(value)).toBe(value);
    expect(trimSlashes(`${"/".repeat(RUN)}x${"/".repeat(RUN)}`)).toBe("x");
  });
});

describe("trimTrailingSlashes", () => {
  it("removes trailing slashes only", () => {
    expect(trimTrailingSlashes("https://vault.test:8200//")).toBe("https://vault.test:8200");
    expect(trimTrailingSlashes("/a/")).toBe("/a");
  });

  it("stays linear on a long run of slashes inside the value", () => {
    const value = `https://vault.test${"/".repeat(RUN)}x`;
    expect(trimTrailingSlashes(value)).toBe(value);
  });
});
