#!/usr/bin/env python3
"""The default `wabi-server` build must not link an optional add-on crate.

`core/crates/wabi-server/Cargo.toml` declares `default = []`: a plain
`cargo build -p wabi-server` is the lean core a prebuilt "core" download would
ship. That promise is easy to break by accident — making an `optional = true`
dependency unconditional, or adding a new add-on crate as a normal dependency,
compiles it into every build with no feature to detach it and no error anywhere.

This reads `cargo tree` (metadata only, no compilation) and fails when the
default feature set pulls in a crate under `core/addons/` that is not on the
known always-compiled list.

Run:  python3 scripts/check-default-build-addons.py
"""
from __future__ import annotations

import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Add-on crates that are deliberately compiled into every build and gated at
# runtime instead (docs/addons/ATTACH_DETACH.md). Adding a name here is a
# product decision — it means the crate ships in the lean core download — so it
# belongs in a PR that says why, not in a drive-by fix.
ALWAYS_COMPILED = {"wabi-tailcat"}

# Optional add-on crates. Each must be absent from the default tree and present
# when its feature is on, which is what makes `--features full` a real superset
# rather than a label.
FEATURE_CRATES = {
    "lore": {"wabi-lore"},
    "webhooks": {"wabi-webhooks"},
    "payments-rails": {
        "wabi-payments-crypto",
        "wabi-payments-eu",
        "wabi-payments-us",
    },
}


class TreeFailed(Exception):
    """`cargo tree` refused a feature set — usually a feature that is gone."""


def tree(features: str | None) -> set[str]:
    """Crate names in wabi-server's normal dependency tree for a feature set."""
    command = [
        "cargo",
        "tree",
        "--locked",
        "-p",
        "wabi-server",
        "-e",
        "normal",
        "--prefix",
        "none",
    ]
    if features:
        command += ["--features", features]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        raise TreeFailed(
            f"cargo tree --features {features or '(default)'} failed: "
            + (result.stderr.strip().splitlines() or ["no output"])[0]
        )
    names = set()
    for line in result.stdout.splitlines():
        match = re.match(r"^([A-Za-z0-9_-]+) v", line.strip())
        if match:
            names.add(match.group(1))
    return names


def addon_crate_names() -> set[str]:
    """Every crate that lives under core/addons/."""
    names = set()
    for manifest in (ROOT / "core" / "addons").glob("**/Cargo.toml"):
        for line in manifest.read_text(encoding="utf-8").splitlines():
            match = re.match(r'^\s*name\s*=\s*"([^"]+)"', line)
            if match:
                names.add(match.group(1))
                break
    return names


def main() -> int:
    addons = addon_crate_names()
    failures: list[str] = []
    try:
        default = tree(None)
    except TreeFailed as error:
        print(f"Default-build add-on check FAILED:\n  - {error}", file=sys.stderr)
        return 1

    linked = sorted((default & addons) - ALWAYS_COMPILED)
    if linked:
        failures.append(
            "the default build links optional add-on crates: "
            + ", ".join(linked)
            + "\n  Make them `optional = true` with a cargo feature, or say why "
            "they are always compiled in docs/addons/ATTACH_DETACH.md and add "
            "them to ALWAYS_COMPILED here."
        )

    for name in sorted(ALWAYS_COMPILED):
        if name not in default:
            failures.append(
                f"{name} is listed as always compiled but the default build "
                "does not link it; update ALWAYS_COMPILED and the docs together."
            )

    for feature, crates in FEATURE_CRATES.items():
        present = crates & default
        if present:
            failures.append(
                f"{', '.join(sorted(present))} should need `--features {feature}` "
                "but is in the default tree."
            )
        try:
            missing = crates - tree(feature)
        except TreeFailed as error:
            failures.append(str(error))
            continue
        if missing:
            failures.append(
                f"`--features {feature}` did not attach {', '.join(sorted(missing))}."
            )

    full: set[str] = set()
    try:
        full = tree("full")
        for feature, crates in FEATURE_CRATES.items():
            missing = crates - full
            if missing:
                failures.append(
                    "`--features full` must be a superset of every optional "
                    f"add-on, but it is missing {', '.join(sorted(missing))}."
                )
    except TreeFailed as error:
        failures.append(str(error))

    if failures:
        print("Default-build add-on check FAILED:", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1

    print(
        f"default build links {len(default)} crates, "
        f"no optional add-on among them (always compiled: "
        f"{', '.join(sorted(ALWAYS_COMPILED))}); "
        f"--features full links {len(full)}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
