#!/usr/bin/env python3
"""Turn a Semgrep JSON report into annotations and a pass or fail.

The run fails on any finding, and also on any Semgrep error (a timeout, a
parse failure, running out of memory). Semgrep reports those as errors rather
than findings, so treating them as a pass would let a padded or deliberately
malformed file skip the scan.

Usage: semgrep_report.py REPORT.json
"""

from __future__ import annotations

import json
import os
import sys


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    with open(argv[1], encoding="utf-8") as f:
        report = json.load(f)

    lines = ["## Malicious patterns", ""]
    results = report.get("results") or []
    errors = report.get("errors") or []
    for r in results:
        rule = r["check_id"].rsplit(".", 1)[-1]
        msg = " ".join(r["extra"]["message"].split())
        print(f"::error file={r['path']},line={r['start']['line']},title=security/{rule}::{msg}")
        lines.append(f"- `{r['path']}:{r['start']['line']}` {rule}")
    for e in errors:
        path = e.get("path") or ((e.get("spans") or [{}])[0].get("file")) or "?"
        kind = e.get("type")
        kind = kind[0] if isinstance(kind, list) else kind
        print(f"::error file={path},title=security/semgrep-error::Semgrep could not analyse this file ({kind}). Files the scanner cannot read are not accepted.")
        lines.append(f"- `{path}` could not be analysed: {kind}")

    scanned = len((report.get("paths") or {}).get("scanned") or [])
    if not results and not errors:
        lines.append(f"No findings in {scanned} changed files.")
    text = "\n".join(lines) + "\n"
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(text)
    return 1 if results or errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
