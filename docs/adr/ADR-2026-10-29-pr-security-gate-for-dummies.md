# ADR for Dummies: A security gate that blocks malicious pull requests

- **Status:** Accepted 2026-10-30
- **Date:** 2026-10-29

## The Idea

Some people open pull requests whose real purpose is to hack the maintainer: the code steals passwords, keys or wallet seeds the moment someone installs or builds it. Other Drips projects have been removed after merging pull requests like that. We add an automatic check to every pull request that looks for the known tricks and blocks the merge. For any change to a file that can run code on our machines, a maintainer has to approve that exact version first.

## What the Person Sees

1. A contributor opens a pull request. Nothing runs until a maintainer clicks "Approve and run workflows". This is already switched on.
2. A check called `security` runs next to the normal `quality` check. It never installs or runs the contributor's code. It only reads the files.
3. If the pull request contains a hidden program, invisible characters, a scrambled code blob, a dependency from an unofficial source, a known malicious package, a dangerous workflow change or a known virus, `security` turns red and says which file and why. The pull request cannot be merged.
4. If the pull request changes a file that can run code (build scripts, install scripts, git hooks, CI workflows, dependency lists), `security` stays red until a maintainer reads it and approves that exact commit on GitHub. If the contributor pushes anything new afterwards, the approval no longer counts and the maintainer has to look again.
5. A normal pull request that only changes source code, tests or docs goes green in a few minutes with no extra work.

## Important Limitation

No tool can promise to find every piece of malicious code. This check catches the common and known tricks and forces a human to look at the risky files. Maintainers still need to read what they merge. They should also never install a contributor's branch on their own laptop before `security` is green.

## What Changes

- A new required `security` check on every pull request in Tollway, Octroi and Evergreen.
- Changes to build, install, hook and workflow files need the maintainer's approval on the exact commit.
- Octroi stops dependencies from running install scripts unless they are on an approved list. Tollway already does this.
- The rulebook (`AGENTS.md`) gets a rule: do not install or run a contributor's branch locally before `security` passes.
- Pull requests take about three to five minutes longer to check.

## Added While Building It

- **SVG images are checked too.** An SVG can carry a script that runs when someone opens it in a browser. The check rejects any SVG with scripts, click or load handlers, embedded web pages, or links to outside files. All the SVGs in the three projects today are clean.
- **Unused packages are blocked.** A tool called Knip runs with the normal checks and fails when a pull request adds a package that nothing uses, or uses a package that is not declared. A handful of unused packages were removed from the projects to start clean.
- **The checks can't be switched off from inside a pull request.** The check scripts come from the main branch, not from the pull request, and any change to them needs the maintainer's approval.
- **Files too big or too strange to scan are rejected**, so padding a file can't hide code from the scanner.

## What Does Not Change

- The product code of all three projects.
- How contributors pick up Wave issues and open pull requests.
- The existing `quality` check, CodeQL, Dependabot and secret scanning keep running as they do now.
- No outside service gets access to the code.
