"""Regression fence for the 2026-11 supply-chain gate.

CI already runs `python3 -m unittest discover -s scripts/tests -p 'test_*.py'`.
These tests use a throwaway tree so they never depend on network access, a Rust
toolchain, or an npm install.

Gate policy under test: in advisory mode only two classes fail --
(a) an unapproved npm lifecycle script, (b) a Bun version < 1.4.4 -- plus exact
worm IOC / typosquat hits, which are P0 in every mode. Action pin drift and the
Node floor become blocking only with `--mode blocking`.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/security/supply_chain_check.py"


def run(root: pathlib.Path, mode: str = "advisory") -> dict:
    p = subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(root), "--mode", mode, "--json"],
        capture_output=True, text=True, timeout=60,
    )
    return {"code": p.returncode, "data": json.loads(p.stdout)}


class Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        (self.root / ".github/workflows").mkdir(parents=True)
        (self.root / "frontend").mkdir()
        (self.root / "deny.toml").write_text("[advisories]\nignore = []\n")
        self.workflow = self.root / ".github/workflows/ci.yml"
        self.workflow.write_text(
            "jobs:\n  test:\n    steps:\n"
            "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n"
            "      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0\n"
            "        with:\n          bun-version: 1.4.4\n"
        )
        (self.root / "Dockerfile").write_text("FROM oven/bun:1.4.4 AS builder\n")
        self.lock = self.root / "frontend/package-lock.json"
        self.lock.write_text(json.dumps({
            "lockfileVersion": 3,
            "packages": {
                "": {"name": "fixture", "version": "1.0.0"},
                "node_modules/safe-lib": {"version": "1.2.3"},
                "node_modules/esbuild": {"version": "0.25.12", "hasInstallScript": True},
            },
        }))

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def put_packages(self, extra: dict) -> None:
        data = json.loads(self.lock.read_text())
        data["packages"].update(extra)
        self.lock.write_text(json.dumps(data))

    def test_clean_fixture_passes(self) -> None:
        r = run(self.root)
        self.assertEqual(r["code"], 0, r["data"])

    def test_old_bun_pin_blocks_in_advisory_mode(self) -> None:
        self.workflow.write_text(self.workflow.read_text().replace("bun-version: 1.4.4", "bun-version: 1.3.14"))
        r = run(self.root)
        self.assertEqual(r["code"], 1)
        self.assertTrue(any(x["check"] == "bun_floor" and x["fails"] for x in r["data"]["rows"]))

    def test_old_bun_docker_image_blocks_in_advisory_mode(self) -> None:
        (self.root / "Dockerfile").write_text("FROM oven/bun:1.2.22 AS builder\n")
        r = run(self.root)
        self.assertEqual(r["code"], 1)
        self.assertTrue(any(x["check"] == "bun_floor" and x["fails"] for x in r["data"]["rows"]))

    def test_new_lifecycle_script_blocks_in_advisory_mode(self) -> None:
        self.put_packages({"node_modules/worm-dropper": {"version": "9.9.9", "hasInstallScript": True,
                                                         "scripts": {"preinstall": "node setup.mjs"}}})
        r = run(self.root)
        self.assertEqual(r["code"], 1)
        self.assertTrue(any(x["check"] == "install_scripts" and "worm-dropper" in x["message"] and x["fails"]
                            for x in r["data"]["rows"]))

    def test_exact_chaindrop_ioc_is_p0_in_every_mode(self) -> None:
        self.put_packages({"node_modules/keyv": {"version": "6.0.0"}})
        for mode in ("advisory", "blocking"):
            r = run(self.root, mode)
            self.assertEqual(r["code"], 1, mode)
            self.assertTrue(any(x["check"] == "ioc_sweep" and x["level"] == "p0" for x in r["data"]["rows"]))

    def test_playwright_typosquat_is_p0(self) -> None:
        self.put_packages({"node_modules/playwright-1.45": {"version": "10.1.3"}})
        r = run(self.root)
        self.assertEqual(r["code"], 1)
        self.assertTrue(any("MALICIOUS TYPOSQUAT" in x["message"] for x in r["data"]["rows"]))

    def test_unpinned_action_is_advisory_then_blocking(self) -> None:
        self.workflow.write_text("jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n")
        self.assertEqual(run(self.root, "advisory")["code"], 0)
        r = run(self.root, "blocking")
        self.assertEqual(r["code"], 1)
        self.assertTrue(any(x["check"] == "actions_pinned" and x["fails"] for x in r["data"]["rows"]))

    def test_eol_node_is_advisory_then_blocking(self) -> None:
        (self.root / "Dockerfile").write_text("FROM node:20-slim\nFROM oven/bun:1.4.4\n")
        self.assertEqual(run(self.root, "advisory")["code"], 0)
        r = run(self.root, "blocking")
        self.assertEqual(r["code"], 1)
        self.assertTrue(any(x["check"] == "node_floor" and x["fails"] for x in r["data"]["rows"]))

    def test_watch_scope_is_review_item_not_p0(self) -> None:
        self.put_packages({"node_modules/@tanstack/router-core": {"version": "1.170.0"}})
        r = run(self.root)
        self.assertEqual(r["code"], 0)
        self.assertTrue(any("watch scope" in x["message"] for x in r["data"]["rows"]))


class CommittedRepository(unittest.TestCase):
    def test_repository_passes_its_own_gate(self) -> None:
        r = run(ROOT)
        self.assertEqual(r["code"], 0, r["data"])

    def test_action_pins_are_current(self) -> None:
        p = subprocess.run([sys.executable, str(ROOT / "scripts/security/pin_actions.py"), "--check"],
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr + p.stdout)

    def test_toolchain_fingerprint_script_is_executable_by_node(self) -> None:
        p = subprocess.run(["node", str(ROOT / "scripts/security/toolchain-fingerprint.mjs")],
                           capture_output=True, text=True, timeout=60)
        # Local dev machines are not gated on the Node floor; this test only
        # asserts the script runs and reports a parseable fingerprint.
        self.assertIn("node:", p.stdout)
        self.assertIn("toolchain:", p.stdout)


if __name__ == "__main__":
    unittest.main()
