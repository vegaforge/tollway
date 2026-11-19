#!/usr/bin/env python3
"""Check that a contributor's pull request has the shape the project accepts.

A pull request from someone who is not a maintainer passes only when:

  * its description closes between one and four issues in this repository
    ("Closes #12", "Fixes #12", "Resolves owner/repo#12" or the issue URL);
  * the author is assigned to every one of them; and
  * it does not mark any ADR in docs/adr/ as Accepted. Only the maintainer
    accepts a design (ADR-2026-11-19-open-source-governance).

Organization owners and members, users with the admin or maintain role, and
Dependabot are exempt. Every problem is reported at once, in plain words, so a
contributor can fix them in one push.

Usage (the workflow sets the environment from the event payload):
  check_contribution.py --repo DIR --base REV --head REV

Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, PR_AUTHOR,
PR_AUTHOR_TYPE, PR_AUTHOR_ASSOCIATION, PR_BODY.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import urllib.error
from dataclasses import dataclass
from pathlib import PurePosixPath

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from check_review import DEPENDABOT, MAINTAINER_ROLES, TRUSTED_ASSOCIATIONS, Api, github_api  # noqa: E402
from scan_diff import git_env  # noqa: E402

CLOSING = r"(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)"
ACCEPTED = re.compile(r"^\s*-\s*\*\*Status:\*\*\s*Accepted\b", re.I | re.M)
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
# A contributor may work on up to four assigned issues at once and close them
# in one pull request (maintainer decision, 2026-11-19).
MAX_ISSUES = 4


@dataclass(frozen=True)
class Contribution:
    author: str
    author_type: str
    association: str
    body: str


@dataclass(frozen=True)
class AdrChange:
    path: str
    base_text: str | None
    head_text: str


def closed_issues(body: str, repo_slug: str) -> set[int]:
    """Issue numbers in this repository that the description says it closes."""
    text = HTML_COMMENT.sub("", body)
    slug = re.escape(repo_slug)
    target = rf"(?:#|{slug}#|https://github\.com/{slug}/issues/)(\d+)\b"
    return {int(n) for n in re.findall(rf"\b{CLOSING}\b:?\s+{target}", text, re.I)}


def decide(pr: Contribution, adrs: list[AdrChange], api: Api, repo_slug: str) -> tuple[bool, list[str]]:
    """Return (passed, explanation lines)."""
    if pr.association in TRUSTED_ASSOCIATIONS:
        return True, [f"@{pr.author} is an organization {pr.association.lower()}. Nothing to check."]
    if pr.author == DEPENDABOT and pr.author_type == "Bot":
        return True, ["Dependabot pull request. Nothing to check."]
    try:
        info = api(f"/repos/{repo_slug}/collaborators/{pr.author}/permission")
        role = info.get("role_name", "") if isinstance(info, dict) else ""
    except urllib.error.HTTPError:
        role = ""  # not a collaborator: an outside contributor
    if role in MAINTAINER_ROLES:
        return True, [f"@{pr.author} has the {role} role. Nothing to check."]

    problems: list[str] = []
    issues = closed_issues(pr.body, repo_slug)
    if not issues:
        problems.append(
            "The description does not close an issue. Add `Closes #<number>` for the issue you were assigned."
        )
    elif len(issues) > MAX_ISSUES:
        listed = ", ".join(f"#{n}" for n in sorted(issues))
        problems.append(
            f"The description closes {listed}. A pull request may close at most four issues: "
            "keep up to four `Closes #<number>` lines here and open another pull request for the rest."
        )
    else:
        for number in sorted(issues):
            try:
                issue = api(f"/repos/{repo_slug}/issues/{number}")
            except urllib.error.HTTPError:
                issue = None
            if not isinstance(issue, dict) or "pull_request" in issue:
                problems.append(f"#{number} is not an open issue in this repository.")
                continue
            assignees = {a.get("login") for a in issue.get("assignees") or []}
            if pr.author not in assignees:
                problems.append(
                    f"@{pr.author} is not assigned to #{number}. Ask to be assigned on the issue "
                    "(for Drips Wave issues, apply on Drips) before opening a pull request."
                )

    for change in adrs:
        newly_accepted = ACCEPTED.search(change.head_text) and not (
            change.base_text is not None and ACCEPTED.search(change.base_text)
        )
        if newly_accepted:
            problems.append(
                f"`{change.path}` is marked Accepted. Only the maintainer accepts a design; "
                "set its status to `Proposed, awaiting maintainer approval`."
            )

    if problems:
        return False, problems
    return True, [f"Closes {len(issues)} issue(s), all assigned to the author, and no self-accepted ADRs."]


def adr_changes(repo: str, base: str, head: str) -> list[AdrChange]:
    """ADR files the pull request adds or changes, with their base and head text."""
    out = subprocess.run(
        ["git", "-C", repo, "diff", "--name-only", "-z", "--no-renames", "--diff-filter=AMT", base, head, "--", "docs/adr"],
        check=True, capture_output=True, env=git_env(),
    ).stdout
    changes = []
    for path in (p for p in out.decode().split("\0") if p):
        if not path.endswith(".md") or PurePosixPath(path).name.startswith("TEMPLATE"):
            continue
        changes.append(AdrChange(path, show(repo, base, path), show(repo, head, path) or ""))
    return changes


def show(repo: str, rev: str, path: str) -> str | None:
    result = subprocess.run(["git", "-C", repo, "show", f"{rev}:{path}"], capture_output=True, env=git_env())
    return result.stdout.decode("utf-8", "replace") if result.returncode == 0 else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    args = parser.parse_args(argv)

    env = os.environ
    pr = Contribution(
        author=env["PR_AUTHOR"],
        author_type=env.get("PR_AUTHOR_TYPE", "User"),
        association=env.get("PR_AUTHOR_ASSOCIATION", "NONE").upper(),
        body=env.get("PR_BODY", ""),
    )
    api = github_api(env["GITHUB_TOKEN"], env.get("GITHUB_API_URL", "https://api.github.com"))
    passed, lines = decide(pr, adr_changes(args.repo, args.base, args.head), api, env["GITHUB_REPOSITORY"])

    text = "## Contribution rules\n\n" + "\n".join(f"- {line}" for line in lines) + "\n"
    print(text)
    if env.get("GITHUB_STEP_SUMMARY"):
        with open(env["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(text)
    for line in lines if not passed else []:
        print(f"::error title=contribution rules::{line}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
