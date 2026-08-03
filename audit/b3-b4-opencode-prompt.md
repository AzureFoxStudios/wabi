# OpenCode Dispatch: B3 + B4 — Strip-Wabi Branding Option & Prettier Launch/Login

## Goal
Two bounded frontend-only features:
1. **B3 — Strip-Wabi option**: Add a neutral/non-branded default theme so communities can run fully neutral or fully custom. No hardcoded "Wabi" text, neutral icon, neutral palette.
2. **B4 — Prettier default launch/login**: Visual polish pass on the login/launch page (typography, spacing, hero section, button styling).

## Scope: Files you MAY touch
- `frontend/src/lib/branding.ts` — add a neutralBrandConfig + selector (B3)
- `frontend/src/lib/components/login/LaunchPanel.svelte` — polish (B4)
- `frontend/src/lib/components/login.css` — polish the 937-1059 "tight final login polish pass" block + add neutral theme overrides (B3 + B4)
- `frontend/src/styles/tokens.css` — add neutral palette CSS vars (B3)
- `frontend/src/lib/savedServers.ts` — add `useNeutralBranding?: boolean` to SavedServerConfig (B3)
- `frontend/src/lib/savedServerActions.ts` — read the neutral flag (B3)
- `frontend/src/lib/components/loginHelpers.ts` — inject neutral branding on launch (B3)
- `frontend/src/styles/styles.css` — import a new `neutral-branding.css` if needed (B3)

## Scope: Files you MUST NOT touch
- `core/` Rust backend
- `src-tauri/` Tauri backend
- `data/` directory
- `docs/` directory
- `frontend/src/lib/components/plugins/ModelViewer3D.svelte` (done in S3)
- `frontend/src/lib/socket-types.ts` (done in H1c)
- `frontend/src/lib/components/settings/ProfileSettingsTab.svelte` (done in PR4)
- `frontend/src/lib/components/sidebar/ProfileCard.svelte` (done in PR4)
- Anything in `wabi-protocol/` or `shared/`
- Any Lore-related code (off-limits)

## CRITICAL INTERFACE NOTES

### Svelte 5 runes
- Use `$props()`, `$derived`, `$effect`, `$state` — NO `export let`, NO `$:` reactive statements
- New code only; leave existing legacy code untouched if converting would break it

### B3: Neutral branding approach
- Add `neutralBrandConfig` to `branding.ts` — same interface as `BrandConfig`, but: `name: ''`, `shortName: ''`, `logoUrl: ''` (or a generic icon), neutral palette (grays), no domain name in text
- Add a `useNeutralBranding` boolean to `SavedServerConfig` in `savedServers.ts`
- In `loginHelpers.ts`, when `useNeutralBranding` is true, swap `brandConfig` to `neutralBrandConfig`
- Add neutral palette CSS vars in `tokens.css` (e.g., `--neutral-accent`, `--neutral-muted`, `--neutral-surface`)
- The launch page should still work with a generic logo (not "Wabi" text)

### B4: Login polish approach
- Improve typography hierarchy (heading sizes, font weights, line-height)
- Tighten spacing/padding on the auth form
- Polish button styles (primary CTA, secondary, ghost)
- Ensure responsive between the 769px media query and mobile (937-1059 block)
- Use existing design tokens from tokens.css (`--surface-*`, `--accent-*`, `--text-*`, `--radius-*`)
- The login.css already imports from tokens; extend, don't override destructively

### Breakpoint
The `768px` breakpoint was centralized in PR4/P3. Do NOT re-add scattered `@media (max-width: 768px)` blocks. Reference `--mobile-breakpoint` token instead.

## Verification Steps (run these yourself)
```
cd /var/home/Ronin/wabi/frontend
bun run check       # no new errors (pre-existing 6 bun:test noise OK)
bun run build:only  # must compile
```
- Report error count before/after
- Report which files changed: `git diff --name-only`
- No new `bun:test` errors

## Constraints
- NO headless browser verification (Skia crash issue)
- Write a brief report to `audit/b3-b4-opencode-report.md`
- Do NOT commit unless Ronin explicitly says "commit"
- Do NOT touch Lore-related code

## What "Done" looks like
- B3: `neutralBrandConfig` + `useNeutralBranding` flag + neutral palette CSS vars; launch page works with generic branding (no hardcoded "Wabi")
- B4: Login/launch page has improved typography, spacing, button styles; builds clean
