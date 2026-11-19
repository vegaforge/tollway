"""Tests for semgrep_report.py. Run with: python3 -m unittest discover -s scripts/security"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import semgrep_report  # noqa: E402

# The shape Semgrep 1.181 reports for a file it cannot fully parse (taken from
# the run on #276: `importOriginal<typeof import("...")>()` in a test file).
PARTIAL_PARSING = {
    "type": ["PartialParsing", [{"path": "src/a.test.ts", "start": {"line": 32, "col": 82}, "end": {"line": 32, "col": 85}}]],
    "message": "Syntax error at line src/a.test.ts:32:\n `>()` was unexpected",
    "spans": [{"file": "src/a.test.ts", "start": {"line": 32, "col": 82}, "end": {"line": 32, "col": 85}}],
}


def run(report: dict) -> tuple[int, str]:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(report, f)
    out = io.StringIO()
    saved = os.environ.pop("GITHUB_STEP_SUMMARY", None)
    try:
        with contextlib.redirect_stdout(out):
            code = semgrep_report.main(["semgrep_report.py", f.name])
    finally:
        os.unlink(f.name)
        if saved is not None:
            os.environ["GITHUB_STEP_SUMMARY"] = saved
    return code, out.getvalue()


class SemgrepReportTest(unittest.TestCase):
    def test_clean_report_passes(self) -> None:
        code, out = run({"results": [], "errors": [], "paths": {"scanned": ["a.ts"]}})
        self.assertEqual(code, 0)
        self.assertIn("No findings in 1 changed files.", out)

    def test_parse_error_still_fails(self) -> None:
        code, _ = run({"results": [], "errors": [PARTIAL_PARSING]})
        self.assertEqual(code, 1)

    def test_parse_error_names_the_line_and_what_the_parser_rejected(self) -> None:
        _, out = run({"results": [], "errors": [PARTIAL_PARSING]})
        self.assertIn("file=src/a.test.ts,line=32", out)
        self.assertIn("`>()` was unexpected", out)

    def test_parse_error_tells_the_contributor_how_to_fix_it(self) -> None:
        _, out = run({"results": [], "errors": [PARTIAL_PARSING]})
        self.assertIn("rewrite", out)
        self.assertIn("import type", out)


if __name__ == "__main__":
    unittest.main()
