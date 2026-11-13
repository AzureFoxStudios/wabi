"""Regression fence for scripts/security/private_details_check.py.

Runs in the existing `python3 -m unittest discover -s scripts/tests` CI step.
Uses a throwaway git tree, so it does not depend on this repository's content,
plus one self-check that the real tree is clean.
"""
from __future__ import annotations

import gzip
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/security/private_details_check.py"


def run(root: pathlib.Path) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, str(SCRIPT), "--root", str(root)],
                          capture_output=True, text=True, timeout=60)


class Tree:
    def __init__(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)

    def write(self, rel: str, content: str | bytes) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode())
        subprocess.run(["git", "-C", str(self.root), "add", rel], check=True)


class PrivateDetailsCheck(unittest.TestCase):
    def setUp(self) -> None:
        self.tree = Tree()
        self.addCleanup(self.tree.tmp.cleanup)

    def test_documentation_values_pass(self) -> None:
        self.tree.write("docs/a.md", "ssh operator@192.0.2.10; v6 2001:db8::42; 198.51.100.7; "
                                     "203.0.113.5; 127.0.0.1:3001; 0.0.0.0; /home/operator/wabi; "
                                     "time 12:30:45; 8.8.8.8\n")
        p = run(self.tree.root)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    def test_each_private_class_fails(self) -> None:
        cases = {
            "docs/tailnet.md": "ssh operator@100.80.1.2",
            "scripts/lan.sh": 'HOST="192.168.4.20"',
            "docs/ten.md": "http://10.20.30.40:8080",
            "docs/rfc1918.md": "172.20.0.5",
            "docs/link.md": "169.254.10.10",
            "docs/v6.md": "[2001:fb0:1:2:3:4:5:6]:3000",
            "docs/magic.md": "laptop.my-tailnet.ts.net",
            "frontend/scripts/home.mjs": "cd /home/alice/wabi",
            "README.md": r"C:\Users\Alice\.cargo\bin",
            "docs/glued.json": '{"note": "expected host=bazzite100.70.1.2 and repo/home/bob/x"}',
        }
        for rel, content in cases.items():
            self.tree.write(rel, content + "\n")
        p = run(self.tree.root)
        self.assertEqual(p.returncode, 1)
        for rel in cases:
            self.assertIn(rel + ":", p.stdout)
        self.assertIn("private_ipv4: 100.70.1.2", p.stdout)
        self.assertIn("home_path: /home/bob", p.stdout)

    def test_gzip_evidence_is_scanned(self) -> None:
        self.tree.write("docs/testing/run.log.gz", gzip.compress(b"peer 100.99.1.1 ok\n"))
        p = run(self.tree.root)
        self.assertEqual(p.returncode, 1)
        self.assertIn("docs/testing/run.log.gz:1: private_ipv4", p.stdout)

    def test_application_source_is_out_of_scope(self) -> None:
        self.tree.write("core/src/net.rs", 'assert!(is_private("10.0.0.1"));\n')
        self.assertEqual(run(self.tree.root).returncode, 0)

    def test_untracked_files_are_ignored(self) -> None:
        (self.tree.root / "docs").mkdir()
        (self.tree.root / "docs/scratch.md").write_text("10.1.1.1\n")
        self.assertEqual(run(self.tree.root).returncode, 0)

    def test_allowlist_is_exact_per_file_and_needs_reason(self) -> None:
        self.tree.write("docs/lan.md", "192.168.1.42 and 192.168.1.43\n")
        self.tree.write("docs/other.md", "192.168.1.42\n")
        allow = {"allowed": [{"path": "docs/lan.md", "values": ["192.168.1.42"], "reason": "example"}]}
        self.tree.write("scripts/security/private-details-allowlist.json", json.dumps(allow))
        p = run(self.tree.root)
        self.assertEqual(p.returncode, 1)
        self.assertIn("docs/lan.md:1: private_ipv4: 192.168.1.43", p.stdout)
        self.assertIn("docs/other.md:1: private_ipv4: 192.168.1.42", p.stdout)
        self.assertNotIn("docs/lan.md:1: private_ipv4: 192.168.1.42", p.stdout)

        allow["allowed"][0]["reason"] = ""
        self.tree.write("scripts/security/private-details-allowlist.json", json.dumps(allow))
        p = run(self.tree.root)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("needs a reason", p.stdout + p.stderr)

    def test_repository_tree_is_clean(self) -> None:
        p = run(ROOT)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)


if __name__ == "__main__":
    unittest.main()
