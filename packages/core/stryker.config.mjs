// Mutation testing for this package (issue #247). Run it with `pnpm mutation`
// from the repository root; `pnpm test` and ./scripts/preflight.sh never run it.
// Options: https://stryker-mutator.io/docs/stryker-js/configuration/
const config = {
  packageManager: "pnpm",
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  // Each mutant runs only the tests that cover it.
  coverageAnalysis: "perTest",
  // Production logic only. Tests and the re-export barrel are excluded; no
  // production file is excluded to raise the score.
  mutate: ["src/**/*.ts", "!src/**/*.test.ts", "!src/index.ts"],
  // Mutants in module-level initialisers would need the whole suite per
  // mutant; Stryker reports them as ignored rather than guessing.
  ignoreStatic: true,
  tempDirName: ".stryker-tmp",
  // Both package scripts pass --incremental, so every run writes this file;
  // `mutation` adds --force to test every mutant. CI caches the file from the
  // weekly full run, so a pull request only re-tests the mutants it affects.
  incrementalFile: "reports/stryker-incremental.json",
  reporters: ["clear-text", "progress", "html", "json"],
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  thresholds: {
    high: 90,
    low: 75,
    // The score after the first round of fixes (72.47%, issue #247), rounded
    // down. It only ever goes up: lowering it to pass a run hides a missing
    // test, which AGENTS.md Directive 4 forbids. Kill the mutant instead, or
    // list it as equivalent in docs/mutation-testing.md.
    break: 72,
  },
};

export default config;
