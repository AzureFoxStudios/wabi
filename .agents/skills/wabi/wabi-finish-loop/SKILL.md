---
name: wabi-finish-loop
description: Run the Wabi website-finish implementation loop — Hermes captain + OpenCode DeepSeek-v4 workers, card cadence, free-model stall recovery, and Tim deploy batches. Use when Ronin asks to finish wabi.chat via the loop, burn SuperGrok/DeepSeek battery on DoD waves, or continue multi-card website polish without model-hopping.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [wabi, finish-loop, opencode, deepseek, deploy]
    related_skills: [wabi-deploy-debug, opencode, coding-agent-orchestration]
---

# Wabi website-finish loop

Class-level workflow for burning down `docs/plans/*website-finish*` (or equivalent DoD) on live `wabi.chat` / Tim.

## Roles (locked)

| Role | Who | Model |
|---|---|---|
| Captain | This Hermes session | SuperGrok / stable captain — diagnose, verify, deploy, finish stalled cards |
| Worker primary | OpenCode CLI | **`opencode/deepseek-v4-flash-free`** (Ronin confirmed more reliable than Laguna, 2026-08-02) |
| Worker backup | OpenCode CLI | **`opencode/deepseek-v4-flash-free`** (user: "backup should be deepseek") |

**Never** dispatch OpenCode Grok (`opencode/grok-4.5`, `grok-build-0.1`) for this loop. Zen Grok needs Zen billing; Ronin's SuperGrok is Hermes xAI OAuth and does **not** unlock OpenCode Zen Grok. User corrected 2026-07-23: use Laguna not Grok; backup DeepSeek free.

Smoke before first card (try primary, then backup):
```bash
# CAUTION: opencode free-tier can silently rate-limit — the model prints only the
# build banner and exits 0 with NO actual model response. A banner-only output is
# NOT a successful smoke test; the smoke prompt must return the literal string.
opencode run 'Respond with exactly: OPENCODE_SMOKE_OK' -m opencode/deepseek-v4-flash-free
# if fail / stall rate-limit: try -m opencode/laguna-s-2.1-free
# must print OPENCODE_SMOKE_OK (banner alone is not success)
```

NOTE: On Bazzite, the shell MOTD banner can flood worker stdout and cause
exit 143/SIGTERM before real work starts. Always use `pty=true` in the
Hermes terminal() call for the wrapper. Workers spend ~30s in MOTD before
reaching the real build banner. Deepseek smoke test may timeout on first
attempt (60-90s) but succeeds on retry.

## Full-loop cadence (user preference)

When Ronin says **full loop**, **stop checking in per chunk**, or **do all of the loop**:
1. Do **not** pause for multi-paragraph status after every card.
2. Chain: write card → dispatch DeepSeek → wait/plateau → verify → next card (or parallel non-overlapping surfaces).
3. Surface him only for blockers, real-browser checks, or batch deploy pulses.
4. Lead with plan once, then execute autonomously.

## Card dispatch

1. Prompts under `/tmp/wabi-loop/card-*.md` with allowed/forbidden paths, no commits, report path under `docs/plans/`.
2. Python `subprocess` so the prompt is a **positional** arg (not `-f` alone):
   ```python
   subprocess.Popen(['opencode','run', prompt, '-m','opencode/deepseek-v4-flash-free', '-f','docs/plans/...'], ...)
   ```
   Use `pty=true` in the Hermes `terminal()` call to avoid the Bazzite MOTD banner
   blocking the wrapped command (workers spend ~30s in MOTD before real work starts).
   Deepseek smoke test may timeout on first attempt (60–90s) but succeeds on retry.
   If deepseek unavailable, fall back to `opencode/laguna-s-2.1-free` (smoke-test it too).
3. One writer per file set. Captain may work **non-overlapping** modules while a worker runs.
4. Baseline `git status --short` before each dispatch.

## Free-model stall recovery

Laguna/free workers often plateau: log size frozen ≥5 min, PID still warm, handlers half-written, no report.
1. Kill by **exact PID** (`pgrep -af 'opencode run'`).
2. Harvest partial diffs; finish wire-ups in-session (captain).
3. Write the card report yourself if missing.
4. Common worker bugs to fix on harvest:
   - Invalid Svelte `$: items: Type[] = ...` → `$: items = (...) as Type[]`
   - ContextMenu uses `open` + `on:close`, not `onClose` prop
   - Handlers written but never bound to `on:contextmenu` / never rendered

Do not wait out a full free-model idle timeout hoping it resumes.

**Model preference (2026-08-02):** Ronin confirmed deepseek-v4-flash-free is "by far more reliable" than laguna-s-2.1-free (which he calls "Ling" and finds "maddening"). When dispatch is viable, use `opencode/deepseek-v4-flash-free` as primary worker; laguna only as fallback if deepseek unavailable. Smoke-test before dispatch.

**Model-down detection (2026-08-02):** When the entire opencode.ai free tier silently stops invoking the model — smoke test prints `> build · deepseek-v4-flash-free` with NO literal response, exits 0, and `opencode.log` shows `Unexpected server error` or `No payment method` — DO NOT retry dispatch. The free tier revokes ~90 min after initial availability. Switch to direct Hermes implementation. See `references/model-down-detection.md` (shared with opencode-dispatch skill).

## Design-polish multi-screen (OpenCode + Hermes)

When Ronin asks to comb the whole app (`audit/prompt-design-polish.md` / `dispatch-design-polish.py`):

1. **One screen per worker** (1 chat … 6 empty + separate login/hub). Parallel only on disjoint paths + separate logs.
2. **Worker = mechanical tokens only**; Hermes taste + bug review. Token compliance ≠ visual redesign — login can look "untouched" if LaunchPanel was zero-edited; say so.
3. Split design vs functional commits; `bun run check` stays at known baseline.
4. **Never stash-and-forget another session's crash fixes** for a "clean" design STATIC_BUILD — ships design without MessageContent/MessageList fixes → live SUBSCRIBE_FAIL / each_key_duplicate. Commit crash fixes before/with the design bake (`wabi-postdeploy-runtime` design-deploy stash cascade).

## Deploy batch (after FE/server cards)

Binary embeds SPA (working tree **is** the SPA source):
```bash
cd frontend && rm -rf build .svelte-kit && STATIC_BUILD=1 bun run build
# must see index.html + _app/ — not handler.js
cd .. && cargo build --release -p wabi-server
scp target/release/wabi-server root@100.96.11.45:/home/tim/Desktop/Wabi/target/release/wabi-server.new
# Tim: SHA match → stop → rm BOTH locks → mv .new → up -d
# Prove :3001 + :8088 health + public CSS hash
```
Never terser minify. Headless cannot verify UI — Ronin real browser + hard refresh.

Runtime footguns: **`wabi-deploy-debug`** / **`wabi-postdeploy-runtime`**. `wabi-deploy` is often user-owned — `hermes curator adopt wabi-deploy` before agent can patch it.

## Channel-type surfaces (recurring UX/API)

When finishing wiki/forum/gallery (not plain chat):
1. **No double chrome** — Chat already has the channel header. Do not stack SurfaceHeader with the same title + giant primary CTA. Compact toolbar row only (New page / New thread).
2. **Unique icons** — not all `#`. Sidebar + header: forum / wiki / gallery distinct glyphs.
3. **Create-channel** — Forum + Wiki must be enabled options (never greyed "coming soon" if backend kinds exist).
4. **Settings per kind** — ChannelSettingsModal must branch: wiki/forum/gallery get their own title + options; hide chat retention / spoiler / purge on non-chat kinds.
5. **API paths** — Wiki is `/api/wiki/{channelId}/pages` (NOT `/api/channels/.../wiki/pages`). Forum is `/api/forum/{channelId}/threads`. Albums `/api/albums`.
6. **Create-then-read race** — adapter `run()` must `barrier().wait_for(commit_seq)` after commit or create_album / create_forum_thread return 500 "created but not found in projection".

Detail: `references/channel-type-surfaces.md`.

## References
- `references/loop-playbook.md` — condensed checklist + model lock
- `references/channel-type-surfaces.md` — wiki/forum/gallery chrome, paths, projection barrier
- `references/silent-rate-limit-detection.md` — detecting banner-only silent rate-limit exits from opencode free-tier workers
