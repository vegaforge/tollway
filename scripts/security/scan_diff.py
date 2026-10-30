#!/usr/bin/env python3
"""Static security checks on the files a pull request adds or changes.

The scanner never runs repository code. It reads blobs straight from Git
(`git show <rev>:<path>`), so symlinks in the checkout are never followed.

Checks, each of which fails the run:

  binary          Executables, native modules, archives and other compiled
                  files. Images and fonts pass only under paths listed in the
                  allowlist file.
  link            New symlinks and git submodules.
  hidden-unicode  Bidirectional controls, zero-width characters and Unicode
                  tag characters ("Trojan Source").
  svg             Scripts, event handlers, javascript: URLs, embedded HTML and
                  external references inside SVG files.
  lockfile        pnpm, npm, Cargo and Go dependencies that resolve anywhere
                  other than the official registries.
  dependency      package.json and Cargo.toml dependencies declared with git,
                  URL, file or link specifiers.
  lifecycle       New or changed install-time scripts in package.json, unless
                  the author is an organization owner or member.
  obfuscation     Very long lines, long base64 or hex blobs, files made
                  mostly of escape sequences, and source files too large for
                  the pattern scanner to analyse in time.

Usage:
  scan_diff.py --repo DIR --base REV --head REV [--author-association A]
               [--allowlist FILE]
  scan_diff.py --repo DIR --head REV --all [--allowlist FILE]

--all scans every file in the head tree instead of the diff. It is used to
audit a repository once, and skips the lifecycle check, which compares
against the base.

Findings are printed as GitHub annotations and, when GITHUB_STEP_SUMMARY is
set, as a Markdown table. The exit code is 1 when anything is found.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import PurePosixPath

# ---------------------------------------------------------------------------
# Git access
# ---------------------------------------------------------------------------


def git(repo: str, *args: str) -> bytes:
    return subprocess.run(
        ["git", "-C", repo, *args], check=True, capture_output=True
    ).stdout


def read_blob(repo: str, rev: str, path: str) -> bytes | None:
    """Return the file's bytes at `rev`, or None if it does not exist there."""
    proc = subprocess.run(
        ["git", "-C", repo, "show", f"{rev}:{path}"], capture_output=True
    )
    return proc.stdout if proc.returncode == 0 else None


@dataclass(frozen=True)
class Change:
    path: str
    mode: str  # Git file mode in the head tree: 100644, 100755, 120000, 160000
    status: str  # A (added) or M (modified); deletions are not scanned


def changed_files(repo: str, base: str, head: str) -> list[Change]:
    out = git(repo, "diff", "--raw", "-z", "--no-renames", "--no-abbrev", base, head)
    fields = out.split(b"\0")
    changes = []
    # --raw -z prints ":<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0".
    for i in range(0, len(fields) - 1, 2):
        meta, path = fields[i].decode(), fields[i + 1].decode()
        if not meta.startswith(":"):
            continue
        _old_mode, new_mode, _old_sha, _new_sha, status = meta[1:].split(" ")
        if status[0] in "AMT":
            changes.append(Change(path, new_mode, "A" if status[0] == "A" else "M"))
    return changes


def all_files(repo: str, head: str) -> list[Change]:
    out = git(repo, "ls-tree", "-r", "-z", "--full-tree", head)
    changes = []
    for entry in out.split(b"\0"):
        if not entry:
            continue
        meta, path = entry.decode().split("\t", 1)
        mode = meta.split(" ")[0]
        changes.append(Change(path, mode, "A"))
    return changes


def added_lines(repo: str, base: str | None, head: str, change: Change, text: str) -> list[tuple[int, str]]:
    """Line number and text of every line the change adds."""
    if base is None or change.status == "A":
        return list(enumerate(text.splitlines(), start=1))
    diff = git(repo, "diff", "-U0", "--no-renames", "--no-color", base, head, "--", change.path)
    lines: list[tuple[int, str]] = []
    current = 0
    for raw in diff.decode("utf-8", errors="replace").splitlines():
        if raw.startswith("@@"):
            # @@ -a,b +c,d @@
            m = re.search(r"\+(\d+)", raw)
            current = int(m.group(1)) if m else 0
        elif raw.startswith("+") and not raw.startswith("+++"):
            lines.append((current, raw[1:]))
            current += 1
    return lines


# ---------------------------------------------------------------------------
# Findings
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    check: str
    message: str


def annotate(finding: Finding) -> str:
    msg = finding.message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    loc = f"file={finding.path}" + (f",line={finding.line}" if finding.line else "")
    return f"::error {loc},title=security/{finding.check}::{msg}"


# ---------------------------------------------------------------------------
# Binary files
# ---------------------------------------------------------------------------

# Magic bytes of formats that carry executable code or hide other files.
EXECUTABLE_MAGIC: list[tuple[bytes, str]] = [
    (b"\x7fELF", "ELF executable or shared library"),
    (b"\xfe\xed\xfa\xce", "Mach-O executable"),
    (b"\xfe\xed\xfa\xcf", "Mach-O executable"),
    (b"\xce\xfa\xed\xfe", "Mach-O executable"),
    (b"\xcf\xfa\xed\xfe", "Mach-O executable"),
    (b"\xca\xfe\xba\xbe", "Mach-O universal binary or Java class file"),
    (b"\x00asm", "WebAssembly module"),
    (b"dex\n", "Android DEX bytecode"),
    (b"PK\x03\x04", "zip archive (also jar, apk, vsix, docx)"),
    (b"PK\x05\x06", "empty zip archive"),
    (b"\x1f\x8b", "gzip archive"),
    (b"BZh", "bzip2 archive"),
    (b"\xfd7zXZ\x00", "xz archive"),
    (b"7z\xbc\xaf\x27\x1c", "7z archive"),
    (b"Rar!\x1a\x07", "rar archive"),
    (b"\x28\xb5\x2f\xfd", "zstd archive"),
    (b"MSCF", "Windows cabinet archive"),
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "OLE compound file (old Office, msi)"),
    (b"!<arch>\n", "static library or .deb archive"),
]

# Binary formats that are allowed, but only under allowlisted paths.
ASSET_MAGIC: list[tuple[bytes, str]] = [
    (b"\x89PNG\r\n\x1a\n", "PNG image"),
    (b"\xff\xd8\xff", "JPEG image"),
    (b"GIF87a", "GIF image"),
    (b"GIF89a", "GIF image"),
    (b"RIFF", "RIFF container (WebP image)"),
    (b"\x00\x00\x01\x00", "ICO image"),
    (b"wOFF", "WOFF font"),
    (b"wOF2", "WOFF2 font"),
    (b"\x00\x01\x00\x00", "TrueType font"),
    (b"OTTO", "OpenType font"),
    (b"%PDF-", "PDF document"),
]


def is_pe(data: bytes) -> bool:
    """Windows PE: 'MZ' header whose e_lfanew points at a 'PE\\0\\0' signature."""
    if not data.startswith(b"MZ") or len(data) < 0x40:
        return False
    offset = int.from_bytes(data[0x3C:0x40], "little")
    return data[offset : offset + 4] == b"PE\x00\x00"


def is_tar(data: bytes) -> bool:
    return len(data) > 262 and data[257:262] == b"ustar"


def looks_binary(data: bytes) -> bool:
    """Text files do not contain NUL bytes and decode as UTF-8."""
    if b"\x00" in data[:8192]:
        return True
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


def load_allowlist(path: str | None) -> list[str]:
    if not path or not os.path.exists(path):
        return []
    globs = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                globs.append(line)
    return globs


def glob_match(path: str, pattern: str) -> bool:
    """gitignore-style match: `**` spans directories, `*` stays inside one."""
    regex = ""
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            regex += "(?:.*/)?"
            i += 3
        elif pattern.startswith("**", i):
            regex += ".*"
            i += 2
        elif pattern[i] == "*":
            regex += "[^/]*"
            i += 1
        elif pattern[i] == "?":
            regex += "[^/]"
            i += 1
        else:
            regex += re.escape(pattern[i])
            i += 1
    if "/" not in pattern:
        regex = "(?:.*/)?" + regex  # a bare name matches at any depth
    return re.fullmatch(regex, path) is not None


def check_binary(change: Change, data: bytes, allowlist: list[str]) -> list[Finding]:
    for magic, label in EXECUTABLE_MAGIC:
        if data.startswith(magic):
            return [Finding(change.path, 0, "binary", f"{label}. Compiled and archived files cannot be reviewed and are not accepted in pull requests.")]
    if is_pe(data):
        return [Finding(change.path, 0, "binary", "Windows PE executable or DLL. Compiled files are not accepted in pull requests.")]
    if is_tar(data):
        return [Finding(change.path, 0, "binary", "tar archive. Archives are not accepted in pull requests.")]
    if not looks_binary(data):
        return []
    label = next((lbl for magic, lbl in ASSET_MAGIC if data.startswith(magic)), None)
    allowed = any(glob_match(change.path, g) for g in allowlist)
    if label and allowed:
        return []
    if label:
        return [Finding(change.path, 0, "binary", f"{label} outside the asset folders in .github/security/allowed-binaries.txt. Move it to an allowed folder, or ask a maintainer to extend the allowlist.")]
    return [Finding(change.path, 0, "binary", "Unrecognised binary file. Only images and fonts in allowlisted asset folders are accepted.")]


# ---------------------------------------------------------------------------
# Symlinks and submodules
# ---------------------------------------------------------------------------


def check_link(change: Change, data: bytes) -> list[Finding]:
    if change.mode == "120000":
        target = data.decode("utf-8", errors="replace")
        return [Finding(change.path, 0, "link", f"Symlink to '{target}'. Symlinks can point tools at files outside the repository and are not accepted.")]
    if change.mode == "160000":
        return [Finding(change.path, 0, "link", "Git submodule. A submodule pulls in code from another repository and is not accepted.")]
    return []


# ---------------------------------------------------------------------------
# Hidden Unicode
# ---------------------------------------------------------------------------

BIDI = set(range(0x202A, 0x202F)) | set(range(0x2066, 0x206A)) | {0x200E, 0x200F, 0x061C}
ZERO_WIDTH = {0x200B, 0x200C, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF, 0x180E}
ZWJ = 0x200D
TAGS = range(0xE0000, 0xE0080)
PROSE_EXTENSIONS = {".md", ".mdx", ".txt", ".rst"}


def is_emoji(ch: str) -> bool:
    cp = ord(ch)
    return cp >= 0x1F000 or 0x2600 <= cp <= 0x27BF or cp in (0xFE0F, 0x2640, 0x2642)


def check_hidden_unicode(change: Change, lines: list[tuple[int, str]]) -> list[Finding]:
    prose = PurePosixPath(change.path).suffix.lower() in PROSE_EXTENSIONS
    findings = []
    for lineno, text in lines:
        for col, ch in enumerate(text):
            cp = ord(ch)
            if cp == 0xFEFF and lineno == 1 and col == 0:
                continue  # a byte-order mark at the start of the file
            kind = None
            if cp in BIDI:
                kind = "bidirectional control"
            elif cp in ZERO_WIDTH:
                kind = "zero-width character"
            elif cp in TAGS:
                kind = "Unicode tag character"
            elif cp == ZWJ:
                # Emoji sequences in prose use the zero-width joiner between two emoji.
                between_emoji = 0 < col < len(text) - 1 and is_emoji(text[col - 1]) and is_emoji(text[col + 1])
                if not (prose and between_emoji):
                    kind = "zero-width joiner"
            if kind:
                findings.append(Finding(change.path, lineno, "hidden-unicode", f"Invisible {kind} U+{cp:04X} at column {col + 1}. It can make code read differently from how it runs."))
                break  # one finding per line is enough
    return findings


# ---------------------------------------------------------------------------
# SVG content
# ---------------------------------------------------------------------------

SVG_RULES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"<\s*script\b", re.I), "a <script> element"),
    (re.compile(r"\son[a-z]+\s*=", re.I), "an event-handler attribute (onload, onclick, ...)"),
    (re.compile(r"(?:java|vb)script\s*:", re.I), "a javascript: URL"),
    (re.compile(r"<\s*foreignObject\b", re.I), "a <foreignObject> element, which embeds HTML"),
    (re.compile(r"<\s*(?:iframe|embed|object|html|body|meta|link|form|input|base)\b", re.I), "an embedded HTML element"),
    (re.compile(r"<!ENTITY|<!DOCTYPE[^>]*\[", re.I), "an XML entity declaration"),
    (re.compile(r"<\?xml-stylesheet", re.I), "an external stylesheet processing instruction"),
    (re.compile(r"@import", re.I), "a CSS @import"),
    (re.compile(r"""(?:href|src)\s*=\s*["']\s*(?!#)(?:[a-z][a-z0-9+.-]*:|//)""", re.I), "a reference to an external URL or data: URI"),
    (re.compile(r"""url\(\s*["']?\s*(?!#)(?:[a-z][a-z0-9+.-]*:|//)""", re.I), "a CSS url() to an external URL or data: URI"),
    (re.compile(r"<\s*(?:set|animate)\b[^>]*attributeName\s*=\s*[\"'](?:href|xlink:href|on[a-z]+)", re.I), "an animation that rewrites a link or event handler"),
]

# Namespace declarations are the one legitimate absolute URL in an SVG.
SVG_NAMESPACE = re.compile(r"""\sxmlns(?::[a-z]+)?\s*=\s*["'][^"']*["']""", re.I)


def check_svg(change: Change, text: str) -> list[Finding]:
    if PurePosixPath(change.path).suffix.lower() not in (".svg", ".svgz"):
        return []
    findings = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        scrubbed = SVG_NAMESPACE.sub("", line)
        for pattern, label in SVG_RULES:
            if pattern.search(scrubbed):
                findings.append(Finding(change.path, lineno, "svg", f"SVG contains {label}. SVGs must be plain vector graphics: no scripts, handlers, HTML or external references."))
    return findings


# ---------------------------------------------------------------------------
# Lockfiles and dependency declarations
# ---------------------------------------------------------------------------

NPM_REGISTRY = "https://registry.npmjs.org/"
CRATES_SOURCES = {
    "registry+https://github.com/rust-lang/crates.io-index",
    "sparse+https://index.crates.io/",
}
DEP_SECTIONS = ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies", "overrides", "resolutions")
BAD_SPECIFIER = re.compile(r"^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:|file:|link:|[\w.-]+/[\w.-]+(?:#.*)?$)")


def check_pnpm_lock(change: Change, text: str) -> list[Finding]:
    findings = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if "resolution:" in stripped:
            if "tarball:" in stripped:
                url = re.search(r"tarball:\s*([^,}\s]+)", stripped)
                if url and not url.group(1).startswith(NPM_REGISTRY):
                    findings.append(Finding(change.path, lineno, "lockfile", f"Package resolves to a tarball outside registry.npmjs.org: {url.group(1)}"))
            elif re.search(r"type:\s*git|repo:|commit:", stripped):
                findings.append(Finding(change.path, lineno, "lockfile", "Package resolves to a git repository instead of registry.npmjs.org."))
            elif "directory:" in stripped:
                findings.append(Finding(change.path, lineno, "lockfile", "Package resolves to a local directory."))
        elif re.search(r"codeload\.github\.com|(?:^|\s|')git\+|(?:^|\s|')(?:github|gitlab|bitbucket):", stripped):
            findings.append(Finding(change.path, lineno, "lockfile", "Lockfile entry points at a git host instead of registry.npmjs.org."))
    return findings


def check_package_lock(change: Change, text: str) -> list[Finding]:
    try:
        lock = json.loads(text)
    except json.JSONDecodeError as exc:
        return [Finding(change.path, exc.lineno, "lockfile", f"package-lock.json is not valid JSON: {exc.msg}")]
    findings = []
    for name, entry in (lock.get("packages") or {}).items():
        if not name or entry.get("link"):
            continue  # the root project and workspace links
        resolved = entry.get("resolved")
        if resolved is None and entry.get("inBundle"):
            continue
        if resolved is None or not str(resolved).startswith(NPM_REGISTRY):
            findings.append(Finding(change.path, 0, "lockfile", f"{name} resolves to {resolved!r}, not registry.npmjs.org."))
        elif not entry.get("integrity"):
            findings.append(Finding(change.path, 0, "lockfile", f"{name} has no integrity hash."))
    return findings


def check_cargo_lock(change: Change, text: str) -> list[Finding]:
    findings = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        m = re.match(r'\s*source\s*=\s*"([^"]+)"', line)
        if m and m.group(1) not in CRATES_SOURCES:
            findings.append(Finding(change.path, lineno, "lockfile", f"Crate comes from {m.group(1)} instead of crates.io."))
    return findings


def check_go_mod(change: Change, text: str) -> list[Finding]:
    findings = []
    in_block = False
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.split("//", 1)[0].strip()
        if re.match(r"replace\s*\($", stripped):
            in_block = True
            continue
        if in_block and stripped == ")":
            in_block = False
            continue
        if stripped.startswith("replace ") or (in_block and "=>" in stripped):
            findings.append(Finding(change.path, lineno, "lockfile", "go.mod replace directive. Modules must come from their published versions through the Go proxy."))
    return findings


def check_package_json(change: Change, text: str) -> list[Finding]:
    try:
        pkg = json.loads(text)
    except json.JSONDecodeError as exc:
        return [Finding(change.path, exc.lineno, "dependency", f"package.json is not valid JSON: {exc.msg}")]
    findings = []

    def walk(section: str, deps: object) -> None:
        if not isinstance(deps, dict):
            return
        for name, spec in deps.items():
            if isinstance(spec, dict):  # nested overrides
                walk(section, spec)
                continue
            if not isinstance(spec, str):
                continue
            if spec.startswith(("workspace:", "catalog:", "npm:")):
                continue
            if BAD_SPECIFIER.match(spec):
                findings.append(Finding(change.path, line_of(text, f'"{name}"'), "dependency", f"{section}.{name} is '{spec}'. Dependencies must be registry versions, not git, URL, file or link specifiers."))

    for section in DEP_SECTIONS:
        walk(section, pkg.get(section))
    pnpm = pkg.get("pnpm") if isinstance(pkg.get("pnpm"), dict) else {}
    walk("pnpm.overrides", pnpm.get("overrides"))
    return findings


def check_cargo_toml(change: Change, lines: list[tuple[int, str]]) -> list[Finding]:
    findings = []
    for lineno, text in lines:
        if re.search(r"\bgit\s*=\s*\"", text) or re.search(r"\bregistry(?:-index)?\s*=\s*\"", text):
            findings.append(Finding(change.path, lineno, "dependency", "Cargo dependency from a git repository or an alternative registry. Dependencies must come from crates.io."))
    return findings


def check_npmrc(change: Change, text: str) -> list[Finding]:
    findings = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        m = re.match(r"\s*(?:@[\w-]+:)?registry\s*=\s*(\S+)", line)
        if m and not m.group(1).startswith(NPM_REGISTRY.rstrip("/")):
            findings.append(Finding(change.path, lineno, "dependency", f".npmrc points a registry at {m.group(1)}."))
        if re.match(r"\s*ignore-scripts\s*=\s*false", line):
            findings.append(Finding(change.path, lineno, "dependency", ".npmrc turns dependency install scripts back on."))
    return findings


def line_of(text: str, needle: str) -> int:
    idx = text.find(needle)
    return text.count("\n", 0, idx) + 1 if idx >= 0 else 0


# ---------------------------------------------------------------------------
# Install-time lifecycle scripts
# ---------------------------------------------------------------------------

LIFECYCLE = ("preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly", "prepack", "postpack", "preprepare", "postprepare", "dependencies")
TRUSTED_ASSOCIATIONS = {"OWNER", "MEMBER"}


def scripts_of(data: bytes | None) -> dict[str, str]:
    if data is None:
        return {}
    try:
        scripts = json.loads(data).get("scripts") or {}
    except (json.JSONDecodeError, AttributeError):
        return {}
    return scripts if isinstance(scripts, dict) else {}


def check_lifecycle(change: Change, base_data: bytes | None, head_text: str, association: str) -> list[Finding]:
    if association in TRUSTED_ASSOCIATIONS:
        return []
    before = scripts_of(base_data)
    after = scripts_of(head_text.encode())
    findings = []
    for name in LIFECYCLE:
        if name in after and after.get(name) != before.get(name):
            findings.append(Finding(change.path, line_of(head_text, f'"{name}"'), "lifecycle", f"Adds or changes the '{name}' script, which runs automatically on install. Contributors do not need install-time scripts; a maintainer has to make this change."))
    return findings


# ---------------------------------------------------------------------------
# Obfuscation
# ---------------------------------------------------------------------------

CODE_EXTENSIONS = {
    ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx",
    ".rs", ".go", ".py", ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
    ".rb", ".pl", ".php", ".lua", ".vue", ".svelte", ".html", ".htm",
}
CODE_NAMES = {"Makefile", "Dockerfile", "justfile", "Justfile"}
MAX_LINE = 1000
BLOB = re.compile(r"[A-Za-z0-9+/]{2000,}={0,2}|(?:[0-9a-fA-F]{2}){1000,}")
ESCAPE = re.compile(r"\\x[0-9a-fA-F]{2}|\\u\{?[0-9a-fA-F]{4,6}\}?")
# SVG path data (drawing commands and numbers only) is long by nature and cannot
# carry code, so it does not count towards the line length.
SVG_PATH_DATA = re.compile(r"""\bd=["'][MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]*["']""")
# Semgrep gives up on very large files (it reports a timeout, not a finding),
# so padding a file is a way to slip code past it. Source files this large have
# no place in these repositories.
MAX_SOURCE_BYTES = 512 * 1024
MIN_ESCAPE_SAMPLE = 200
MAX_ESCAPE_RATIO = 0.10


def is_code(path: str) -> bool:
    p = PurePosixPath(path)
    return p.suffix.lower() in CODE_EXTENSIONS or p.name in CODE_NAMES or p.name.startswith("Dockerfile")


def check_obfuscation(change: Change, text: str, lines: list[tuple[int, str]]) -> list[Finding]:
    if not is_code(change.path):
        return []
    findings = []
    size = len(text.encode("utf-8"))
    if size > MAX_SOURCE_BYTES:
        findings.append(Finding(change.path, 0, "obfuscation", f"Source file is {size // 1024} KB. Files over {MAX_SOURCE_BYTES // 1024} KB cannot be analysed reliably and are not accepted."))
    for lineno, line in lines:
        if len(SVG_PATH_DATA.sub('d=""', line)) > MAX_LINE:
            findings.append(Finding(change.path, lineno, "obfuscation", f"Line is {len(line)} characters long. Minified or packed code is not accepted in source files."))
        elif BLOB.search(line):
            findings.append(Finding(change.path, lineno, "obfuscation", "Long base64 or hex blob. Encoded payloads are not accepted in source files."))
    if len(text) >= MIN_ESCAPE_SAMPLE:
        escaped = sum(len(m.group(0)) for m in ESCAPE.finditer(text))
        ratio = escaped / len(text)
        if ratio > MAX_ESCAPE_RATIO:
            findings.append(Finding(change.path, 0, "obfuscation", f"{ratio:.0%} of the file is \\x or \\u escape sequences. Escaped strings are a common way to hide code."))
    return findings


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def scan(repo: str, base: str | None, head: str, association: str, allowlist: list[str]) -> list[Finding]:
    changes = all_files(repo, head) if base is None else changed_files(repo, base, head)
    findings: list[Finding] = []
    for change in changes:
        data = read_blob(repo, head, change.path) if change.mode != "160000" else b""
        if data is None:
            continue
        if change.mode in ("120000", "160000"):
            findings += check_link(change, data)
            continue
        binary = check_binary(change, data, allowlist)
        if binary or looks_binary(data):
            findings += binary
            continue

        text = data.decode("utf-8")
        lines = added_lines(repo, base, head, change, text)
        name = PurePosixPath(change.path).name

        findings += check_hidden_unicode(change, lines)
        findings += check_svg(change, text)
        findings += check_obfuscation(change, text, lines)

        if name == "pnpm-lock.yaml":
            findings += check_pnpm_lock(change, text)
        elif name in ("package-lock.json", "npm-shrinkwrap.json"):
            findings += check_package_lock(change, text)
        elif name == "Cargo.lock":
            findings += check_cargo_lock(change, text)
        elif name == "go.mod":
            findings += check_go_mod(change, text)
        elif name == "Cargo.toml":
            findings += check_cargo_toml(change, lines)
        elif name == ".npmrc":
            findings += check_npmrc(change, text)
        elif name == "package.json":
            findings += check_package_json(change, text)
            if base is not None:
                findings += check_lifecycle(change, read_blob(repo, base, change.path), text, association)
    return findings


def write_summary(findings: list[Finding], scanned: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as f:
        f.write(f"## Diff scan\n\nScanned {scanned}.\n\n")
        if not findings:
            f.write("No findings.\n")
            return
        f.write("| Check | File | Line | Finding |\n|---|---|---|---|\n")
        for x in findings:
            f.write(f"| {x.check} | `{x.path}` | {x.line or ''} | {x.message.replace('|', '/')} |\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True, help="Git checkout to read from")
    parser.add_argument("--head", required=True, help="Revision under review")
    parser.add_argument("--base", help="Revision to diff against")
    parser.add_argument("--all", action="store_true", help="Scan every file in --head")
    parser.add_argument("--author-association", default="NONE", help="GitHub author_association of the pull request author")
    parser.add_argument("--allowlist", help="File of path globs where images and fonts are allowed")
    args = parser.parse_args(argv)
    if not args.all and not args.base:
        parser.error("--base is required unless --all is given")

    base = None if args.all else args.base
    findings = scan(args.repo, base, args.head, args.author_association.upper(), load_allowlist(args.allowlist))
    for f in findings:
        print(annotate(f))
    scanned = f"every file at {args.head}" if args.all else f"{args.base}..{args.head}"
    write_summary(findings, scanned)
    if findings:
        print(f"\n{len(findings)} finding(s). See the annotations above.", file=sys.stderr)
        return 1
    print(f"Diff scan passed ({scanned}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
