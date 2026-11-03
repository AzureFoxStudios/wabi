#!/usr/bin/env python3
"""Offline RustSec adjudication helper (2026-11-03 backend security audit).

Matches every package/version in every Cargo.lock in the repository against a
local clone of RustSec/advisory-db, with a conservative semver-range matcher.

    git clone --depth 1 https://github.com/RustSec/advisory-db.git /tmp/advisory-db
    python3 scripts/security/rustsec_report.py /tmp/advisory-db \
        --out docs/audits/evidence/rustsec-2026-11-03

This is a *triage aid*, not a replacement for `cargo audit`/`cargo deny`. The
audit report states which rows were independently adjudicated, and the CI
`supply-chain` job runs the real tools.
"""
from __future__ import annotations

import argparse
import glob
import json
import pathlib
import re
import sys

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None

ROOT = pathlib.Path(__file__).resolve().parents[2]


def vt(s: str):
    core = s.strip().lstrip("v")
    core = re.split(r"[-+]", core)[0]
    parts = core.split(".")
    out = []
    for p in parts[:3]:
        m = re.match(r"\d+", p)
        out.append(int(m.group()) if m else 0)
    while len(out) < 3:
        out.append(0)
    # pre-release sorts before its release
    pre = 1 if re.search(r"-", s.strip()) else 0
    return (tuple(out), pre)


def vcmp(a: str, b: str) -> int:
    va, pa = vt(a); vb, pb = vt(b)
    return (va > vb) - (va < vb) if va != vb else (pa > pb) - (pa < pb)


def satisfies(version: str, expr: str) -> bool:
    """Conservative semver: AND of comma-separated clauses, OR of || groups."""
    expr = expr.strip()
    if not expr or expr in ("*",):
        return True
    for group in expr.split("||"):
        clauses = [c.strip() for c in group.split(",") if c.strip()]
        if clauses and all(clause_match(version, c) for c in clauses):
            return True
    return False


def clause_match(v: str, c: str) -> bool:
    m = re.match(r"^(>=|<=|>|<|=|==|\^|~)?\s*([0-9][0-9A-Za-z.\-+*]*)$", c)
    if not m:
        return False
    op, target = m.group(1) or "=", m.group(2)
    if target.endswith(".*") or target.endswith("*"):
        base = target.rstrip(".*")
        b = vt(base)
        vv = vt(v)[0]
        n = len(base.split("."))
        same = tuple(vv[:n]) == b
        if op in (">=", ">", "^", "~"):
            return same or vv[:n] > b
        if op in ("<", "<="):
            return vv[:n] < b
        return same
    c = vcmp(v, target)
    return {
        ">=": c >= 0, ">": c > 0, "<=": c <= 0, "<": c < 0,
        "=": c == 0, "==": c == 0,
        "^": c >= 0 and vt(v)[0][0] == vt(target)[0][0],
        "~": c >= 0 and vt(v)[0][:2] == vt(target)[0][:2],
    }[op]


def parse_front_matter(text: str) -> dict:
    m = re.match(r"^```toml\s*\n(.*?)\n```", text, re.S)
    if not m:
        return {}
    if tomllib:
        return tomllib.loads(m.group(1))
    # minimal fallback
    d = {}
    for line in m.group(1).splitlines():
        mm = re.match(r'(\w+)\s*=\s*"([^"]*)"', line)
        if mm:
            d[mm.group(1)] = mm.group(2)
    return d


def parse_lock(path: pathlib.Path):
    txt = path.read_text(errors="replace")
    out = []
    for block in txt.split("[[package]]")[1:]:
        n = re.search(r'^name = "([^"]+)"', block, re.M)
        v = re.search(r'^version = "([^"]+)"', block, re.M)
        if n and v:
            out.append((n.group(1), v.group(1)))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("db", help="path to advisory-db clone")
    ap.add_argument("--out", default="docs/audits/evidence/rustsec-2026-11-03")
    ap.add_argument("--year", default="2026")
    args = ap.parse_args()
    db = pathlib.Path(args.db)
    if not db.is_dir():
        print(f"advisory-db not found: {db}", file=sys.stderr)
        return 2

    locks = sorted(glob.glob(str(ROOT / "**/Cargo.lock"), recursive=True))
    packages = {}
    for f in locks:
        rel = str(pathlib.Path(f).relative_to(ROOT))
        for name, ver in parse_lock(pathlib.Path(f)):
            packages.setdefault(name, {}).setdefault(ver, []).append(rel)

    advisories = []
    for f in sorted(glob.glob(str(db / "crates/**/*.md"), recursive=True)):
        p = pathlib.Path(f)
        if args.year not in p.stem:
            continue
        text = p.read_text(errors="replace")
        d = parse_front_matter(text)
        adv = d.get("advisory", {})
        versions = d.get("versions", {})
        pkg = adv.get("package")
        if not pkg or pkg not in packages:
            continue
        patched = versions.get("patched", []) or []
        unaffected = versions.get("unaffected", []) or []
        functions = d.get("affected", {}).get("functions", {})
        title = next((l.lstrip("# ").strip() for l in text.splitlines() if l.startswith("# ")), "")
        for ver in packages[pkg]:
            if any(satisfies(ver, r) for r in patched):
                continue
            if any(satisfies(ver, r) for r in unaffected):
                continue
            advisories.append({
                "id": adv.get("id", p.stem),
                "package": pkg,
                "version": ver,
                "locks": packages[pkg][ver],
                "date": str(adv.get("date", "")),
                "title": title,
                "informational": adv.get("informational", ""),
                "categories": adv.get("categories", []),
                "cvss": adv.get("cvss", ""),
                "aliases": adv.get("aliases", []),
                "patched": patched,
                "unaffected": unaffected,
                "affected_functions": list(functions.keys()),
                "advisory_file": str(p.relative_to(db)),
            })

    advisories.sort(key=lambda r: (r["package"], r["version"], r["id"]))
    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    (out.with_suffix(".json")).write_text(json.dumps({
        "generated": "2026-11-03",
        "advisory_db": str(db),
        "lockfiles": [str(pathlib.Path(f).relative_to(ROOT)) for f in locks],
        "matches": advisories,
    }, indent=2) + "\n")
    lines = [
        f"# RustSec offline matches — 2026-11-03",
        "",
        f"Advisory DB: `{db}` (cloned 2026-11-03).",
        f"Lockfiles scanned ({len(locks)}): " + ", ".join(f"`{pathlib.Path(f).relative_to(ROOT)}`" for f in locks),
        f"Potentially-affected package/version rows: **{len(advisories)}**.",
        "",
        "Conservative matcher: a row is listed when the locked version is in no",
        "`patched` and no `unaffected` range. Informational/unmaintained rows are",
        "included. `affected_functions` is the reachability hint used by the CVE",
        "register. This is NOT `cargo audit` output; CI runs the real tool.",
        "",
        "| ID | Package | Locked | Date | Info | CVSS | Patched | Title |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in advisories:
        patched = "; ".join(r["patched"]) or "—"
        title = (r["title"] or "").replace("|", "\\|")[:90]
        lines.append(f"| {r['id']} | `{r['package']}` | {r['version']} | {r['date']} "
                     f"| {r['informational'] or '-'} | {r['cvss'] or '-'} | `{patched}` | {title} |")
    lines.append("")
    out.with_suffix(".md").write_text("\n".join(lines))
    print(f"locks={len(locks)} packages={len(packages)} matches={len(advisories)}")
    print(f"wrote {out.with_suffix('.md').relative_to(ROOT)} and .json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
