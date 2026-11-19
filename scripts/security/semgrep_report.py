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


# Semgrep's TypeScript parser lags the language, so valid code can fail to
# parse. The fix is always on the contributor's side, so say what usually helps.
REWRITE_HINT = (
    "If the code is valid TypeScript, rewrite that line in a simpler form Semgrep can read: "
    'for example, replace an inline `typeof import("pkg")` type with a top-level `import type * as Pkg from "pkg"` '
    "and use `typeof Pkg`."
)


def rejected_code(message: str) -> str:
    """The part of Semgrep's parse message that names what it rejected, if any."""
    for line in message.splitlines():
        if "was unexpected" in line:
            return f": {line.strip()}"
    return ""


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
        span = (e.get("spans") or [{}])[0]
        path = e.get("path") or span.get("file") or "?"
        line = (span.get("start") or {}).get("line")
        kind = e.get("type")
        kind = kind[0] if isinstance(kind, list) else kind
        detail = rejected_code(e.get("message") or "")
        where = f"file={path}" + (f",line={line}" if line else "")
        message = f"Semgrep could not analyse this file ({kind}){detail}. Files the scanner cannot read are not accepted."
        if kind == "PartialParsing":
            message += f" {REWRITE_HINT}"
        print(f"::error {where},title=security/semgrep-error::{message}")
        lines.append(f"- `{path}{':' + str(line) if line else ''}` could not be analysed: {kind}{detail}")

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
