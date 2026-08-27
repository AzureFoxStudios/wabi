# Hermes after OpenCode UX revival exit

1. Path-scoped `git status` / `git diff` — never trust worker self-report alone.
2. **Taste-pass hierarchy** (not re-token): dual primaries? contextual New? full-bleed board? honest stats?
3. Fix dead primary CTAs left menu-only (Planner New split: primary = current view, caret = menu).
4. **Bearer redaction:** tools may print `Authorization: *** ${token}` even when file has `Bearer` — verify with base64/`ord` before rewriting.
5. **Concurrent wipe:** peers may restore host mid-pass; re-read host; if wiped use whole-file rewrite.
6. Worker scope drift: `git checkout --` out-of-scope paths before commit.
7. `bun run check` + `STATIC_BUILD=1 bun run build`.
8. Commit only allowed paths; reports under `docs/plans/`, never `/tmp`.

Planner contract + perf: skill `wabi-planner-workspace`.
