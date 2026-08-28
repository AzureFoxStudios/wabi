---
name: wabi-opencode-ux-revival
description: "Use when OpenCode does multi-phase Wabi UX revival."
version: 1.0.0
metadata:
  hermes:
    tags: [opencode, wabi, ux, dispatch]
    related_skills: [wabi-opencode-dispatch, wabi-planner-workspace]
---

# OpenCode multi-phase UX revival (Wabi)

Complements `wabi-opencode-dispatch`. Use for Planner/settings-class A–F passes.

## Dispatch

1. Smoke-test `opencode/deepseek-v4-flash-free` → literal `OPENCODE_SMOKE_OK`
2. Backup dirty tree outside repo
3. Prompt file under `audit/`; Python `subprocess.run([bin, "run", prompt, ...])` — never `$(cat)`
4. Attach critique plan + host + donor surfaces via `-f`
5. Background + notify; path-allowlist in prompt; no commit

## Hermes after exit

1. Path-scoped `git status` / `git diff` (never trust self-report alone)
2. Fix dead primary CTAs left menu-only (e.g. Planner **New** split: primary = current view, caret = menu)
3. **Bearer redaction pitfall:** tools may print `Authorization: *** ${token}` even when file has `Bearer`. Verify with base64/`ord` before rewriting
4. `bun run check` + `STATIC_BUILD=1 bun run build`
5. Commit only allowed paths; reports in `docs/plans/` not `/tmp`

## Planner-specific

Do not re-stub `PlannerWorkspace` after A–F. Contract: skill `wabi-planner-workspace`.
