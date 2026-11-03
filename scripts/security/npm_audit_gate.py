#!/usr/bin/env python3
"""Baseline-aware npm advisory gate (2026-11-03 audit, Phase E).

A blanket `npm audit --audit-level=high` would fail CI on the existing debt
recorded in docs/audits/2026-11-cve-register.md. This gate instead fails only
on *new* high/critical advisories that are not in the committed baseline, which
is exactly the "block future high/critical introductions" policy: existing debt
is graded, not hidden, and a newly introduced severe advisory stops the PR.

    # CI (blocking) - runs npm audit itself
    python3 scripts/security/npm_audit_gate.py --mode blocking

    # Offline / reproducibility - use a saved npm audit --json
    python3 scripts/security/npm_audit_gate.py --audit-json docs/audits/evidence/npm-audit-after.json

`--mode advisory` never exits non-zero. `--update-baseline` rewrites the
baseline from the current audit output (requires an explicit human decision;
the change is reviewable in git).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
BASELINE = HERE / "npm-audit-baseline.json"
FRONTEND = ROOT / "frontend"
GATING_SEVERITIES = {"high", "critical"}


def load_audit(path: str | None) -> dict:
    if path:
        return json.loads((ROOT / path).read_text())
    proc = subprocess.run(
        ["npm", "audit", "--json"],
        cwd=FRONTEND, capture_output=True, text=True, timeout=300,
    )
    # npm audit exits 1 when advisories exist; its JSON is still valid.
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"npm audit did not return JSON: {exc}\n{proc.stderr[:800]}")


def advisories(audit: dict) -> dict:
    return audit.get("vulnerabilities") or {}


def baseline_names() -> set[str]:
    data = json.loads(BASELINE.read_text())
    return {r["package"] for r in data.get("advisories", [])}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("advisory", "blocking"), default="blocking")
    ap.add_argument("--audit-json", help="repo-relative path to a saved `npm audit --json`")
    ap.add_argument("--update-baseline", action="store_true")
    args = ap.parse_args()

    audit = load_audit(args.audit_json)
    vulns = advisories(audit)
    sev = audit.get("metadata", {}).get("vulnerabilities", {})

    if args.update_baseline:
        rows = [{"package": n, "severity": v.get("severity"),
                 "range": v.get("range"), "fixAvailable": v.get("fixAvailable")}
                for n, v in sorted(vulns.items())]
        BASELINE.write_text(json.dumps({
            "generated": "2026-11-03",
            "source": args.audit_json or "live `npm audit --json` in frontend/",
            "policy": json.loads(BASELINE.read_text()).get("policy", ""),
            "advisories": rows,
        }, indent=2) + "\n")
        print(f"baseline rewritten: {len(rows)} advisories -> {BASELINE.relative_to(ROOT)}")
        return 0

    known = baseline_names()
    new_gating = sorted(
        n for n, v in vulns.items()
        if v.get("severity") in GATING_SEVERITIES and n not in known
    )
    resolved = sorted(n for n in known if n not in vulns)

    print(f"npm audit: {len(vulns)} advisories {sev}")
    print(f"baseline:  {len(known)} recorded packages -> {BASELINE.relative_to(ROOT)}")
    for n in resolved:
        print(f"  [resolved] {n} is no longer reported (baseline entry can be removed)")
    for n in new_gating:
        v = vulns[n]
        print(f"  [NEW {v.get('severity', '?').upper()}] {n}: range={v.get('range')} "
              f"fix={v.get('fixAvailable')}")
    if not new_gating:
        print("result: PASS - no new high/critical npm advisories")
        return 0
    if args.mode == "advisory":
        print(f"result: ADVISORY - {len(new_gating)} new high/critical advisories (not failing)")
        return 0
    print(f"result: FAIL - {len(new_gating)} new high/critical npm advisories")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
