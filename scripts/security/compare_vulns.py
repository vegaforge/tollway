#!/usr/bin/env python3
"""Compare dependency scan results between the base branch and a pull request.

The pull request fails when:
  * any dependency in it matches a malicious-package advisory (OSV IDs that
    start with MAL-), whether or not the base branch already had it, or
  * it introduces a known vulnerability that the base branch does not have.

Vulnerabilities already on the base branch are listed but do not fail the run,
so an old advisory does not block unrelated pull requests. Dependabot and the
security tab track those.

Usage:
  compare_vulns.py osv BASE.json HEAD.json
  compare_vulns.py govulncheck BASE.json HEAD.json

`osv` reads `osv-scanner scan source --format json` output. `govulncheck`
reads `govulncheck -format json` output and counts only vulnerabilities whose
vulnerable code is actually called.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Iterable

Finding = tuple[str, str, str]  # (advisory id, ecosystem/package, version)


def load_osv(path: str) -> set[Finding]:
    """Advisories per package from an osv-scanner JSON report."""
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return set()
    with open(path, encoding="utf-8") as f:
        report = json.load(f)
    found: set[Finding] = set()
    for result in report.get("results") or []:
        for pkg in result.get("packages") or []:
            info = pkg.get("package") or {}
            name = f"{info.get('ecosystem', '?')}/{info.get('name', '?')}"
            version = info.get("version", "")
            for vuln in pkg.get("vulnerabilities") or []:
                found.add((vuln["id"], name, version))
    return found


def load_govulncheck(path: str) -> set[Finding]:
    """Called vulnerabilities from a govulncheck JSON stream."""
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return set()
    with open(path, encoding="utf-8") as f:
        text = f.read()
    decoder = json.JSONDecoder()
    found: set[Finding] = set()
    idx = 0
    while idx < len(text):
        while idx < len(text) and text[idx].isspace():
            idx += 1
        if idx >= len(text):
            break
        message, idx = decoder.raw_decode(text, idx)
        finding = message.get("finding")
        if not finding:
            continue
        trace = finding.get("trace") or []
        # A trace whose first frame names a function means our code calls it.
        if trace and trace[0].get("function"):
            frame = trace[0]
            found.add((finding["osv"], f"Go/{frame.get('module', '?')}", frame.get("version", "")))
    return found


def report(lines: Iterable[str]) -> None:
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    text = "\n".join(lines) + "\n"
    print(text)
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(text)


def main(argv: list[str]) -> int:
    if len(argv) != 4 or argv[1] not in ("osv", "govulncheck"):
        print(__doc__, file=sys.stderr)
        return 2
    load = load_osv if argv[1] == "osv" else load_govulncheck
    base, head = load(argv[2]), load(argv[3])

    # A vulnerability counts as new when the base branch did not have that
    # advisory for that package at all. Moving a package to another affected
    # version (a partial Dependabot bump, say) is not new.
    base_keys = {(advisory, pkg) for advisory, pkg, _version in base}
    malicious = sorted(f for f in head if f[0].startswith("MAL-"))
    new = sorted(f for f in head if not f[0].startswith("MAL-") and (f[0], f[1]) not in base_keys)
    existing = sorted(f for f in head if not f[0].startswith("MAL-") and (f[0], f[1]) in base_keys)

    lines = [f"## Dependency scan ({argv[1]})", ""]
    for advisory, pkg, version in malicious:
        lines.append(f"::error title=security/malicious-package::{pkg}@{version} is a known malicious package ({advisory}). Remove it.")
    for advisory, pkg, version in new:
        lines.append(f"::error title=security/new-vulnerability::{pkg}@{version} adds {advisory}. Use a patched version.")
    if existing:
        lines.append(f"{len(existing)} advisories are already on the base branch and do not block this pull request:")
        lines += [f"- {advisory} in {pkg}@{version}" for advisory, pkg, version in existing]
    if not (malicious or new):
        lines.append("No malicious packages and no new vulnerabilities.")
    report(lines)
    return 1 if malicious or new else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
