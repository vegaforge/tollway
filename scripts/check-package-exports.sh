#!/usr/bin/env bash
#
# Checks every publishable package's tarball with publint and
# arethetypeswrong. Run after `pnpm build`.
#
# Usage:
#   scripts/check-package-exports.sh
#
# See CONTRIBUTING.md, "Public API reports".

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

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
  packages/service
  packages/theme
)

TMPDIR_ROOT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

FAILED=0

for pkg in "${PUBLISHABLE[@]}"; do
  name=$(node -e "process.stdout.write(require('./${pkg}/package.json').name)")
  echo "→ Checking $name ($pkg)..."

  # Pack to a tarball.
  TARBALL=$(pnpm --filter "$name" pack --pack-destination "$TMPDIR_ROOT" 2>/dev/null | tail -1)
  if [ -z "$TARBALL" ]; then
    # pnpm pack output format varies; fall back to listing the temp dir.
    TARBALL=$(ls "$TMPDIR_ROOT"/*.tgz 2>/dev/null | tail -1)
  fi

  if [ -z "$TARBALL" ]; then
    echo "  ✗ Could not find tarball for $name" >&2
    FAILED=1
    continue
  fi

  # publint
  if ! node_modules/.bin/publint "$TARBALL"; then
    echo "  ✗ publint failed for $name" >&2
    FAILED=1
  else
    echo "  ✓ publint"
  fi

  # arethetypeswrong checks every subpath in the export map by default. The
  # only exclusions are files that carry no types by design: the theme's CSS
  # tokens and core's JSON Schema. publint above still checks they exist.
  EXCLUDE_ARGS=()
  case "$name" in
    "@vegaforge/tollway-theme") EXCLUDE_ARGS=(--exclude-entrypoints ./tokens.css) ;;
    "@vegaforge/tollway-core") EXCLUDE_ARGS=(--exclude-entrypoints ./schema/policy.schema.json) ;;
  esac

  # The tarball is the input; --pack would pack a directory instead.
  if ! node_modules/.bin/attw "$TARBALL" --profile node16 ${EXCLUDE_ARGS[@]+"${EXCLUDE_ARGS[@]}"}; then
    echo "  ✗ arethetypeswrong failed for $name" >&2
    FAILED=1
  else
    echo "  ✓ arethetypeswrong"
  fi

  # Clean up this package's tarball for the next run.
  rm -f "$TARBALL"
done

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "✗ One or more packages failed the export checks."
  exit 1
fi

echo ""
echo "All package export checks passed."
