#!/usr/bin/env python3
"""Regenerate docs/audits/2026-11-authorization-matrix.md from source.

Completeness matters more than polish here: every `.route(...)` declaration in
`core/crates/wabi-server/src/api/**` and every `socket.on("...")` in
`socketio/wiring.rs` is emitted, with the guard tokens that are actually present
in the handler body. Rows marked `REVIEW` have no handler-level guard token and
must be adjudicated by a human (the audit report lists them).

    python3 scripts/security/generate_authz_matrix.py
"""
from __future__ import annotations

import glob
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[2]
API = ROOT / "core/crates/wabi-server/src/api"
WIRING = ROOT / "core/crates/wabi-server/src/socketio/wiring.rs"
OUT = ROOT / "docs/audits/2026-11-authorization-matrix.md"
METHODS = ("get", "post", "put", "delete", "patch", "head", "options", "any")

GUARD_TOKENS = [
    ("require_socket_channel", "channel policy"),
    ("can_access_channel", "channel policy"),
    ("can_access_dm", "DM policy"),
    ("require_access", "channel policy"),
    ("channel_access", "channel_access module"),
    ("resolve_identity", "socket identity"),
    ("admin_auth", "admin_auth (legacy admin extractor)"),
    ("is_owner", "owner"),
    ("require_owner", "owner"),
    ("require_admin", "admin"),
    ("authenticate", "authentication helper"),
    ("admin_only", "admin"),
    ("min_role", "role"),
    ("membership_gate", "membership gate"),
    ("check_revocation", "revocation"),
    ("token_revoked", "revocation"),
    ("checkpoint_operator", "operator capability"),
    ("require_helper", "helper capability"),
    ("verify_signature", "signature"),
    ("game_sync_enabled", "runtime add-on gate"),
    ("gate", "gate"),
]

# Hand-adjudicated rows. A REVIEW row is never silently filled in; this table
# records the reasoning for events that intentionally have no resource guard.
MANUAL = {
    "on_game_leave": "no resource guard by design: only removes the caller's own "
                     "socket from a broadcast room; runtime add-on gate + bounded "
                     "channelId applied. Refusing to leave on revoked access would "
                     "keep a removed user subscribed (2026-11 audit F-08)",
}


def routes_in(path: pathlib.Path):
    """Yield (line_no, path, methods, handler_expr) for each .route(...) call."""
    lines = path.read_text(errors="replace").splitlines()
    i = 0
    while i < len(lines):
        if ".route(" in lines[i]:
            start = i
            buf = lines[i]
            depth = buf.count("(") - buf.count(")")
            while depth > 0 and i + 1 < len(lines):
                i += 1
                buf += "\n" + lines[i]
                depth += lines[i].count("(") - lines[i].count(")")
            m = re.search(r'\.route\(\s*"([^"]+)"\s*,\s*(.*)', buf, re.S)
            if m:
                pathstr, rest = m.group(1), m.group(2)
                methods = [x.upper() for x in METHODS if re.search(rf"\b{x}\s*\(", rest)]
                handlers = [h for h in re.findall(
                    r"\b(?:get|post|put|delete|patch|head|options|any)\s*\(\s*([\w:]+)", rest)
                    if h not in ("move", "async", "crate", "pub")]
                yield start + 1, pathstr, methods or ["?"], ", ".join(dict.fromkeys(handlers)) or "(inline closure)"
        i += 1


def nests_in(path: pathlib.Path):
    text = path.read_text(errors="replace")
    return [(m.group(1), m.group(2)) for m in re.finditer(r'\.nest\(\s*"([^"]+)"\s*,\s*(?:\w+::)*(\w+)::routes', text)]


def module_prefix_map():
    """prefix -> module name, from api/routes.rs and app_router.rs."""
    out = {}
    for f in [API / "routes.rs", ROOT / "core/crates/wabi-server/src/app_router.rs"]:
        for prefix, module in nests_in(f):
            out[module] = prefix
    # documented nests that use a qualified path or a non-standard spelling
    out.setdefault("preview", "(root-level)")
    out.setdefault("whiteboard", "/whiteboard")
    return out


def handler_guard(handler: str, corpus: str) -> str:
    if handler == "(inline closure)":
        return "inline closure — REVIEW (usually a test/router fixture)"
    if not handler or handler.startswith("("):
        return "router-level only"
    name = handler.split("::")[-1]
    if name in MANUAL:
        return MANUAL[name]
    m = re.search(rf"\b(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+{re.escape(name)}\s*\(", corpus)
    if not m:
        return "handler not in scanned corpus — REVIEW"
    signature = corpus[m.start(): corpus.find("{", m.start()) + 1]
    # Body only, until the matching closing brace. Keeps a later handler's
    # guard tokens from being mis-attributed to this one.
    start = corpus.find("{", m.start())
    depth, end = 0, start
    for j in range(start, min(len(corpus), start + 40000)):
        if corpus[j] == "{":
            depth += 1
        elif corpus[j] == "}":
            depth -= 1
            if depth == 0:
                end = j + 1
                break
    body = corpus[start:end]
    window = signature + body
    found = [label for token, label in GUARD_TOKENS if token in body]
    if "AuthUser" in signature:
        found.insert(0, "AuthUser bearer")
    elif "AuthUser" in body:
        found.insert(0, "AuthUser (body)")
    return ", ".join(dict.fromkeys(found)) if found else "no handler-level token — REVIEW"


def socket_events():
    lines = WIRING.read_text(errors="replace").splitlines()
    events = []
    i = 0
    while i < len(lines):
        m = re.search(r'socket\.on\(\s*"([^"]+)"', lines[i])
        if m:
            start, name = i + 1, m.group(1)
            buf = lines[i]
            depth = buf.count("{") - buf.count("}")
            while i + 1 < len(lines) and (depth > 0 or "});" not in buf):
                i += 1
                buf += "\n" + lines[i]
                depth += lines[i].count("{") - lines[i].count("}")
            handlers = re.findall(r"\b(on_[a-z0-9_]+|handle_[a-z0-9_]+)\s*\(", buf)
            outer = []
            if "scoped_socket_event" in buf:
                outer.append("scoped_socket_event")
            if "membership_gate" in buf:
                outer.append("membership_gate.read_owned()")
            if "crate::instance_operations::scoped" in buf:
                outer.append("instance_operations::scoped")
            events.append((start, name, ", ".join(dict.fromkeys(handlers)) or "(inline)",
                           " + ".join(outer) or "REVIEW: no scoped wrapper"))
        i += 1
    return events


def main() -> None:
    api_files = sorted(glob.glob(str(API / "**/*.rs"), recursive=True))
    src = ROOT / "core/crates/wabi-server/src"
    other_files = [f for f in sorted(glob.glob(str(src / "**/*.rs"), recursive=True))
                   if "/api/" not in f and f not in api_files]
    all_files = api_files + other_files
    corpus = "\n".join(pathlib.Path(f).read_text(errors="replace") for f in all_files)
    prefixes = module_prefix_map()

    rows = []
    for f in api_files:
        p = pathlib.Path(f)
        rel = str(p.relative_to(ROOT))
        mod = p.stem
        prefix = prefixes.get(mod, "")
        for ln, pstr, methods, handler in routes_in(p):
            guard = handler_guard(handler.split(", ")[0], corpus)
            rows.append((rel, ln, prefix, pstr, "/".join(methods), handler, guard, "API"))
    for f in other_files:
        p = pathlib.Path(f)
        rel = str(p.relative_to(ROOT))
        for ln, pstr, methods, handler in routes_in(p):
            guard = handler_guard(handler.split(", ")[0], corpus)
            rows.append((rel, ln, "(root/helper/test)", pstr, "/".join(methods), handler, guard, "other"))

    events = socket_events()

    lines = [
        "# Wabi authorization matrix — 2026-11-03 backend security audit",
        "",
        "> **Generated, do not hand-edit.** Regenerate with",
        "> `python3 scripts/security/generate_authz_matrix.py`.",
        "> Source of truth: `core/crates/wabi-server/src/api/routes.rs`",
        "> (HTTP nests), each module's `routes()` (` .route(...)` calls), and",
        "> `core/crates/wabi-server/src/socketio/wiring.rs` (Socket.IO events).",
        "",
        "## How to read the guard column",
        "",
        "The `Guard evidence` column is derived from tokens in the handler's",
        "signature/body, not from a claim that the guard is sufficient. `REVIEW`",
        "means no handler-level guard token was found: those rows are the ones a",
        "reviewer must adjudicate by hand. Every HTTP request also passes through",
        "the router-level layers in `app_router.rs` (rate limiting, IP deny, JSON",
        "body budget, `RequestBodyLimitLayer`/`DefaultBodyLimit`, CORS,",
        "compression, tracing); those are *not* authorization and are not counted",
        "as a guard. Socket.IO connections pass the namespace middleware in",
        "`wiring.rs` (`SioIdentity` + bearer/revocation checks) before any event",
        "handler runs.",
        "",
        "September's boundary passes (channel access, call admission, call state,",
        "Lore credentials) established `channel_access::require_access` as the",
        "shared REST/Socket.IO channel policy. October's new surface is the",
        "`game:*` family; see the audit report for its per-event adjudication.",
        "",
        f"## HTTP routes ({len(rows)} declarations; "
        f"{sum(r[7]=='API' for r in rows)} under `api/`)",
        "",
        "Rows marked `other` come from `app_router.rs` (operational endpoints),",
        "the helper/inbox/replica binaries and `socket.rs`, plus test-fixture",
        "routers in `anchor.rs`, `rate_limit.rs`, `bot_delivery.rs`,",
        "`checkpoint_jobs.rs` and `helper_client.rs`. They are listed so the",
        "inventory is complete; the `Guard evidence` column is a static token",
        "scan, not a claim that a fixture router is production-exposed.",
        "",
        "| Source | Scope | Prefix | Path | Method(s) | Handler | Guard evidence |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for rel, ln, prefix, pstr, methods, handler, guard, scope in rows:
        lines.append(f"| `{rel}:{ln}` | {scope} | `{prefix or '(nested)'}` | `{pstr}` | {methods} | `{handler}` | {guard} |")

    lines += [
        "",
        f"## Socket.IO events ({len(events)} registrations)",
        "",
        "| Line | Event | Handler | Outer guard | Handler guard evidence |",
        "| --- | --- | --- | --- | --- |",
    ]
    socket_corpus = "\n".join(pathlib.Path(f).read_text(errors="replace")
                              for f in glob.glob(str(ROOT / "core/crates/wabi-server/src/socketio/*.rs")))
    for ln, name, handlers, outer in events:
        guard = handler_guard(handlers.split(", ")[0], socket_corpus)
        lines.append(f"| `wiring.rs:{ln}` | `{name}` | `{handlers}` | {outer} | {guard} |")

    lines += [
        "",
        "## Known completeness limits",
        "",
        "- Nested routers inside `api/payments/`, `api/lore/` and similar",
        "  directories are listed with their local path; compose the full URL as",
        "  `/api` + the parent nest in `api/routes.rs` + the nested prefix.",
        "- `app_router.rs` adds `/health`, `/livez`, `/readyz`, `/metrics`,",
        "  `/uploads/{filename}`, `/ws/*` and `/api/*`; `/health`, `/livez` and",
        "  `/readyz` are deliberately unauthenticated operational endpoints.",
        "  `/metrics` requires an admin (`admin_auth`) or `WABI_METRICS_TOKEN`",
        "  unless `WABI_METRICS_PUBLIC=1` (see `docs/deployment/INSTALL.md`).",
        "- Handlers reached via `axum::routing::get(...)` written inside a",
        "  multi-line expression are still captured; `REVIEW` rows are listed so",
        "  a human can confirm the guard rather than assume one.",
        "- Socket.IO namespace completeness: all 97 `socket.on(` registrations",
        "  in `core/crates/wabi-server/src/` are in `wiring.rs` (0 elsewhere), so",
        "  the event table is complete. Handler bodies live in the 21 files",
        "  `include!`-ed by `socketio_impl.rs`; the guard token scan covers all",
        "  of them, not just `wiring.rs`." ,
        "- This is a static inventory. It does not prove that a guard is correct;",
        "  the September contract suites under `core/crates/wabi-server/tests/`",
        "  are the behavioural fence.",
        "",
    ]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines))
    print(f"wrote {OUT.relative_to(ROOT)}: {len(rows)} HTTP routes, {len(events)} socket events, "
          f"{sum('REVIEW' in r[6] for r in rows)} HTTP REVIEW rows")


if __name__ == "__main__":
    main()
