#!/usr/bin/env bash
# Approve a contributor's pull request, refresh its security check, and let
# GitHub merge it once every required check is green.
#
# Usage: scripts/approve-and-merge.sh <pr-number> [owner/repo]
#
# Run it only after reading the diff, including every file the `maintainer
# review` check lists. It never bypasses a check: it approves the current head
# commit, re-runs the security run whose only failure was the missing
# approval, and turns on auto-merge, which waits for `quality` and `security`.
#
# Why the re-run: the security run that started when the commit was pushed
# failed `maintainer review` because nobody had approved yet. Approving starts
# a new run, but the earlier failure stays on the same commit and keeps the
# pull request blocked until that run is re-run.

set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: $0 <pr-number> [owner/repo]" >&2
  exit 2
fi
pr="$1"
repo="${2:-vegaforge/tollway}"

head=$(gh pr view "$pr" -R "$repo" --json headRefOid --jq .headRefOid)
echo "Approving #$pr at ${head:0:12}"
gh pr review "$pr" -R "$repo" --approve

# The newest push-event security run for this exact commit, if it failed.
failed_run=$(gh run list -R "$repo" --workflow "PR security" --event pull_request \
  --commit "$head" --limit 1 --json databaseId,conclusion \
  --jq '.[] | select(.conclusion == "failure") | .databaseId')
if [ -n "$failed_run" ]; then
  echo "Re-running the failed jobs of security run $failed_run now that it is approved"
  gh run rerun "$failed_run" -R "$repo" --failed
fi

gh pr merge "$pr" -R "$repo" --squash --delete-branch --auto
echo "Auto-merge is on: #$pr merges by itself once quality and security are green."
