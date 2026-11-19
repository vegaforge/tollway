"""The two dependency scanners in pr-security.yml must allow the same advisories.

The `dependencies` job runs OSV-Scanner, which reads its exceptions (each with
a reason and an expiry) from .github/security/osv-scanner.toml, and then
GitHub's dependency review, which takes its own `allow-ghsas` list in the
workflow. An exception added to one list but not the other still fails the
job, as happened with GHSA-g3hv-75wg-m249 on #282. This test keeps them equal.

Run with: python3 -m unittest discover -s scripts/security
"""

from __future__ import annotations

import os
import re
import tomllib
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OSV_CONFIG = os.path.join(ROOT, ".github", "security", "osv-scanner.toml")
WORKFLOW = os.path.join(ROOT, ".github", "workflows", "pr-security.yml")
GHSA = re.compile(r"GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}")


def osv_ignored() -> set[str]:
    with open(OSV_CONFIG, "rb") as f:
        return {entry["id"] for entry in tomllib.load(f).get("IgnoredVulns", [])}


def review_allowed() -> set[str]:
    """The advisories in the workflow's `allow-ghsas:` value, inline or folded."""
    with open(WORKFLOW, encoding="utf-8") as f:
        lines = f.read().splitlines()
    for index, line in enumerate(lines):
        match = re.match(r"^(\s*)allow-ghsas:(.*)$", line)
        if not match:
            continue
        indent = len(match.group(1))
        value = [match.group(2)]
        for following in lines[index + 1 :]:
            stripped = following.strip()
            if stripped and len(following) - len(following.lstrip()) <= indent:
                break
            if not stripped.startswith("#"):
                value.append(following)
        return set(GHSA.findall(" ".join(value)))
    raise AssertionError(f"no allow-ghsas input in {WORKFLOW}")


class AdvisoryExceptionsTest(unittest.TestCase):
    def test_both_scanners_allow_the_same_advisories(self) -> None:
        osv = osv_ignored()
        review = review_allowed()
        self.assertTrue(osv, "osv-scanner.toml lists no exceptions; the parser is probably wrong")
        self.assertEqual(
            sorted(osv - review),
            [],
            "In osv-scanner.toml but not in pr-security.yml allow-ghsas: add them there too.",
        )
        self.assertEqual(
            sorted(review - osv),
            [],
            "In pr-security.yml allow-ghsas but not in osv-scanner.toml: add them there, with a reason and an expiry.",
        )


if __name__ == "__main__":
    unittest.main()
