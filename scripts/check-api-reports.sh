#!/usr/bin/env bash
#
# Runs API Extractor across every publishable package and fails if the
# generated report differs from the committed one.
#
# Usage:
#   scripts/check-api-reports.sh           check mode (fails on diff)
#   scripts/check-api-reports.sh --update  update mode (overwrites reports)
#
# See docs/contributing.md, "Public API reports".

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

UPDATE=false
for arg in "$@"; do
  case "$arg" in
    --update) UPDATE=true ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--update]" >&2
      exit 2
      ;;
  esac
done

PUBLISHABLE=(
  packages/adapter-express
  packages/adapter-fastify
  packages/adapter-hono
  packages/adapter-next
  packages/channels
  packages/client
  packages/core
  packages/observability
  packages/reconcile
  packages/server
  packages/theme
)

FAILED=0

for pkg in "${PUBLISHABLE[@]}"; do
  if [ ! -f "$pkg/api-extractor.json" ]; then
    echo "✗ $pkg: missing api-extractor.json" >&2
    FAILED=1
    continue
  fi

  echo "→ Running API Extractor for $pkg..."

  if [ "$UPDATE" = "true" ]; then
    # Update mode: generate and accept the report.
    pnpm exec api-extractor run --local --verbose --config "$pkg/api-extractor.json" || true
  else
    # Check mode: fail if the report would change.
    if ! pnpm exec api-extractor run --config "$pkg/api-extractor.json" 2>&1; then
      echo "✗ $pkg: API Extractor check failed (the API changed; run scripts/check-api-reports.sh --update)" >&2
      FAILED=1
    else
      echo "✓ $pkg"
    fi
  fi
done

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi

echo ""
echo "All API Extractor checks passed."
