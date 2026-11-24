#!/usr/bin/env bash
#
# Installs every publishable package from its packed tarball into a fresh
# project, then loads each entry point the way a consumer would:
#
#   1. type-checks an ESM file (.mts) and a CommonJS file (.cts) that import
#      every entry point, under `module` and `moduleResolution` node16;
#   2. imports every entry point from ESM and requires it from CommonJS at
#      runtime.
#
# This catches export maps that resolve in the monorepo but not once
# published. Run after `pnpm build`. It installs third-party dependencies
# from the npm registry, with lifecycle scripts disabled.
#
# Usage:
#   scripts/check-package-consumers.sh
#
# See CONTRIBUTING.md, "Public API reports".

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
ROOT=$(pwd)

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

# Every entry point that carries code and types. The theme's CSS tokens and
# core's JSON Schema are files, not modules, and publint checks them.
ENTRY_POINTS=(
  @vegaforge/tollway-adapter-express
  @vegaforge/tollway-adapter-fastify
  @vegaforge/tollway-adapter-hono
  @vegaforge/tollway-adapter-next
  @vegaforge/tollway-adapter-next/proxy
  @vegaforge/tollway-channels
  @vegaforge/tollway-client
  @vegaforge/tollway-client/sqlite
  @vegaforge/tollway-core
  @vegaforge/tollway-core/policy-loader
  @vegaforge/tollway-observability
  @vegaforge/tollway-observability/sqlite
  @vegaforge/tollway-reconcile
  @vegaforge/tollway-server
  @vegaforge/tollway-service
  @vegaforge/tollway-theme
  @vegaforge/tollway-theme/preset
)

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/tarballs" "$WORK/project"

echo "→ Packing ${#PUBLISHABLE[@]} packages..."
for pkg in "${PUBLISHABLE[@]}"; do
  (cd "$pkg" && pnpm pack --pack-destination "$WORK/tarballs" >/dev/null)
done

cd "$WORK/project"
cat > package.json <<'JSON'
{ "name": "tollway-consumer-check", "private": true, "version": "0.0.0" }
JSON

# The adapters' frameworks are peer dependencies (Next's is optional, so npm
# does not install it on its own). Install the versions each adapter is
# tested against, as a consumer would.
# Prints the version spec a workspace manifest pins for a dependency, and
# fails when there is none, so a typo never installs whatever is latest.
pinned() {
  local manifest=$1 field=$2 dependency=$3 spec
  spec=$(node -p "require('$manifest').$field?.['$dependency'] ?? ''")
  if [ -z "$spec" ]; then
    echo "✗ $manifest does not pin $dependency in $field" >&2
    exit 1
  fi
  echo "$spec"
}

PEERS=()
for framework in express fastify hono next; do
  spec=$(pinned "$ROOT/packages/adapter-$framework/package.json" devDependencies "$framework")
  PEERS+=("$framework@$spec")
done
TYPESCRIPT=$(pinned "$ROOT/package.json" devDependencies typescript)
TYPES_NODE=$(pinned "$ROOT/packages/core/package.json" devDependencies @types/node)

echo "→ Installing the tarballs into a fresh project..."
# The packages depend on each other at the same version, so installing every
# tarball together resolves those links locally instead of from the registry.
npm install --ignore-scripts --no-audit --no-fund --loglevel=error \
  "$WORK"/tarballs/*.tgz \
  "${PEERS[@]}" \
  "typescript@$TYPESCRIPT" \
  "@types/node@$TYPES_NODE"

: > consumer.mts
: > consumer.cts
i=0
for entry in "${ENTRY_POINTS[@]}"; do
  echo "import * as entry$i from \"$entry\";" >> consumer.mts
  echo "import entry$i = require(\"$entry\");" >> consumer.cts
  i=$((i + 1))
done
{
  echo "const loaded: unknown[] = ["
  for ((j = 0; j < i; j++)); do echo "  entry$j,"; done
  echo "];"
  echo "if (loaded.some((module) => module === undefined)) throw new Error(\"an entry point loaded as undefined\");"
} | tee -a consumer.mts >> consumer.cts

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "module": "node16",
    "moduleResolution": "node16",
    "target": "ES2022",
    "strict": true,
    "types": ["node"],
    "outDir": "out",
    "skipLibCheck": true
  },
  "files": ["consumer.mts", "consumer.cts"]
}
JSON

echo "→ Type-checking ESM and CommonJS consumers under node16..."
node_modules/.bin/tsc -p tsconfig.json

echo "→ Loading every entry point from ESM and from CommonJS..."
node out/consumer.mjs
node out/consumer.cjs

echo ""
echo "All ${#ENTRY_POINTS[@]} entry points type-check and load from ESM and CommonJS."
