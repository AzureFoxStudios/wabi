# Plan: Merge `wabi.chat/business` Into Main Wabi App

## Summary
Phase the existing standalone `/business` surface into the main app while preserving every current feature. No backend/DB changes required for v1; keep Business stored in `frontend/src/lib/business/*` and localStorage-backed.

## Success Criteria (v1)
- Business features are reachable from inside the main app.
- `/business` still works and renders the same surface.
- No view/feature removed: Calendar, Kanban, Projects, Journal, Tasks, guest access, import/export.
- Main app and Business can coexist without theme/CSS bleed.

---

## P1: First-Class Route + Surface Host
Goal: Business becomes a legitimate main-app surface, with `/business` as a stable redirect to it.

### Routing / Layout
- `frontend/src/routes/business/+page.svelte`
  - Extract the current “Business Hub” UI into a reusable `BusinessSurface.svelte`.
  - Keep `/business/+page.svelte` as a thin shell:
    - If route param/token matches Business, render `BusinessSurface` inside main layout.
    - If no admin route param, redirect `/business` → main app Business route after auth.

- `frontend/src/routes/+page.svelte`
  - Add an explicit Business route/surface in the main layout switch (`Route ${surface === 'business'}`).
  - Replace `Ctrl+Shift+1` hard navigation:
    - Before: `window.location.href = '/business'`
    - After: dispatch a layout/surface action to show Business in the main UI.

- `frontend/src/lib/components/MainLayout.svelte`
  - Add a top-level surface route binding: `BusinessSurface` renders when active mode is Business.
  - Ensure it receives existing auth context and panel host slots.

### Business Module Wiring
- `frontend/src/lib/business/store.ts`, `frontend/src/lib/business/state.ts`
  - Add an explicit init hook `initBusiness()` that begins before mount and once on load.
  - Keep `loadFromStorage()` + `saveToStorage()` as-is for v1; just ensure the module init is callable from the main app lifecycle.

- `frontend/src/lib/business/sync.ts`
  - Confirm lazy init via `requestIdleCallback` still works when Business loads inside main app (not just `/business`).
  - If needed, split init from idle-time registration so `setTimeout` fallback is uniform.

- `frontend/src/routes/business/+page.svelte`
  - Move mount-only logic (route state, guest checks, view switcher props) into `BusinessSurface.svelte`.
  - Keep `/business/+page.svelte` as redirect wrapper for P3.

---

## P2: Sidebar + Right Panel Anchors
Goal: Let users open Business inline without leaving chat context.

### Sidebar
- `frontend/src/lib/components/ChannelSidebar.svelte`
  - Add a Business app entry below/near Quick Resources.
  - Entry should toggle main surface to `business`, not navigate.

- `frontend/src/lib/components/ModeTabsDrawer.svelte`
  - Add Business as a mode tab if drawer supports persistent modes.

### Right Panel + Overlays
- `frontend/src/lib/components/RightPanel.svelte`
  - Allow Business to mount as a right-panel tab stack:
    - RightPanel host is already generic (it hosts things like QuickResourcesPanel).
    - Add slots: `calendar`, `kanban`, `tasks`, and a composite `business` tab that renders `BusinessSurface` as an overlay.
  - Resize behavior:
    - Business overlays should slide in with existing rail width behavior.
    - Preserve the drawer/tab stack UX.

- New optional host (only if needed):
  - `frontend/src/lib/components/BusinessOverlayHost.svelte`
  - Receives `currentView`, emits `toggleQuickStats`, `toggleChatSidepanel`.
  - Mounts inside `RightPanel.svelte` or as a surface wrapper when `surface === 'business'`.

### View Preservation
- Reuse existing components unchanged:
  - `frontend/src/lib/components/business/Calendar.svelte`
  - `frontend/src/lib/components/business/KanbanBoard.svelte`
  - `frontend/src/lib/components/business/ProjectsView.svelte`
  - `frontend/src/lib/components/business/DiaryView.svelte`
  - `frontend/src/lib/components/business/TaskPanel.svelte`
  - `frontend/src/lib/components/business/*Modal.svelte`
- Create `frontend/src/lib/components/business/QuickViewTabs.svelte`:
  - Tab shell: Calendar / Kanban / Tasks / Projects / Journal, view switcher, quick-stats toggle.
  - Used by both `/business` page and right-panel overlay.

---

## P3: Legacy `/business` Redirect + Removal Prep
Goal: Make `/business` a non-breaking alias that ultimately lands on the main route.

- `frontend/src/routes/business/+page.svelte`
  - Add canonical Business route in app layout (`/app/business` or main-mode route).
  - `/business` does 307 redirect from server when possible; otherwise client-side replacement to main route with `replaceState` to preserve history.

- Remove the “special legacy behavior” dependency on `/business`:
  - Ensure `guest` access path works whether user lands at `/business` or main route.

- Defer to P4:
  - Delete `frontend/src/routes/business/` directory once feature flag/monitoring shows zero `/business` direct traffic.

---

## P4: Cleanup
- Delete standalone `frontend/src/routes/business/` folder.
- Remove `/business` from any external nav/docs once confirmed unused by clients/bookmarks.
- Consolidate duplicate theme/CSS hacks.
- Finalize component exports from `frontend/src/lib/business/store.ts` for public package consumption.

---

## Theming / CSS Boundary
- Existing: `frontend/src/lib/business/theme.css`
- Risk: global CSS bleed from Business colors/spacing into chat, or chat resets clobbering Business.
- Plan:
  - Scope Business CSS with a wrapper class, e.g. `.business-surface`.
  - Prefix all Business CSS rules with `.business-surface`.
  - Keep Business module CSS imports localized inside `BusinessSurface.svelte` so they don’t apply in chat.
  - In main app, no business CSS imports outside `.business-surface` trees.

---

## Backend / API Surface
- v1: frontend-only merge. No server routes, DB schema changes, or backend persistence.
- Defer:
  - `shared/businessContracts.ts` versioning for APIs.
  - Real sync endpoints.
  - Auth/role gates around Business features.

---

## File-Level Change Map

| Layer | File | Change |
|---|---|---|
| Route shell | `frontend/src/routes/business/+page.svelte` | Redirect wrapper; Business moves to `BusinessSurface.svelte` |
| New surface | `frontend/src/lib/components/business/BusinessSurface.svelte` | Create reusable shell around existing hub |
| Main layout | `frontend/src/lib/components/MainLayout.svelte` | Add `business` surface binding |
| Root page | `frontend/src/routes/+page.svelte` | Replace `Ctrl+Shift+1` with surface dispatch |
| Sidebar | `frontend/src/lib/components/ChannelSidebar.svelte` | Add Business entry |
| Drawer | `frontend/src/lib/components/ModeTabsDrawer.svelte` | Optional Business mode tab |
| Right panel | `frontend/src/lib/components/RightPanel.svelte` | Add Business tab stack/overlay slots |
| Stores init | `frontend/src/lib/business/store.ts` + `state.ts` | Ensure init hook callable from main app |
| Sync lazy init | `frontend/src/lib/business/sync.ts` | Keep lifecycle-safe under main app mount |
| CSS scope | `frontend/src/lib/business/theme.css` | Prefix with `.business-surface` wrapper |
| Contracts (defer) | `shared/businessContracts.ts` | No v1 backend changes |

---

## Risks
- `localStorage`-only persistence:
  - Loss on client storage clear; corruption if quota exceeded.
- `localStorage` quota under large calendars:
  - Budget ~5 MB per origin; very large event sets will fail silently.
- Guest code path:
  - Guest pages bypass auth; when Business embeds in main layout, ensure guest state still initializes correctly.
- Performance:
  - load-mounted lazy sync must not block main app first paint; preserve `requestIdleCallback` timing.
- Mobile layout:
  - Right panel overlays must collapse or switch to full-screen sheet on narrow viewports.

---

## Deferred Items
- Real Odoo/Docs integration.
- Auth/role gates on Business features.
- Server-side persistence/backup.
