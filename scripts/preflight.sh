#!/usr/bin/env bash
#
# Runs the five gates a change must pass before it is pushed or reviewed:
# format, lint, typecheck, tests, production build. CI runs the same commands.
#
# Usage:
#   ./scripts/preflight.sh          all five gates
#   ./scripts/preflight.sh --fast   skips the build (the pre-push hook uses this)

set -euo pipefail

# Git hooks run with a minimal PATH. Load nvm or mise if present so the
# pinned Node and pnpm are found.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi
if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate bash --shims)"
fi

cd "$(git rev-parse --show-toplevel)"

BLUE='\033[0;34m'
GREEN='\033[0;32m'
NC='\033[0m'

SKIP_BUILD="${SKIP_BUILD:-false}"
for arg in "$@"; do
  case "$arg" in
    --fast) SKIP_BUILD="true" ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--fast]" >&2
      exit 2
      ;;
  esac
done

echo -e "${BLUE}=== Tollway preflight ===${NC}"

echo -e "\n${BLUE}[1/5] Format check (biome format)${NC}"
pnpm format:check

echo -e "\n${BLUE}[2/5] Lint (biome check, warnings fail; knip)${NC}"
pnpm lint
# Knip fails on dependencies nothing imports and imports nothing declares.
pnpm knip

echo -e "\n${BLUE}[3/5] Typecheck${NC}"
pnpm typecheck

echo -e "\n${BLUE}[4/5] Tests${NC}"
pnpm test
# The PR security checks have their own tests (standard library only).
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/security -q

if [ "$SKIP_BUILD" = "true" ]; then
  echo -e "\n${BLUE}[5/5] Build skipped (--fast). CI runs it on every pull request.${NC}"
else
  echo -e "\n${BLUE}[5/5] Production build${NC}"
  pnpm build
fi

echo -e "\n${GREEN}All preflight gates passed.${NC}"
