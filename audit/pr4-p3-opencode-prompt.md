# OpenCode Dispatch: PR4 + P3 — Profile Overhaul & Mobile Responsive Polish

## Goal
Implement two bounded frontend features in the Wabi SvelteKit project:
1. **PR4**: Profile overhaul — full profile surface + richer popout + self-profile editing
2. **P3**: Mobile responsive polish — consolidate scattered breakpoints, fix bottom nav auto-hide, overlay sheets, hardcoded z-indexes

## Scope: Files you MAY touch
- `frontend/src/lib/components/sidebar/ProfileCard.svelte` — enhance with banner overlay + status/activity + quick actions
- `frontend/src/lib/components/settings/ProfileSettingsTab.svelte` — self-profile editing surface
- `frontend/src/lib/components/profile/UserPopout.svelte` (or ProfileCard) — richer popout
- `frontend/src/styles/components/` — mobile breakpoints, bottom nav z-indexes
- `frontend/src/styles/` — add `768px` breakpoint consolidation
- `frontend/src/lib/components/ChatViewHeaderMobileNav.svelte` or equivalent mobile nav
- ANY `frontend/src/` file with `768px` media query or `MOBILE_NAV_IDLE_HIDE_MS`
- `frontend/src/lib/stores.ts` — mobile nav idle state if needed

## Scope: Files you MUST NOT touch
- `core/` Rust backend (no backend changes)
- `src-tauri/` (Tauri desktop backend)
- `data/` directory
- `docs/` directory
- `frontend/src/lib/components/plugins/ModelViewer3D.svelte` (just finished in S3)
- `frontend/src/lib/socket-types.ts` (just modified in H1c)

## CRITICAL INTERFACE NOTES

### Svelte 5 runes required
- Use `$props()`, `$derived`, `$effect` — NO `export let`, NO `$:` reactive statements
- This is a Svelte 5 runes project. If you see `export let foo`, leave it — don't convert existing code. Only new code uses runes.

### Mobile nav pattern
The bottom nav auto-hides after `MOBILE_NAV_IDLE_HIDE_MS` (user interaction idle). Find this constant and the nav component. Do NOT change the idle timeout value (Ronin set it). Fix: ensure the nav reappears on scroll/touch.

### Profile card pattern
ProfileCard.svelte is the sidebar user card. Enhance it to show:
- Banner image (top strip, behind avatar)
- Richer status/activity (online/AFK/dnd + custom status text)
- Quick action icons: Message / Voice / Video / Mention / Copy ID / Share
- Tap → opens richer popout

### Breakpoint consolidation
Grep ALL css files for `768px`, `768`, `@media`. There are ~28 instances across scattered files. Create ONE centralized mobile breakpoint in tokens.css (or a new `mobile-breakpoints.css`), and update the scattered files to reference the shared token. Do NOT leave duplicate inline `@media (max-width: 768px)` blocks.

## Verification Steps (run these yourself)
```
cd /var/home/Ronin/wabi/frontend
bun run check             # svelte-check typecheck — no new errors
bun run build:only        # vite build — must compile
```
- Report error count before/after.
- Report which files changed: `git diff --name-only`
- No new `bun:test` errors (pre-existing 6 are fine).

## Constraints
- NO headless browser verification (Skia crash issue — Ronin verifies in real browser)
- Write a brief report to `/var/home/Ronin/wabi/audit/pr4-p3-opencode-report.md`
- Do NOT commit unless Ronin explicitly says "commit"
- Do NOT touch Lore-related code (off-limits per boundary)
- Do NOT touch auth/login backend — B4 (prettifying login) is deferred to a later card

## What "Done" looks like
- PR4: ProfileCard has banner + status/activity + quick actions; ProfileSettingsTab has self-edit fields; popout is richer
- P3: Single `@media (max-width: 768px)` breakpoint token; mobile nav reappears on interaction; all z-indexes use `--z-*` tokens
