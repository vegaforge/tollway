#!/usr/bin/env python3
"""Require a maintainer's review, on the latest commit, for sensitive changes.

A pull request that adds, changes or deletes a path listed in
.github/security/sensitive-paths.txt passes only when:

  * its author is an organization owner or member, or has the admin or
    maintain role on the repository, or
  * its author is Dependabot and every sensitive file is a manifest or
    lockfile, or
  * a user with the admin or maintain role has APPROVED the pull request on
    its current head commit, and no such user's latest review requests
    changes.

An approval on an older commit does not count, so a push after the review
turns the check red again. The workflow re-runs on every submitted or
dismissed review.

Usage (the workflow sets the environment from the event payload):
  check_review.py --repo DIR --base REV --head REV --paths FILE

Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, PR_NUMBER,
PR_HEAD_SHA, PR_AUTHOR, PR_AUTHOR_TYPE, PR_AUTHOR_ASSOCIATION.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Callable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scan_diff import git_env, glob_match, load_allowlist  # noqa: E402

TRUSTED_ASSOCIATIONS = {"OWNER", "MEMBER"}
MAINTAINER_ROLES = {"admin", "maintain"}
DEPENDABOT = "dependabot[bot]"
DEPENDENCY_FILES = {"package.json", "pnpm-lock.yaml", "package-lock.json", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum"}

Api = Callable[[str], object]


@dataclass(frozen=True)
class PullRequest:
    number: str
    head_sha: str
    author: str
    author_type: str
    association: str


def touched_paths(repo: str, base: str, head: str) -> list[str]:
    """Every path the pull request adds, changes or deletes."""
    out = subprocess.run(
        ["git", "-C", repo, "diff", "--name-only", "-z", "--no-renames", base, head],
        check=True, capture_output=True, env=git_env(),
    ).stdout
    return [p for p in out.decode().split("\0") if p]


def sensitive(paths: list[str], globs: list[str]) -> list[str]:
    return [p for p in paths if any(glob_match(p, g) for g in globs)]


def github_api(token: str, base_url: str) -> Api:
    def get(path: str) -> object:
        results: list[object] = []
        url: str | None = f"{base_url}{path}"
        while url:
            req = urllib.request.Request(url, headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            })
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.load(resp)
                if not isinstance(body, list):
                    return body
                results += body
                url = next_link(resp.headers.get("Link", ""))
        return results
    return get


def next_link(header: str) -> str | None:
    for part in header.split(","):
        if 'rel="next"' in part:
            return part[part.find("<") + 1 : part.find(">")]
    return None


def decide(pr: PullRequest, touched: list[str], globs: list[str], api: Api, repo_slug: str) -> tuple[bool, list[str]]:
    """Return (passed, explanation lines)."""
    hits = sensitive(touched, globs)
    if not hits:
        return True, ["No sensitive paths changed."]
    lines = ["Sensitive paths in this pull request:", *[f"- `{p}`" for p in hits], ""]

    role_cache: dict[str, str] = {}

    def role(user: str) -> str:
        if user not in role_cache:
            try:
                info = api(f"/repos/{repo_slug}/collaborators/{user}/permission")
                role_cache[user] = (info or {}).get("role_name", "") if isinstance(info, dict) else ""
            except urllib.error.HTTPError:
                role_cache[user] = ""  # not a collaborator, or not visible: not a maintainer
        return role_cache[user]

    if pr.association in TRUSTED_ASSOCIATIONS:
        lines.append(f"The author, @{pr.author}, is an organization {pr.association.lower()}. No extra review is needed.")
        return True, lines
    # Private organization membership appears as CONTRIBUTOR in workflow
    # events, so also trust an author who could approve the change themselves.
    if role(pr.author) in MAINTAINER_ROLES:
        lines.append(f"The author, @{pr.author}, has the {role(pr.author)} role on this repository. No extra review is needed.")
        return True, lines
    if pr.author == DEPENDABOT and pr.author_type == "Bot" and all(PurePosixPath(p).name in DEPENDENCY_FILES for p in hits):
        lines.append("Dependabot changed only manifests and lockfiles. The dependency checks cover them.")
        return True, lines

    reviews = api(f"/repos/{repo_slug}/pulls/{pr.number}/reviews")
    assert isinstance(reviews, list)
    latest: dict[str, dict] = {}
    for review in reviews:  # the API returns reviews oldest first
        user = (review.get("user") or {}).get("login")
        if user and review.get("state") in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
            latest[user] = review

    maintainers = {u: r for u, r in latest.items() if u != pr.author and role(u) in MAINTAINER_ROLES}
    blocking = [u for u, r in maintainers.items() if r["state"] == "CHANGES_REQUESTED"]
    approvals = [u for u, r in maintainers.items() if r["state"] == "APPROVED" and r.get("commit_id") == pr.head_sha]
    stale = [u for u, r in maintainers.items() if r["state"] == "APPROVED" and r.get("commit_id") != pr.head_sha]

    if blocking:
        lines.append("A maintainer has requested changes: " + ", ".join(f"@{u}" for u in blocking) + ".")
        return False, lines
    if approvals:
        lines.append(f"Approved on {pr.head_sha[:12]} by " + ", ".join(f"@{u}" for u in approvals) + ".")
        return True, lines
    if stale:
        lines.append("A maintainer approved an earlier commit (" + ", ".join(f"@{u}" for u in stale) + "), but new commits were pushed since. The latest commit needs a fresh review.")
    lines.append(f"A maintainer (admin or maintain role) has to review these files and approve commit {pr.head_sha[:12]}. Approving re-runs this check.")
    return False, lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--paths", required=True, help="File of sensitive path globs")
    args = parser.parse_args(argv)

    env = os.environ
    pr = PullRequest(
        number=env["PR_NUMBER"],
        head_sha=env["PR_HEAD_SHA"],
        author=env["PR_AUTHOR"],
        author_type=env.get("PR_AUTHOR_TYPE", "User"),
        association=env.get("PR_AUTHOR_ASSOCIATION", "NONE").upper(),
    )
    globs = load_allowlist(args.paths)
    if not globs:
        print(f"::error title=security/sensitive-paths::No sensitive path globs found in {args.paths}.")
        return 1
    api = github_api(env["GITHUB_TOKEN"], env.get("GITHUB_API_URL", "https://api.github.com"))
    passed, lines = decide(pr, touched_paths(args.repo, args.base, args.head), globs, api, env["GITHUB_REPOSITORY"])

    text = "## Sensitive paths\n\n" + "\n".join(lines) + "\n"
    print(text)
    if env.get("GITHUB_STEP_SUMMARY"):
        with open(env["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
            f.write(text)
    if not passed:
        print(f"::error title=security/sensitive-paths::{lines[-1]}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
