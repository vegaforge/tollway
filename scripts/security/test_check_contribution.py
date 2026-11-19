"""Tests for check_contribution.decide, with a fake GitHub API.

Run with: python3 -m unittest discover -s scripts/security
"""

from __future__ import annotations

import os
import sys
import unittest
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_contribution import AdrChange, Contribution, closed_issues, decide  # noqa: E402

ROLES = {"Signor1": "admin", "maint": "maintain", "helper": "write"}
ISSUES = {
    "21": {"number": 21, "assignees": [{"login": "alice"}]},
    "22": {"number": 22, "assignees": []},
    "23": {"number": 23, "assignees": [{"login": "bob"}, {"login": "alice"}]},
    "30": {"number": 30, "assignees": [{"login": "alice"}], "pull_request": {"url": "x"}},
}

PROPOSED = "# ADR: X\n\n- **Status:** Proposed, awaiting maintainer approval\n"
ACCEPTED = "# ADR: X\n\n- **Status:** Accepted 2026-11-19\n"


def fake_api(path: str) -> object:
    if "/collaborators/" in path:
        user = path.split("/collaborators/")[1].split("/")[0]
        if user not in ROLES:
            raise urllib.error.HTTPError(path, 404, "Not Found", {}, None)  # type: ignore[arg-type]
        return {"role_name": ROLES[user]}
    number = path.rsplit("/", 1)[1]
    if number not in ISSUES:
        raise urllib.error.HTTPError(path, 404, "Not Found", {}, None)  # type: ignore[arg-type]
    return ISSUES[number]


def contribution(body: str, author: str = "alice", association: str = "CONTRIBUTOR", author_type: str = "User") -> Contribution:
    return Contribution(author=author, author_type=author_type, association=association, body=body)


def run(body: str, adrs: list[AdrChange] | None = None, **kwargs: str) -> tuple[bool, list[str]]:
    return decide(contribution(body, **kwargs), adrs or [], fake_api, "vegaforge/tollway")


class ClosedIssuesTest(unittest.TestCase):
    def test_reads_every_closing_keyword_and_form(self) -> None:
        body = "Closes #21. fixes #22, Resolved: #23\nalso resolves vegaforge/tollway#24\nCloses https://github.com/vegaforge/tollway/issues/25"
        self.assertEqual(closed_issues(body, "vegaforge/tollway"), {21, 22, 23, 24, 25})

    def test_a_url_without_a_closing_keyword_is_only_a_mention(self) -> None:
        self.assertEqual(closed_issues("See https://github.com/vegaforge/tollway/issues/25", "vegaforge/tollway"), set())

    def test_ignores_mentions_and_other_repositories(self) -> None:
        body = "Related to #21, see #22. Closes other/repo#9. Closes #<issue>"
        self.assertEqual(closed_issues(body, "vegaforge/tollway"), set())

    def test_ignores_html_comments(self) -> None:
        self.assertEqual(closed_issues("<!-- Closes #21 -->\nCloses #22", "vegaforge/tollway"), {22})


class DecideTest(unittest.TestCase):
    # -- passing cases --------------------------------------------------------

    def test_assigned_contributor_closing_one_issue_passes(self) -> None:
        passed, lines = run("Adds the thing.\n\nCloses #21")
        self.assertTrue(passed, lines)

    def test_one_of_several_assignees_passes(self) -> None:
        self.assertTrue(run("Closes #23")[0])

    def test_maintainers_and_members_are_exempt(self) -> None:
        self.assertTrue(run("no issue", author="Signor1")[0])
        self.assertTrue(run("no issue", author="maint")[0])
        self.assertTrue(run("no issue", author="someone", association="MEMBER")[0])

    def test_dependabot_is_exempt(self) -> None:
        self.assertTrue(run("Bumps x", author="dependabot[bot]", author_type="Bot")[0])

    def test_proposed_adr_from_contributor_passes(self) -> None:
        adrs = [AdrChange("docs/adr/ADR-2026-11-19-x.md", None, PROPOSED)]
        self.assertTrue(run("Closes #21", adrs)[0])

    def test_unchanged_accepted_status_passes(self) -> None:
        adrs = [AdrChange("docs/adr/ADR-2026-11-19-x.md", ACCEPTED, ACCEPTED + "\nTypo fix.\n")]
        self.assertTrue(run("Closes #21", adrs)[0])

    # -- failing cases --------------------------------------------------------

    def test_no_issue_fails(self) -> None:
        passed, lines = run("Adds the thing.")
        self.assertFalse(passed)
        self.assertIn("does not close an issue", lines[-1])

    def test_several_issues_fail(self) -> None:
        passed, lines = run("Closes #21\nCloses #23")
        self.assertFalse(passed)
        self.assertIn("one pull request per issue", lines[-1])

    def test_unassigned_issue_fails(self) -> None:
        passed, lines = run("Closes #22")
        self.assertFalse(passed)
        self.assertIn("not assigned", lines[-1])

    def test_issue_assigned_to_someone_else_fails(self) -> None:
        self.assertFalse(run("Closes #21", author="mallory")[0])

    def test_closing_a_pull_request_or_missing_issue_fails(self) -> None:
        self.assertFalse(run("Closes #30")[0])
        self.assertFalse(run("Closes #99")[0])

    def test_write_role_is_not_exempt(self) -> None:
        self.assertFalse(run("no issue", author="helper")[0])

    def test_new_accepted_adr_from_contributor_fails(self) -> None:
        adrs = [AdrChange("docs/adr/ADR-2026-11-19-x.md", None, ACCEPTED)]
        passed, lines = run("Closes #21", adrs)
        self.assertFalse(passed)
        self.assertIn("Accepted", lines[-1])

    def test_contributor_flipping_an_adr_to_accepted_fails(self) -> None:
        adrs = [AdrChange("docs/adr/ADR-2026-11-19-x-for-dummies.md", PROPOSED, ACCEPTED)]
        self.assertFalse(run("Closes #21", adrs)[0])

    def test_every_problem_is_reported_at_once(self) -> None:
        adrs = [AdrChange("docs/adr/ADR-2026-11-19-x.md", None, ACCEPTED)]
        passed, lines = run("Closes #21\nCloses #22", adrs)
        self.assertFalse(passed)
        text = "\n".join(lines)
        self.assertIn("one pull request per issue", text)
        self.assertIn("Accepted", text)


if __name__ == "__main__":
    unittest.main()
