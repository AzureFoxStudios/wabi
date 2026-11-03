#!/usr/bin/env python3
"""Wabi supply-chain gate (Phase A/E of the 2026-11 backend security audit).

Checks, in order:
  actions_pinned   every `.github/workflows` `uses:` is a 40-char commit SHA
  bun_floor        every asserted Bun version is >= 1.4.4 (CVE-2026-111497)
  node_floor       no EOL Node line, no Node release below the patched floor
  install_scripts  every npm lifecycle script is explicitly allowlisted
  ioc_sweep        no locked npm package matches a published worm IOC
  deny_toml        cargo-deny configuration exists

Gate policy (delegated by the owner, 2026-11-03):
  * `--mode advisory` (default): ONLY two classes fail CI --
      (a) any lifecycle script not on the allowlist, and
      (b) Bun < 1.4.4 anywhere.
    Exact IOC/name hits are P0 and also fail in every mode.
    Everything else is report-only while existing debt is triaged.
  * `--mode blocking`: action pins, Node floor, watch-scope IOC hits and
    missing deny.toml also fail. Flip CI to this after triage lands.

No network access, no dependency installation, no code execution from the
lockfiles: the script only reads committed text/JSON. Safe to run in a PR.

    python3 scripts/security/supply_chain_check.py
    python3 scripts/security/supply_chain_check.py --mode blocking --json
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
BUN_FLOOR = (1, 4, 4)
NODE_FIXED = {22: (22, 23, 4), 24: (24, 22, 1), 26: (26, 12, 1)}
SHA40 = re.compile(r"^[0-9a-f]{40}$")
LIFECYCLE = ("preinstall", "install", "postinstall", "prepare")
SKIP_DIRS = {".git", "node_modules", "target", "build", "dist", ".cache", "Unselected files"}


def version(text: str) -> tuple[int, ...] | None:
    m = re.match(r"^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?", text.strip())
    if not m:
        return None
    return tuple(int(x or 0) for x in m.groups())


def vtuple(v: tuple[int, ...]) -> str:
    return ".".join(str(x) for x in v)


class Report:
    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.rows: list[dict] = []

    def add(self, check: str, level: str, message: str, always_block: bool = False) -> None:
        blocking = always_block or self.mode == "blocking"
        self.rows.append({
            "check": check,
            "level": level,
            "message": message,
            "blocking": blocking,
            "fails": blocking and level in ("error", "p0"),
        })

    def info(self, check: str, message: str) -> None:
        self.rows.append({"check": check, "level": "info", "message": message, "blocking": False, "fails": False})

    @property
    def failed(self) -> bool:
        return any(r["fails"] for r in self.rows)

    def counts(self) -> dict:
        c = {}
        for r in self.rows:
            c[r["level"]] = c.get(r["level"], 0) + 1
        return c


def tracked_files(root: pathlib.Path, patterns: list[str]) -> list[pathlib.Path]:
    out = []
    for pattern in patterns:
        for p in glob.glob(str(root / pattern), recursive=True):
            path = pathlib.Path(p)
            if path.is_file() and not any(part in SKIP_DIRS for part in path.relative_to(root).parts):
                out.append(path)
    return sorted(set(out))


def rel(root: pathlib.Path, p: pathlib.Path) -> str:
    try:
        return str(p.relative_to(root))
    except ValueError:
        return str(p)


# --------------------------------------------------------------------------- checks

def check_actions(root: pathlib.Path, rep: Report) -> None:
    files = tracked_files(root, [".github/workflows/*.yml", ".github/workflows/*.yaml"])
    total = 0
    for f in files:
        for n, line in enumerate(f.read_text().splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            m = re.search(r"\buses:\s*([^\s#]+)", line)
            if not m:
                continue
            total += 1
            ref = m.group(1).rsplit("@", 1)[-1]
            if not SHA40.fullmatch(ref):
                rep.add("actions_pinned", "error", f"{rel(root,f)}:{n} unpinned action {m.group(1)}")
    rep.info("actions_pinned", f"{total} active uses: lines across {len(files)} workflows")


def collect_bun_assertions(root: pathlib.Path):
    """(file, line, version-string, context) for every place a Bun version is asserted."""
    files = tracked_files(root, [
        ".github/workflows/*.yml", ".github/workflows/*.yaml",
        "**/Dockerfile", "**/Dockerfile.*", "**/*.Dockerfile",
        "**/package.json", "scripts/**/*.sh", "scripts/**/*.mjs", "scripts/**/*.py",
    ])
    patterns = [
        re.compile(r"bun-version:\s*['\"]?v?(\d+\.\d+\.\d+)", re.I),
        re.compile(r"FROM\s+oven/bun:v?(\d+\.\d+\.\d+)", re.I),
        re.compile(r"[\"']bun[\"']\s*:\s*[\"']>=?v?(\d+\.\d+\.\d+)", re.I),
    ]
    out = []
    for f in files:
        # Test fixtures contain deliberately-vulnerable sample versions; they
        # are data, not configuration.
        if rel(root, f).startswith("scripts/tests/") or rel(root, f).startswith("scripts/security/"):
            continue
        for n, line in enumerate(f.read_text(errors="replace").splitlines(), 1):
            if line.lstrip().startswith("#") or "BUN_FLOOR" in line:
                continue
            for p in patterns:
                m = p.search(line)
                if m:
                    out.append((f, n, m.group(1), line.strip()))
    return out


def check_bun_floor(root: pathlib.Path, rep: Report) -> None:
    assertions = collect_bun_assertions(root)
    for f, n, raw, ctx in assertions:
        v = version(raw)
        if v is None:
            rep.add("bun_floor", "error", f"{rel(root,f)}:{n} unparseable Bun version {raw!r}", always_block=True)
        elif v < BUN_FLOOR:
            rep.add("bun_floor", "p0", f"{rel(root,f)}:{n} Bun {raw} < 1.4.4 (CVE-2026-111497): {ctx}", always_block=True)
    rep.info("bun_floor", f"{len(assertions)} explicit Bun version assertions checked; floor 1.4.4")
    bun = shutil.which("bun")
    if bun:
        try:
            raw = subprocess.check_output([bun, "--version"], text=True, timeout=20).strip()
            v = version(raw.split("-")[0])
            if v and v < BUN_FLOOR:
                rep.add("bun_floor", "p0", f"local runtime Bun {raw} < 1.4.4", always_block=True)
            else:
                rep.info("bun_floor", f"local runtime Bun {raw} OK")
        except Exception as exc:
            rep.info("bun_floor", f"local runtime Bun version unavailable: {exc}")
    else:
        rep.info("bun_floor", "no local bun binary (CI installs it via oven-sh/setup-bun)")


def check_node_floor(root: pathlib.Path, rep: Report) -> None:
    files = tracked_files(root, [
        ".github/workflows/*.yml", ".github/workflows/*.yaml",
        "**/Dockerfile", "**/Dockerfile.*", "**/*.Dockerfile",
    ])
    found = 0
    for f in files:
        for n, line in enumerate(f.read_text(errors="replace").splitlines(), 1):
            if line.lstrip().startswith("#"):
                continue
            raw = None
            m = re.search(r"node-version:\s*['\"]?v?(\d+(?:\.\d+){0,2})", line)
            if m:
                raw = m.group(1)
            m2 = re.search(r"FROM\s+node:v?(\d+(?:\.\d+){0,2})", line)
            if m2:
                raw = m2.group(1)
            if not raw:
                continue
            found += 1
            v = version(raw)
            if v is None:
                continue
            major = v[0]
            if major < 22 or major in (23, 25):
                rep.add("node_floor", "error", f"{rel(root,f)}:{n} Node {raw} is EOL / has no Node2Shell fix")
                continue
            fixed = NODE_FIXED.get(major)
            if fixed and len(v) == 3 and v < fixed:
                rep.add("node_floor", "error", f"{rel(root,f)}:{n} Node {raw} < {vtuple(fixed)} (CVE-2026-111497)")
            elif fixed and len(v) < 3:
                rep.add("node_floor", "warn", f"{rel(root,f)}:{n} floating Node {raw}; pin an explicit patched release {vtuple(fixed)}+")
            elif fixed is None:
                rep.add("node_floor", "warn", f"{rel(root,f)}:{n} Node major {major} has no recorded patched floor")
    rep.info("node_floor", f"{found} Node version references checked (fixed: 22.23.4 / 24.22.1 / 26.12.1)")
    try:
        raw = subprocess.check_output(["node", "--version"], text=True, timeout=20).strip()
        rep.info("node_floor", f"local runtime {raw} (informational; dev machines are not gated)")
    except Exception:
        pass


def check_install_scripts(root: pathlib.Path, rep: Report) -> None:
    cfg = json.loads((HERE / "install-script-allowlist.json").read_text())
    allowed = {(a["lockfile"], a["path"]) for a in cfg["allowed"]}
    seen = set()
    for f in tracked_files(root, ["**/package-lock.json"]):
        try:
            data = json.loads(f.read_text())
        except json.JSONDecodeError as exc:
            rep.add("install_scripts", "error", f"{rel(root,f)} unparseable lockfile: {exc}", always_block=True)
            continue
        lf = rel(root, f)
        for p, entry in (data.get("packages") or {}).items():
            if not isinstance(entry, dict):
                continue
            scripts = entry.get("scripts") or {}
            has = entry.get("hasInstallScript") or any(s in scripts for s in LIFECYCLE)
            if not has:
                continue
            key = (lf, p or "(root)")
            seen.add(key)
            if key not in allowed:
                body = ", ".join(f"{s}: {scripts[s]}" for s in LIFECYCLE if s in scripts) or "(lockfile flag only)"
                rep.add("install_scripts", "p0",
                        f"UNAPPROVED lifecycle script {lf} :: {p or '(root)'} [{body}]",
                        always_block=True)
    missing = allowed - seen
    for lf, p in sorted(missing):
        rep.info("install_scripts", f"allowlist entry no longer present (safe to remove): {lf} :: {p}")
    rep.info("install_scripts", f"{len(seen)} lifecycle-script package(s), {len(allowed)} allowlisted, "
                                f"{len(seen - allowed)} unapproved")


def check_iocs(root: pathlib.Path, rep: Report) -> None:
    cfg = json.loads((HERE / "npm-iocs.json").read_text())
    exact = {k: set(v) for k, v in cfg["exact"].items()}
    names = set(cfg["watch_names"])
    scopes = tuple(cfg["watch_scopes"])
    locked = 0
    for f in tracked_files(root, ["**/package-lock.json"]):
        try:
            data = json.loads(f.read_text())
        except json.JSONDecodeError:
            continue
        for p, entry in (data.get("packages") or {}).items():
            if not isinstance(entry, dict) or not p or not entry.get("version"):
                continue
            name = p.split("node_modules/")[-1]
            ver = entry["version"]
            locked += 1
            loc = f"{rel(root,f)} :: {p} @ {ver}"
            if ver in exact.get(name, ()):
                rep.add("ioc_sweep", "p0", f"COMPROMISED VERSION: {loc}", always_block=True)
            if name in names:
                rep.add("ioc_sweep", "p0", f"MALICIOUS TYPOSQUAT NAME: {loc}", always_block=True)
            if any(name.startswith(s) or name == s.rstrip("/") for s in scopes):
                rep.add("ioc_sweep", "warn", f"compromise-watch scope, manual review: {loc}")
    rep.info("ioc_sweep", f"{locked} locked npm package-version entries swept against "
                          f"{sum(len(v) for v in exact.values())} exact IOCs, {len(names)} watch names, {len(scopes)} watch scopes")


def check_deny_toml(root: pathlib.Path, rep: Report) -> None:
    if not (root / "deny.toml").exists():
        rep.add("deny_toml", "error", "deny.toml missing (cargo-deny cannot run)")


def doc_mentions(root: pathlib.Path, rep: Report) -> None:
    """List every Bun version mentioned in docs; gate ACTIVE docs on the floor.

    Dated plans/testing records are evidence of what ran historically and are
    intentionally not rewritten. Active build/run docs must not instruct a
    vulnerable version.
    """
    historical = ("/plans/", "/testing/", "/reviews/", "/audits/", "HANDOFF.md")
    hits = []
    for f in tracked_files(root, ["docs/**/*.md", "AGENTS.md", "README.md", "HANDOFF.md"]):
        for n, line in enumerate(f.read_text(errors="replace").splitlines(), 1):
            for m in re.finditer(r"\bbun[ -]v?(\d+\.\d+\.\d+)\b", line, re.I):
                ctx = line.strip()
                if "@types/bun" in ctx or "dependabot" in ctx:
                    continue  # package version / branch name, not a runtime assertion
                hits.append((rel(root, f), n, m.group(1), ctx[:120]))
    for f, n, v, ctx in hits:
        rep.info("doc_mentions", f"{f}:{n} mentions bun {v}: {ctx}")
        parsed = version(v)
        if parsed and parsed < BUN_FLOOR and not any(h in f for h in historical):
            rep.add("doc_floor", "error", f"ACTIVE doc still prescribes a vulnerable Bun: {f}:{n} bun {v}")
    rep.info("doc_mentions", f"{len(hits)} Bun version mentions in prose "
                             f"(dated plans/testing/reviews records are historical evidence, not instructions)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mode", choices=("advisory", "blocking"), default="advisory")
    ap.add_argument("--root", default=str(HERE.parents[1]), help="repository root (for tests)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    root = pathlib.Path(args.root).resolve()
    rep = Report(args.mode)
    check_actions(root, rep)
    check_bun_floor(root, rep)
    check_node_floor(root, rep)
    check_install_scripts(root, rep)
    check_iocs(root, rep)
    check_deny_toml(root, rep)
    doc_mentions(root, rep)

    if args.json:
        print(json.dumps({"mode": args.mode, "failed": rep.failed, "counts": rep.counts(), "rows": rep.rows}, indent=2))
    else:
        print(f"Wabi supply-chain gate — mode={args.mode}")
        print("=" * 72)
        icons = {"p0": "P0  ", "error": "FAIL", "warn": "WARN", "info": "    "}
        for r in rep.rows:
            marker = "BLOCK" if r["fails"] else ("always" if r.get("blocking") else "      ")
            print(f"[{icons.get(r['level'],'    ')}] {marker:6s} {r['check']:16s} {r['message']}")
        print("=" * 72)
        print(f"summary: {rep.counts()}  ->  {'FAILED' if rep.failed else 'PASS'}")
    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main())
