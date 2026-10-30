#!/usr/bin/env bash
#
# Release-note gate. If a change touches package or app source, the same diff
# must add or edit a file under docs/release-notes/.
#
# Locally it only warns. CI sets STRICT_RELEASE_NOTES=true, which makes a
# missing release note fail the build.
#
# A release note is the human summary of a change. It does not replace a
# changeset: a change to a publishable package under packages/ needs both.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

BASE="${RELEASE_NOTES_BASE:-origin/main}"

# Source that ships: every package's src/ and every app's src/. Manifests and
# the lockfile are excluded so dependency-only updates do not need a note.
APP_PATHS='^(packages/[^/]+/src/|apps/[^/]+/src/)'

# Make sure the base ref exists. In CI the checkout uses fetch-depth 0, so this
# is a no-op there. A failure here is reported, not hidden: without the base
# the diff below cannot be computed.
if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  echo "Fetching ${BASE#origin/} to compare against."
  git fetch origin "${BASE#origin/}"
fi

# Prints each line of $1 as an indented list item.
print_list() {
  while IFS= read -r line; do
    echo "  - $line"
  done <<<"$1"
}

CHANGED=$(git diff --name-only "$BASE...HEAD")
CHANGED_APP_FILES=$(grep -E "$APP_PATHS" <<<"$CHANGED" || true)
RELEASE_NOTES=$(grep -E '^docs/release-notes/.+\.md$' <<<"$CHANGED" | grep -v '/TEMPLATE\.md$' || true)

if [ -z "$CHANGED_APP_FILES" ]; then
  echo -e "${GREEN}No package or app source changed. A release note is not required.${NC}"
  exit 0
fi

if [ -z "$RELEASE_NOTES" ]; then
  echo -e "${YELLOW}Package or app source changed, but no release note was added under docs/release-notes/:${NC}"
  print_list "$CHANGED_APP_FILES"
  echo -e "${YELLOW}Add docs/release-notes/<YYYY-MM-DD>-<topic>.md (copy docs/release-notes/TEMPLATE.md).${NC}"
  if [ "${STRICT_RELEASE_NOTES:-false}" = "true" ]; then
    echo -e "${RED}Release-note gate failed (strict mode).${NC}"
    exit 1
  fi
  exit 0
fi

echo -e "${GREEN}Release note found:${NC}"
print_list "$RELEASE_NOTES"
