"""Regression tests for the baseline-aware npm advisory gate.

Run with: python3 -m unittest discover -s scripts/tests -p 'test_*.py' -v
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
GATE = ROOT / "scripts/security/npm_audit_gate.py"
spec = importlib.util.spec_from_file_location("npm_audit_gate", GATE)
mod = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(mod)


def run(audit: dict, mode: str = "blocking"):
    with tempfile.TemporaryDirectory() as d:
        p = pathlib.Path(d) / "audit.json"
        p.write_text(json.dumps(audit))
        # --audit-json is resolved relative to ROOT, so use an absolute path here
        # by temporarily patching load_audit instead.
        original = mod.load_audit
        mod.load_audit = lambda _path: audit
        try:
            argv = sys.argv
            sys.argv = ["npm_audit_gate.py", "--mode", mode, "--audit-json", str(p)]
            try:
                return mod.main(), None
            except SystemExit as e:
                return e.code, None
            finally:
                sys.argv = argv
        finally:
            mod.load_audit = original


def audit(vulns: dict) -> dict:
    return {"metadata": {"vulnerabilities": {"total": len(vulns)}},
            "vulnerabilities": vulns}


class NpmAuditGateTests(unittest.TestCase):
    def test_committed_baseline_passes_current_debt(self):
        real = json.loads((ROOT / "docs/audits/evidence/npm-audit-after.json").read_text())
        code, _ = run(real, "blocking")
        self.assertEqual(code, 0, "the triaged 2026-11-03 debt must not fail the gate")

    def test_new_critical_advisory_fails_blocking(self):
        a = audit({"brand-new-pkg": {"severity": "critical", "range": ">=1.0.0",
                                     "fixAvailable": False}})
        code, _ = run(a, "blocking")
        self.assertEqual(code, 1)

    def test_new_critical_advisory_is_report_only_in_advisory_mode(self):
        a = audit({"brand-new-pkg": {"severity": "critical", "range": ">=1.0.0",
                                     "fixAvailable": False}})
        code, _ = run(a, "advisory")
        self.assertEqual(code, 0)

    def test_new_low_advisory_does_not_gate(self):
        a = audit({"new-low": {"severity": "low", "range": "*", "fixAvailable": True}})
        code, _ = run(a, "blocking")
        self.assertEqual(code, 0)

    def test_baseline_only_contains_strings(self):
        names = mod.baseline_names()
        self.assertTrue(names)
        self.assertTrue(all(isinstance(n, str) for n in names))


if __name__ == "__main__":
    unittest.main()
