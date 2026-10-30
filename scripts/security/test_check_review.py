"""Tests for check_review.decide, with a fake GitHub API.

Run with: python3 -m unittest discover -s scripts/security
"""

from __future__ import annotations

import os
import sys
import unittest
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_review import PullRequest, decide  # noqa: E402

GLOBS = [".github/**", "scripts/**", "package.json", "pnpm-lock.yaml", "build.rs", "*.config.ts"]
HEAD = "a" * 40
OLD = "b" * 40
ROLES = {"Signor1": "admin", "helper": "write", "maint": "maintain"}


def fake_api(reviews: list[dict]):
    def api(path: str) -> object:
        if path.endswith("/reviews"):
            return reviews
        user = path.split("/collaborators/")[1].split("/")[0]
        if user not in ROLES:
            raise urllib.error.HTTPError(path, 404, "Not Found", {}, None)  # type: ignore[arg-type]
        return {"role_name": ROLES[user]}
    return api


def review(user: str, state: str, commit: str = HEAD) -> dict:
    return {"user": {"login": user}, "state": state, "commit_id": commit}


def pr(author: str = "stranger", association: str = "CONTRIBUTOR", author_type: str = "User") -> PullRequest:
    return PullRequest(number="7", head_sha=HEAD, author=author, author_type=author_type, association=association)


class DecideTest(unittest.TestCase):
    def run_decide(self, touched: list[str], reviews: list[dict], who: PullRequest | None = None) -> bool:
        passed, _ = decide(who or pr(), touched, GLOBS, fake_api(reviews), "vegaforge/x")
        return passed

    def test_no_sensitive_paths_passes_without_review(self) -> None:
        self.assertTrue(self.run_decide(["src/index.ts", "docs/a.md"], []))

    def test_sensitive_change_without_review_fails(self) -> None:
        self.assertFalse(self.run_decide(["src/a.ts", "package.json"], []))

    def test_nested_package_json_is_sensitive(self) -> None:
        self.assertFalse(self.run_decide(["packages/core/package.json"], []))

    def test_config_file_is_sensitive(self) -> None:
        self.assertFalse(self.run_decide(["apps/web/next.config.ts"], []))

    def test_maintainer_approval_on_head_passes(self) -> None:
        self.assertTrue(self.run_decide([".github/workflows/ci.yml"], [review("Signor1", "APPROVED")]))

    def test_maintain_role_counts(self) -> None:
        self.assertTrue(self.run_decide(["scripts/x.sh"], [review("maint", "APPROVED")]))

    def test_approval_on_older_commit_fails(self) -> None:
        self.assertFalse(self.run_decide(["scripts/x.sh"], [review("Signor1", "APPROVED", OLD)]))

    def test_approval_from_write_collaborator_fails(self) -> None:
        self.assertFalse(self.run_decide(["scripts/x.sh"], [review("helper", "APPROVED")]))

    def test_approval_from_non_collaborator_fails(self) -> None:
        self.assertFalse(self.run_decide(["scripts/x.sh"], [review("randomuser", "APPROVED")]))

    def test_later_changes_requested_overrides_approval(self) -> None:
        reviews = [review("Signor1", "APPROVED"), review("Signor1", "CHANGES_REQUESTED")]
        self.assertFalse(self.run_decide(["scripts/x.sh"], reviews))

    def test_dismissed_approval_fails(self) -> None:
        reviews = [review("Signor1", "APPROVED"), review("Signor1", "DISMISSED")]
        self.assertFalse(self.run_decide(["scripts/x.sh"], reviews))

    def test_comment_after_approval_keeps_approval(self) -> None:
        reviews = [review("Signor1", "APPROVED"), review("Signor1", "COMMENTED")]
        self.assertTrue(self.run_decide(["scripts/x.sh"], reviews))

    def test_author_cannot_approve_their_own_change(self) -> None:
        self.assertFalse(self.run_decide(["scripts/x.sh"], [review("maint", "APPROVED")], pr(author="maint", association="COLLABORATOR")))

    def test_org_member_is_exempt(self) -> None:
        self.assertTrue(self.run_decide([".github/workflows/ci.yml"], [], pr(author="Signor1", association="MEMBER")))

    def test_outside_collaborator_is_not_exempt(self) -> None:
        self.assertFalse(self.run_decide([".github/workflows/ci.yml"], [], pr(author="AbelOsaretin", association="COLLABORATOR")))

    def test_dependabot_lockfile_only_is_exempt(self) -> None:
        bot = pr(author="dependabot[bot]", association="NONE", author_type="Bot")
        self.assertTrue(self.run_decide(["package.json", "pnpm-lock.yaml"], [], bot))

    def test_dependabot_workflow_change_needs_review(self) -> None:
        bot = pr(author="dependabot[bot]", association="NONE", author_type="Bot")
        self.assertFalse(self.run_decide([".github/workflows/ci.yml"], [], bot))

    def test_user_named_like_dependabot_is_not_exempt(self) -> None:
        fake = pr(author="dependabot[bot]", association="NONE", author_type="User")
        self.assertFalse(self.run_decide(["package.json"], [], fake))


if __name__ == "__main__":
    unittest.main()
