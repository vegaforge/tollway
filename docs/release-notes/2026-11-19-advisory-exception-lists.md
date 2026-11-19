---
date: 2026-11-19
feature: keep the two dependency-scan exception lists in step
scope: chore
packages: []
scenario-impact: none
---

# Keep the two dependency-scan exception lists in step

The `dependencies` security job runs two scanners, each with its own list of
allowed advisories: OSV-Scanner reads `.github/security/osv-scanner.toml`, and
GitHub's dependency review takes `allow-ghsas` in `pr-security.yml`. The
minimatch exception for TypeDoc (GHSA-g3hv-75wg-m249) went into the first list
only, so the job still failed.

The advisory is now in both lists, and `scripts/security/test_advisory_exceptions.py`
fails whenever the two differ, so a future exception cannot be half-added.
The TOML stays the place for each entry's reason and expiry.
