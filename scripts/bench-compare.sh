#!/usr/bin/env bash
#
# Measures the gate benchmarks on a base tree and a head tree on the same
# machine and fails if the head made a gate-level benchmark measurably
# slower. .github/workflows/bench.yml runs it on pull requests; it also runs
# locally. See docs/benchmarks.md.
#
# Usage:
#   scripts/bench-compare.sh <base-tree> <head-tree> <out-dir>
#
# Both trees are checkouts with dependencies installed (pnpm install). The
# benchmark suite always comes from the head tree, so base and head run the
# same harness. Only the packages under test change between runs: the script
# builds both trees, then swaps each tree's built dist/ folders into the head
# tree before running the suite. Third-party dependencies come from the head
# tree for both runs, so a pull request that only bumps a dependency is not
# compared here.
#
# The comparison rule (15% median threshold, 5% noise floor, a regression
# must repeat in 2 of up to 3 rounds) lives in packages/bench/src/compare.ts.
#
# Exit status: 0 pass, 1 confirmed regression or a failed head run,
# 2 unusable input.

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <base-tree> <head-tree> <out-dir>" >&2
  exit 2
fi

BASE_TREE="$(cd "$1" && pwd)"
HEAD_TREE="$(cd "$2" && pwd)"
mkdir -p "$3"
OUT="$(cd "$3" && pwd)"

# The workspace packages the suite imports. Keep in step with the
# devDependencies of packages/bench/package.json.
PACKAGES=(core server adapter-express adapter-fastify adapter-hono adapter-next)
MAX_ROUNDS=3
NOTES=()

build_and_stash() {
  local tree="$1" side="$2"
  echo "Building the packages under test in the $side tree"
  (
    cd "$tree"
    pnpm exec turbo run build \
      --filter=@vegaforge/tollway-core \
      --filter=@vegaforge/tollway-server \
      --filter='@vegaforge/tollway-adapter-*'
  )
  rm -rf "$OUT/dist-$side"
  mkdir -p "$OUT/dist-$side"
  for package in "${PACKAGES[@]}"; do
    cp -R "$tree/packages/$package/dist" "$OUT/dist-$side/$package"
  done
}

use_dist() {
  local side="$1"
  for package in "${PACKAGES[@]}"; do
    rm -rf "$HEAD_TREE/packages/$package/dist"
    cp -R "$OUT/dist-$side/$package" "$HEAD_TREE/packages/$package/dist"
  done
}

# Runs the suite against one side's build. Returns vitest's exit status.
run_suite() {
  local side="$1" round="$2"
  use_dist "$side"
  echo "Round $round: running the suite on $side"
  local status=0
  (cd "$HEAD_TREE/packages/bench" &&
    pnpm exec vitest bench --run --outputJson "$OUT/$side-$round.json") \
    >"$OUT/$side-$round.log" 2>&1 || status=$?
  return "$status"
}

build_and_stash "$BASE_TREE" base
build_and_stash "$HEAD_TREE" head

ARGS=()
STATUS=2
for round in $(seq 1 "$MAX_ROUNDS"); do
  # Alternate which side goes first, so a machine that speeds up or slows
  # down during the job does not always favour the same side.
  if [ $((round % 2)) -eq 1 ]; then order=(base head); else order=(head base); fi
  for side in "${order[@]}"; do
    side_status=0
    run_suite "$side" "$round" || side_status=$?
    if [ "$side_status" -eq 0 ]; then
      continue
    fi
    cat "$OUT/$side-$round.log"
    if [ "$side" = "head" ]; then
      echo "The suite failed on the head build (exit $side_status). See the log above." >&2
      use_dist head
      exit 1
    fi
    # The suite comes from the head, so a benchmark that uses an API the
    # pull request adds cannot run on the base. That is not a regression:
    # those benchmarks show as "new (no base)", and the note says why. A base
    # run that wrote no result at all still stops the comparison below.
    NOTES+=(--note "Round $round: the suite exited with status $side_status on the base build; benchmarks it could not run show as new (no base).")
  done

  ARGS+=(--base "$OUT/base-$round.json" --head "$OUT/head-$round.json")
  STATUS=0
  (cd "$HEAD_TREE/packages/bench" &&
    pnpm exec tsx src/cli.ts "${ARGS[@]}" ${NOTES[@]+"${NOTES[@]}"} --markdown "$OUT/summary.md") ||
    STATUS=$?
  if [ "$STATUS" -ne 3 ]; then
    break
  fi
done

# Leave the head tree as it was built.
use_dist head

if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -f "$OUT/summary.md" ]; then
  cat "$OUT/summary.md" >>"$GITHUB_STEP_SUMMARY"
fi

if [ "$STATUS" -eq 3 ]; then
  echo "The comparison asked for more than $MAX_ROUNDS rounds, which the rule does not allow." >&2
  exit 2
fi
exit "$STATUS"
