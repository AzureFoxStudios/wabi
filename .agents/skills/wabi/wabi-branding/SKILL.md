---
name: wabi-branding
description: Wabi self-hostable login and boot branding. Use when a self-hosted Wabi needs a custom server brand, alternate login theme, boot splash, or new launch-page config. Covers `Login.svelte`, `LaunchPanel.svelte`, boot shell mechanics, branding config, and how to add a non-default theme without deleting the default.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [wabi, branding, login, boot, selfhost, svelte, rust-embed]
---

# Wabi Branding

## Files you will touch

- `frontend/src/lib/components/Login.svelte`
- `frontend/src/lib/components/login/LaunchPanel.svelte`
- `frontend/src/lib/components/loginHelpers.ts`
- `frontend/src/routes/+page.svelte`
- `frontend/src/app.html`
- `core/crates/wabi-server/src/api/public.rs`
- `shared/launchPageContracts.ts`

## Safety rule — NEVER delete default branding

Keep the existing `Wabi` default as the no-config fallback. Do NOT remove `/wabi-logo.webp`, the `'Wabi'` title fallback, or default login CSS.

## How defaults currently resolve

- `/api/public/launch-page` is populated from Rust `load_frontend_metadata_policy()` reading `admin_policies.json` `frontend_app_metadata`.
- Identity fields (`displayName`, `iconUrl`, `bannerUrl`, `accentColor`, `description`, `tagline`, `brandProfile`) are always served for boot + login chrome.
- `enabled` is **not** “has a logo.” It is true only when the host authored a launch *story*: `launchPageEnabled`, `headline`/`heroTitle`, CTA, highlights, or custom CSS.
- A banner alone becomes `backgroundImageUrl` (login atmosphere). It must not open `LaunchPanel`.
- Invert `filter: invert(1)` is only for the stock black Wabi mark (`wabi-logo.webp` / `icon.png`). Host logos stay as uploaded.
- Frontend falls back when fields missing/empty.
- This is single-profile by default; adding custom branding should introduce a `brandProfile` selector rather than only swapping images.

## Discovery step (required)

Before changing files, read:
1. `frontend/src/lib/components/Login.svelte` (brand panel, `activeLaunchPageConfig`)
2. `frontend/src/lib/components/login/LaunchPanel.svelte` (theme surface)
3. `frontend/src/lib/components/login.css`
4. `frontend/src/app.html`
5. `frontend/src/routes/+page.svelte`
6. `core/crates/wabi-server/src/api/public.rs` → `get_launch_page(...)`
7. `shared/launchPageContracts.ts`
8. `shared/adminPolicyContracts.ts` if extending metadata shape

## Design rule for alternate themes

Preferred pattern: profile-first, not image-folder-first.

- Brand bundles are TypeScript modules exporting a complete `BrandProfile` from `frontend/branding/<id>.ts`.
- Defaults are encoded in `frontend/branding/default.ts`, so missing config never regresses.
- Admin selects a profile via stored metadata, e.g. `frontend_app_metadata.brandProfile = 'sabi'`.
- A runtime resolver in `frontend/src/lib/branding.ts` exposes `activeBrand`, `authBrand`, `bootConfig`, and `injectCustomCss()`.
- Assets can still live under `frontend/static/brand/<id>/` for logo/banner/hero, but the identity is driven by the profile module, not folder existence.

This keeps each theme:
- self-host friendly: copy one `.ts` file + optional assets folder
- non-destructive: default branch stays intact
- decoupled from hard-coded `LaunchPanel` assumptions

## Boot screen mechanics (current — 2026-08-06)

- Boot shell is **`#wabi-boot-shell` in `frontend/src/app.html`** — **not** Launch panel.
- Hidden by `window.__hideWabiBootShell()` / `wabi:boot-hide`. Crash before hide sticks the splash.
- **Early brand:** head reads `localStorage wabi.savedServers.v1` → `__WABI_BOOT_BRAND__`; body applies via `__applyWabiBootBrand`.
- **Hide Wabi:** saved-server `useNeutralBranding` + Server Switcher edit checkbox; generic mark + empty title. Preserve flag on `recordSuccessfulServerConnection`.
- Soft breathe (not hard bounce); `--boot-accent`; `data-boot-brand=wabi|neutral|custom|pending`.
- **Anti-flicker:** no default logo src; hide until `data-boot-ready`; lock after first apply so layout cannot overwrite custom/neutral with bare Wabi. Layout onMount: `injectNeutralBranding` only.
- Full recipe: `references/boot-shell-rebrand-2026-08-06.md` + `references/boot-shell-flicker-lock-2026-08-06.md`.

## Step-by-step implementation

1. Make a new Sabi bookkeeping entry in `admin_policies.json` or keep a frontend-only override.
2. Add Sabi assets under `/brand/sabi/*` if needed for images.
3. Add a `brandProfile` selector in frontend and backend:
   - Frontend loads brand through `frontend/src/lib/branding.ts`.
   - Backend reads `admin_policies.json` `frontend_app_metadata.brandProfile`.
   - If unset/unknown → use default.
4. Theme through a wrapper class or CSS vars on the login shell and boot shell:
   - Example: `login-shell[data-brand=\"sabi\"]` and `[data-brand=\"default\"]`.
   - Prefer `data-brand` + scoped class names over global `.launch-brand` mutations.
5. Animate boot shell into Sabi vibe:
   - Add `BootScreen.svelte` component mounted ahead of login.
   - Use Svelte transitions + small keyframed animation; never block `wabi:boot-hide`.
6. Verify both paths:
   - `brandProfile=default` or unset → old login unchanged.
   - `brandProfile=sabi` → Sabi boot + Sabi login panel + Sabi palette/CSS/copy.

## Pitfalls

- **Boot shell is sticky.** If your boot component crashes, the user is stuck on the boot overlay.
- **Do not hard-wire branding into `Login.svelte` scope only.** Use `activeBrand` plus `bootConfig`, with shared palette/CSS injection.
- **`launchCustomCss` from backend is untrusted** — escape/sanitize before inserting. Avoid classname collisions by namespacing theme rules (`sabi-*`).
- **adapter-static is required for Rust embed.** Treat build mode as gospel.
- **Skia font issue in headless Chromium.** Boot/login rendering changes must be verified in a real browser, not headless.
- **Existing Sabi naming must not leak `wabi` copy.** Replace hard-coded `'Wabi'` strings only in the Sabi bundle, keep default branch intact.
- **Profile resolver uses current backend config.** Cache invalidation: if metadata is updated, re-fetch launch-page/public metadata and reactive-bind rather than memoizing forever.

## Wabi-deploy-debug relationship

All deploy/runtime/boot mechanics live in `wabi-deploy-debug`. This skill only covers the visual brand layer above the deploy layer.

## Reference files

- `references/sabi-branding-theme.md` — original Sabi theme example/assets.
- `references/profile-first-branding-reference.md` — current canonical pattern using `frontend/branding/<id>.ts`, backend `brandProfile`, `frontend/src/lib/branding.ts`, and `BootScreen` event contract.
- `references/boot-shell-rebrand-2026-08-06.md` — **shipped** boot redesign, early localStorage brand, hide-Wabi toggle, naming table (boot ≠ launch).
- `references/boot-shell-flicker-lock-2026-08-06.md` — anti-flicker lock + ready reveal; layout must not call bare `applyBranding(Wabi)`.
- `references/about-tab-brandable-2026-08-06.md` — About tab pulls logo/description/footer from brand config for host rebrand.

## Plan document reference

Session plan for the profile-first implementation is at: `docs/sabi-branding-plan.md`
