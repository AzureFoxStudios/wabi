---
name: wabi-server-rail-chrome
description: "ServerRail density, side, popout, logo, persistence."
version: 1.0.0
metadata:
  hermes:
    tags: [wabi, frontend, sveltekit, sidebar, rail, density, side]
    related_skills: [wabi-sidebar-channel-ia, wabi-sidebar-nav, wabi-frontend-architecture]
---

# Wabi ServerRail Chrome

## When to use

- Tune rail width/visibility (full / icons-only / hidden density states)
- Toggle rail side (left / right) for multi-monitor or right-hand use
- Flip folder popout direction when rail sits on the right
- Make the logo button go to a server hub (identity anchor)
- Persist rail chrome preferences to the backend

## Anatomy (verified 2026-08-20)

`ServerRail.svelte` is a **server switcher** — which community am I in. NOT a surface switcher (that lives in `WorkspaceViewBar` / `ChatHeader`). The two axes must NOT merge into one strip.

Top-to-bottom structure:
1. `.rail-home` — Wabi logo button (identity anchor, goes to hub or opens server switcher)
2. `.rail-divider` (desktop only)
3. `.rail-list` — `{#each $savedServerRailItems}`: saved servers + server folders with full drag-and-drop reorder, drop positions `'before' | 'after' | 'inside'` (inside → creates folder)
4. Bottom (desktop): gear → `centerPanelView.set('admin')`, `+` → opens server switcher

CSS lives in `frontend/src/styles/components/server-rail.css` (no `<style>` block in component).

## Density states (user-toggled, NOT hover-driven)

| State | Width | Behavior |
|-------|-------|----------|
| `full` (default) | 92px | icon + tooltip, server names in popout |
| `icons-only` | 48px | tooltips on hover, no labels — the daily driver |
| `hidden` | 0px | invisible; a thin 4px edge strip catches hover/swipe to reveal |

Hover-to-reject is wrong — it hides discoverability, breaks touch, triggers on mouse-accident. Discord's default is icons-only (always visible, compact).

CSS classes: `.density-full`, `.density-icons-only`, `.density-hidden`.

## Side placement (left OR right)

- Stored per-user in DB via `GET/PUT /api/user/layout` (key `railSide`).
- CSS class `.rail-right` flips `border-right` → `border-left`.
- **Folder popout must flip direction when side=right** — `.rail-right .folder-popout { left: auto; right: 100%; }` so the popout doesn't overflow off-screen.
- `.mobile-folder-tray` also flips.

## Logo anchor (identity, not surface toggle)

The logo is the identity anchor → should go to a server hub, not open a surface-switcher panel. Currently wired to `dispatch('manage')` (server switcher) until a center-stage hub view exists. The intent is "identity home," not "surface switch."

## Persistence

- Stores: `railDensity`, `railSide`, `railLayoutLoaded` in `layoutStoreStates.ts`.
- Module: `frontend/src/lib/railLayout.ts` — `loadRailLayout()` on mount, `persistRailLayout()` debounced on change.
- Backend: `GET/PUT /api/user/layout` endpoints in `core/crates/wabi-server/src/api/user.rs`. Validates JSON, allows only known keys (`layout`, `theme`, `railDensity`, `railSide`). Stored via `UserLayout` projection under index `user_layouts`.
- Default: `railDensity = 'full'`, `railSide = 'left'`.

## What to refuse

- **Surface icons in the rail** (Home, Chat, Calendar, Tasks, Files). These belong in `WorkspaceViewBar` / `ChatHeader` (center-stage workspace pills). Merging them into the rail creates semantic collision — the user can't tell if a click switches *community* or *view*.
- Hover-driven density reveal.
- Mobile density states (mobile keeps longpress/tray behavior).

## Overlap

- Channel ordering, DM sort, create-channel → `wabi-sidebar-channel-ia`
- Folders, Messages hub → `wabi-sidebar-nav`
- Surface routing, layout shell → `wabi-frontend-architecture`
