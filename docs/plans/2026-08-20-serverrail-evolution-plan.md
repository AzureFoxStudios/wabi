# ServerRail Evolution — Implementation Plan

Source: `docs/plans/2026-08-18-bookmarks-sections.md` (Part C) + `docs/plans/2026-08-18-serverrail-evolution-brief.md`.

Decision: **Rail chrome only.** Surface icons stay in WorkspaceViewBar (no merge). Density states + side toggle + popout flip + logo→hub.

Backend infra already exists: `UserLayout` projection, `upsert_user_layout`, `get_user_layout`, `GET/PUT /api/user/layout` routes. `get_layout` currently returns null — needs wiring.

## Tasks

### 1. Backend — wire `get_layout`/`save_layout` to DB

File: `core/crates/wabi-server/src/api/user.rs:180-191`

- `get_layout`: replace the `null` return with a real `state.wdb.get_user_layout(auth.user_id as u64)` read. Return `{ layoutJson: "<json>", updatedAt: <micros> }` or `{ layoutJson: null, updatedAt: null }` on miss.
- `save_layout`: accept `{ layoutJson: String }`, call `state.wdb.upsert_user_layout(auth.user_id, &body.layoutJson)`. Validate it's valid JSON first. Return the stored value.
- The `LayoutsProjection` already applies `user_layout_upserted` and stores under index `user_layouts`. No projection changes needed.

### 2. Frontend — `railDensity` + `railSide` stores (DB-persistent)

File: `frontend/src/lib/layoutStoreStates.ts`

- Add `railDensity = writable<RailDensity>('full')` where `type RailDensity = 'full' | 'icons-only' | 'hidden'`.
- Add `railSide = writable<RailSide>('left')` where `type RailSide = 'left' | 'right'`.
- Add a `railLayoutLoaded = writable(false)` flag so the rail doesn't flash default before DB load.
- On app init (or first `ServerRail` mount): `GET /api/user/layout` → if `layoutJson` present, parse and apply `{ railDensity, railSide }`. Fall back to current defaults on miss.
- Persist: debounced `PUT /api/user/layout` with `{ layoutJson: JSON.stringify({ railDensity, railSide }) }` on change. Reuse the existing `save_theme` pattern (merge into the `layout` key of the stored JSON).

### 3. Frontend — `ServerRail.svelte` density + side + popout flip

File: `frontend/src/lib/components/ServerRail.svelte`

- **Density**:
  - `full` (default): current look — 92px, icon + tooltip, server names in popout.
  - `icons-only`: 48px wide, tooltips on hover, no labels. Server pills stay 56px but the rail shrinks.
  - `hidden`: 0px, invisible. A thin 4px edge strip (`.rail-edge-ghost`) at the viewport edge catches hover/swipe to reveal. Or a `[` / `]` toggle button in the top bar.
- **Side**:
  - `class:rail-right` on the `<aside>` when `railSide === 'right'`.
  - Flip `border-right` → `border-left` in CSS.
  - Folder popout: when side=right, `.folder-popout` opens to the **left** of the rail (currently opens right). Use a CSS class `.folder-popout--flip` or inline `left: auto; right: 100%`.
- **Logo → hub**: change the `.rail-home` button from `dispatch('manage')` (opens server switcher panel) to switching `centerPanelView` to a hub view. If no hub view exists yet, keep `dispatch('manage')` but rename the title to "Server hub" so the intent is clear. (Deferred — needs a center-stage hub view to be useful.)

### 4. Frontend — `server-rail.css` density + side states

File: `frontend/src/styles/components/server-rail.css`

- `.server-rail.density-icons-only` — width 48px, hide labels, tighten padding.
- `.server-rail.density-hidden` — width 0, overflow hidden, but `.rail-edge-ghost` visible (4px strip, hover expands).
- `.server-rail.rail-right` — `border-right` none, `border-left` solid.
- `.server-rail.rail-right .folder-popout` — `left: auto; right: 100%` (flip popout direction).
- `.server-rail.rail-right .mobile-folder-tray` — flip to left edge.

### 5. Frontend — settings UI for density + side

File: a settings section (likely `SettingsView.svelte` or a new `AppearanceSection.svelte`).

- Segmented control for density: Full / Icons-only / Hidden.
- Segmented control for side: Left / Right.
- Both write to the stores in task 2 (which persist to DB).

### 6. Verification

- `cargo check -p wabi-server` (backend).
- `npm run check` (frontend, svelte-check).
- Manual: toggle density → rail resizes. Toggle side → rail jumps to right, popout flips. Reload → state restored from DB.

## Out of scope

- Surface icons in rail (stay in WorkspaceViewBar).
- New center-stage hub view (logo→hub is a title change only until hub view exists).
- Mobile density states (mobile keeps current longpress/tray behavior).
