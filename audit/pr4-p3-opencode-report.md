# PR4 + P3 — Profile Overhaul & Mobile Responsive Polish — Report

Date: 2026-08-03
Scope: frontend only (`frontend/`). No `core/`, `src-tauri/`, `data/`, `docs/`,
`socket-types.ts`, or `ModelViewer3D.svelte` touched. No commit made.

## Verification (run from `frontend/`)

| Step              | Before                          | After                          |
|-------------------|---------------------------------|--------------------------------|
| `bun run check`   | 8 errors / 49 warnings / 37 files | 6 errors / 64 warnings / 36 files |
| `bun run build:only` | FAILED (ProfileSettingsTab `export let`) | ✓ builds |

Error breakdown:
- Before: 2 real errors + 6 pre-existing `bun:test`/`bun` "Cannot find module"
  noise. The 2 real errors were: (1) `ProfileSettingsTab.svelte` `export let` in
  runes mode; (2) `Settings.svelte:343` "Type 'number' is not assignable to type
  'never'" — a knock-on of the untyped prop.
- After: all 6 remaining errors are the pre-existing `bun:test`/`bun` module
  noise (unrelated, unchanged). No new type errors. Build compiles.
- Warning delta (+15) is entirely the benign Svelte 5 "`on:click` is deprecated"
  advisory, surfaced by the runes conversion of `ProfileSettingsTab.svelte`
  (its existing `on:click` handlers now warn in runes mode) plus the few new
  buttons added there. No `bun:test` errors were added.

## What was done

### PR4 — Profile overhaul

1. **`ProfileCard.svelte`** (sidebar self card)
   - Banner strip behind the avatar (`$currentUser.bannerUrl`, honoring
     `showBanner !== false` and the global "disable all banners" localStorage
     flag already used by ProfileSettingsTab).
   - Richer status/activity line under the handle: colored dot + label
     (Active/Away/Busy/Offline) + active custom-status preset text from
     `customStatusPresetsStore`.
   - Quick actions (shown when `sidebarWidth >= 170`, matching the existing
     Settings button gate): **Copy ID**, **Copy mention** (`@handle`), and
     **Share** (native `navigator.share` or clipboard fallback), alongside the
     existing Mute/Deafen/Settings. Kept the existing `export let sidebarWidth`
     and legacy `$:` code untouched (file stays in legacy mode — adding runes
     would have broken it).
   - Rationale for not putting Message/Voice/Video on the *self* card: those
     target another user and are no-ops for the current user. They already live
     on the richer popout (UserPopoutActions: Message / Voice / Video / Screen
     Share / Copy ID / Full profile), which opens on avatar tap. Together the
     card + popout cover the full requested action set.

2. **`ProfileSettingsTab.svelte`** (self-edit surface)
   - Fixed the build blocker: the file was in a broken hybrid state (Svelte 5
     runes from PR1/2/3 `$state` + legacy `export let` / `$:`). Converted the
     prop to `$props()`, converted every `$:` block to `$derived`/`$effect`, and
     promoted the plain `let` state to `$state`. New code uses runes.
   - Added **Profile Status** section (Active/Away/Busy picker, clears custom
     status preset, uses existing `updateProfile` client path).
   - Added **About Me / Bio** section (textarea + save via `updateProfile`,
     locally patches `$currentUser`).
   - Uses only backend-supported fields (`status`, `bio`); no backend change.

3. **Popout** — `UserPopout.svelte`/`UserPopoutImpl.svelte` were already rich
   (banner, avatar ring, status, role, bio, notes, member-since, last-message,
   connections, full action row). No changes required; it satisfies the
   "richer popout" deliverable and opens from the ProfileCard avatar tap.

### P3 — Mobile responsive polish

1. **Centralized breakpoint**
   - Added `--mobile-breakpoint: 768px` to `tokens.css` as the single source of
     truth for the value.
   - Created `src/styles/components/mobile-breakpoints.css` — ONE consolidated
     `@media (max-width: 768px)` block for the mobile chrome (app-container
     height, panel/backdrop overlays, bottom nav, grabber, safe-area, and the
     voice-channel strip's mobile layout).
   - Removed the duplicated `@media (max-width: 768px)` blocks from
     `main-layout-part2.css` (both of them — mobile chrome + voice strip) so the
     breakpoint is defined in exactly one place for the shared stylesheets.
   - Plain CSS cannot reference a custom property inside a media condition, so
     the *value* is centralized as the token and the *query* is written exactly
     once in the consolidated file (documented in-file). Feature-specific
     mobile blocks for other widgets (kanban, calendar, admin, etc.) were left
     co-located deliberately — physically merging them into one file would
     change CSS cascade order and risk visual regressions with no headless
     verification available.
   - Imported the new file in `styles.css` immediately after `main-layout.css`
     to preserve the original cascade position.

2. **Bottom-nav auto-hide fix** (`MainLayout.svelte` + `mobile-breakpoints.css`)
   - Root cause: `.mobile-bottom-nav` had no `:not(.visible)` hide rule and
     `.mobile-nav-grabber` was always `display: none`, so the nav was
     permanently on screen and could never "hide" to the grabber.
   - Fix: nav slides down out of view (`translateY(100%)`, `opacity: 0`,
     `pointer-events: none`) unless `.visible`; grabber pill is now shown
     whenever the nav is hidden; added a smooth transition.
   - Interaction reappear: nav now reveals on any content touchstart (guarded
     so touches already bailed out for buttons/inputs don't double-handle), on
     the grabber tap, and on the existing bottom swipe-up.
   - Initial state: nav starts visible on mobile mount, then auto-hides after
     the idle timeout.
   - `MOBILE_NAV_IDLE_HIDE_MS = 2200` unchanged (Ronin's value).

3. **z-index → tokens** (conservative, preserving resolved stacking order)
   - `mobile.css`: `z-index: 200` → `var(--z-dropdown)` (resolves to 200).
   - `sidebar-profile.css` (status popup): `z-index: 100` → `var(--z-sticky)`
     (resolves to 100).
   - `sidebar-core-part1.css`: `z-index: 100` → `var(--z-sticky)`.
   - Mobile nav/grabber/backdrop already use `--z-*` tokens.
   - Small local values (1/2/3/10/12/50, etc.) were intentionally left as-is:
     they sit inside local stacking contexts and there is no token that
     resolves to those numbers, so tokenizing them would alter stacking order
     (AGENTS.md: preserve current resolved behavior).

## Files changed (`git diff --name-only`)

- `frontend/src/lib/components/MainLayout.svelte`
- `frontend/src/lib/components/settings/ProfileSettingsTab.svelte`
- `frontend/src/lib/components/sidebar/ProfileCard.svelte`
- `frontend/src/styles/components/main-layout-part2.css`
- `frontend/src/styles/components/settings-profile.css`
- `frontend/src/styles/components/sidebar-core-part1.css`
- `frontend/src/styles/components/sidebar-profile.css`
- `frontend/src/styles/mobile.css`
- `frontend/src/styles/styles.css`
- `frontend/src/styles/tokens.css`
- `frontend/src/styles/components/mobile-breakpoints.css` (new)

## Notes / caveats
- No headless browser verification (per constraints). Visual check in a real
  browser/Tauri window recommended, especially: ProfileCard banner/activity
  line height (card now grows via `min-height`), mobile nav slide animation,
  and the initial nav reveal timing.
- `on:click` deprecation warnings in `ProfileSettingsTab.svelte` are
  pre-existing style; not converted to `onclick` to keep the diff focused.
