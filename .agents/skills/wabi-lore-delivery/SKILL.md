---
name: wabi-lore-delivery
description: Ship Wabi Lore across Git, Tim, and runtime.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [wabi, lore, deployment, testing, git]
    category: devops
    related_skills: [wabi-deploy, wabi-lore-coding-workspace]
---

# Wabi Lore Delivery Skill

Use this skill when a Wabi Lore change must become a reproducible testable state. It coordinates three truths: Wabi source in Git, the Wabi-on-Wabi Lore fixture on Tim, and the deployed Wabi runtime. It does not replace the deployment runbook or the Lore coding-workspace design skill; it supplies the delivery gate connecting them.

## When to Use

- Shipping a Lore frontend/backend change for browser testing.
- Adding or changing the canonical Wabi-on-Wabi test fixture.
- Verifying a deployed binary can read the Lore state it supports.
- Diagnosing a mismatch between Git, Lore revisions, and the live Wabi UI.

## Prerequisites

- Wabi checkout with `AGENTS.md`.
- Tim reachable as `tim@100.96.11.45`.
- Tim Lore CLI at `/home/tim/.local/bin/lore`, currently 0.8.6+373.
- Canonical smoke fixture currently lives in the native Lore repo attached to Wabi channel 2, but channel 2 is an audit fixture location, not a product constant. Resolve the actual Lore channel by name/wire id for every new demo or fixture operation; never hardcode `2`, `215`, `220`, or `225` in product code.
- Read the protected/user-owned `wabi-deploy` skill for the full live audit and binary-swap runbook; do not edit it autonomously.

## How to Run

1. Inspect `git status` and isolate exact Lore files; never stage peer-session or noise files.
2. Run frontend static build and relevant Rust checks.
3. Commit and push the exact Wabi Git change.
4. If fixture state changed, resolve the target Lore channel by its actual Wabi channel wire id/name, copy only fixture files to that tree, stage explicit paths with the real Lore CLI, and commit using an explicit identity.
5. If runtime code/frontend assets changed, deploy the release binary using the audited WabiDB swap procedure.
6. Verify all layers and update the Lore master kanban.

## Quick Reference

Canonical fixture:

```text
tests/fixtures/lore-meta/
├── README.md
├── .wabiignore
├── src/hello.rs
├── docs/design-notes.md
└── assets/test.svg
```

Tim path: `~/Desktop/Wabi/lore-data/2`

Lore commit:

```bash
cd ~/Desktop/Wabi/lore-data/2
/home/tim/.local/bin/lore status --scan
/home/tim/.local/bin/lore stage README.md .wabiignore src/hello.rs docs/design-notes.md assets/test.svg
/home/tim/.local/bin/lore commit \
  "Initial Wabi-on-Wabi Lore smoke-test fixture" \
  --identity "Wabi Test Fixture <wabi-test@localhost>" \
  --local --non-interactive
/home/tim/.local/bin/lore status --revision-only --no-pager
/home/tim/.local/bin/lore history --no-pager
```

Runtime build gate:

```bash
rm -rf frontend/build frontend/.svelte-kit
cd frontend && STATIC_BUILD=1 bun run build
cd ..
cargo build --release -p wabi-server --features addons
```

## Procedure

### Git truth

Stage exact paths only. Run `git diff --cached --check`, commit descriptively, and push. If unrelated dirty files exist, leave them untouched and report them; do not stash silently.

### Lore truth

The fixture is not ready merely because its directory exists. Verify a non-zero revision and history. Set an explicit identity when the repo lacks one. Do not stage `.lore/` internal metadata or invent a Lore commit if the CLI is unavailable.

For fixture-only changes, Git + Lore commit is complete; rebuilding the Wabi binary is unnecessary because runtime code did not change. State this explicitly.

### Binary/frontend delivery

For code/frontend changes, use the static build and `--features addons`. Ship the bind-mounted binary to `~/Desktop/Wabi/target/release/wabi-server.new`, then stop, clear both locks, replace, and recreate:

```bash
docker compose stop wabi-server
rm -f data/wabi-server/.lock data/wabi-server/wabidb/.lock
mv target/release/wabi-server.new target/release/wabi-server
chmod +x target/release/wabi-server
docker rm -f wabi-server || true
docker compose up -d wabi-server
```

### Rehydration check

Lore startup rehydration is asynchronous. The call to `load_existing_repos(...)` must be awaited. Treat an `unused_must_use` warning there as a correctness defect: without the await, WDB metadata is not restored and stale-tree filtering does not execute.

After restart, inspect logs for `Rehydrated N Lore repo(s) from WDB` and `Skipping stale Lore repo registration`.

### Live verification

```bash
sha256sum ~/Desktop/Wabi/target/release/wabi-server
curl http://127.0.0.1:3001/health
curl http://127.0.0.1:8088/health
curl https://wabi.chat/health
curl -I https://wabi.chat/
```

The public root should be 200 and `index.html` should be `cache-control: no-cache`. A healthy API alone does not prove the embedded frontend is current.

## Pitfalls

- Do not confuse a WDB registration with a populated Lore repository. Inspect `.lore`, `.wabi-repo.json`, fixture files, and non-zero `lore history`.
- Numeric channel IDs are not necessarily sequential; inspect actual channel/persistent paths.
- Do not make Code silently switch the active chat channel merely to show the last Lore repo; remembering a repo and changing chat context are separate actions.
- Do not expose destructive repository deletion as a casual Code Settings button. Lifecycle belongs in explicit admin/channel management.
- Normalize API payloads at the client boundary. Lore branches may return strings or objects; normalize before `.name.startsWith(...)`.
- Cloudflare beacon CORS/SRI errors are analytics noise, not evidence Wabi failed.
- Peer sessions may modify unrelated files in the shared tree. Scope commits and deployments to intended Lore paths.
- Do not claim browser verification from a successful build; use the user's real browser.

## Verification

A delivery is complete only when:

- Git commit is present and pushed.
- Fixture state has a matching Lore revision/history entry.
- Runtime changes have a static build and release binary.
- Tim binary SHA matches the shipped binary.
- Container, Caddy, and public health checks pass.
- Startup logs show awaited Lore rehydration.
- User can hard-refresh and exercise the fixture in a real browser.

## References

- `references/wabi-on-wabi-delivery.md` — canonical fixture, triple-action examples, and verified Tim probes.
- `references/handshake-and-auth-verification.md` — feature-marker proof, live addon health, authorized repo probes, and guest-403 interpretation.
- Protected/user-owned `wabi-deploy` skill — full live-stack audit and deployment runbook; request curator adoption before modifying it.
- User-owned `wabi-lore-coding-workspace` skill — product destination and Lore architecture; do not autonomously patch it.
