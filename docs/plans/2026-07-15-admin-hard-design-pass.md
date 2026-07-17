# Admin Hard Design Pass + Branding Fix + Right Panel Ops

> For Hermes/OpenCode. Build-verified only unless browser smoke noted.

**Date:** 2026-07-15  
**Goal:** Make admin usable and pretty (mock north star), fix broken branding uploads, give staff a right-panel ops surface, reserve center full-dashboard for intentional entry.

## Design law (non-negotiable)

```
LEFT  = navigate (admin sidebar OR chat server rail)
CENTER = primary work (chat OR full AdminCenterStage)
RIGHT = ambient ops for staff (channels/stats/mod tools) — NEVER admin form stacks
```

Full-screen admin dashboard = `centerPanelView === 'admin'` only.  
Right panel admin tab must NOT host AdminWorkspace forms.

## Verified bugs

### B1 — Branding Upload Icon/Banner broken (P0)
1. `FrontendMetadataPanel.svelte` file `on:change` calls `onTriggerUpload(target)` which is wired to `triggerFrontendMetadataUpload` — that only does `frontendIconInput?.click()` / banner click on **parent refs that are never bound**. Upload never runs with the selected file.
2. Even if fixed, `uploadFrontendMetadataAsset` POSTs to `${getServerUrl()}/api/upload` but backend only has:
   - `/api/upload/resumable/*`
   - `/api/upload/group-avatar`
   - `/api/upload-profile-picture`
   There is **no** simple `POST /api/upload`.

**Fix:**
- Panel: `on:change={(e) => onUploadAsset('icon', e)}` (and banner). Export prop `onUploadAsset`.
- Parent: pass `onUploadAsset={uploadFrontendMetadataAsset}`; remove dead `frontendIconInput` / trigger-only path (or keep click handlers only for button → file input inside panel).
- Backend: add `POST /api/upload` multipart simple image upload (like group-avatar): save under uploads, return `{ fileUrl }` absolute-or-root-relative path. Auth required.
- Frontend path resolution: ensure preview uses resolveFrontendMetadataAssetUrl against server base.

### B2 — Admin right panel is a stub (P0)
`AdminTab.svelte` only calls `showAdminCenterStage()` and shows a spinner. Staff who open right "Admin" get nothing useful and center takeover.

**Fix:**
- Replace AdminTab with **AdminOpsRail** (or rebuild AdminTab as right-rail only):
  - Header: role badge + **Open full dashboard** button → `layoutStore.showAdminCenterStage()`
  - Channel pulse: active channel name, member count if available, last activity if available
  - Server pulse: online users / total from `/api/admin/stats` (same as Overview)
  - Quick mods (mod+): search users, jump to user list in center, ban/kick only if APIs exist — if not, deep-link to center Users section
  - Channel list compact: text channels with unread/online hints if stores already have data (channelStore, users)
  - Payments status one-liner (enabled/disabled) for admin+
  - Do NOT embed RoleNamesPanel / RuntimeTuning / full forms

### B3 — Payments nav is too thin (P1)
Payments section is essentially two checkboxes + role toggles. User wants payment blocks on Overview + Server Policy.

**Fix:**
- Remove top-level `payments` nav item from AdminCenterStage (or hide when thin).
- Add payment enable/guest/roles summary card on **Overview**.
- Move full PaymentAccessPanel into **Server Policy** (settings section) as a sub-block.
- Keep payment user blocks on Users list (already partially there).

### B4 — Dashboard entry (P0)
Full dashboard should not be accidental right-tab takeover only.

**Entries:**
1. Right rail button: "Open full dashboard"
2. Settings → Admin → "Open Admin Dashboard" (if AdminSettingsTab exists)
3. URL hash or path query: support `#admin` or `?view=admin` on load (optional, small)
4. `/admin` if router supports — SvelteKit SPA may use hash; prefer `layoutStore.showAdminCenterStage()` from a command palette or ModeTabsDrawer admin item labeled "Dashboard"
5. Keep Back → chat

### B5 — Visual design pass (P1, mock recipe)
North star: `discord-clone-admin-dashboard-design(4).zip`  
Map to Wabi tokens (no hard mock orange as sole accent).

Apply to `admin-center-stage.css` + admin panels:
- 200px left nav, clear active state
- Card grid for overview (RingGauge/Card/Skeleton already under admin/ui)
- Mono micro-labels, denser but readable forms
- Branding panel: large drop zones for icon (square) + banner (wide), not plain dual buttons only
- Server policy: section cards with headers
- Remove cramped admin-tab form chrome for right rail (new compact CSS)

## Implementation tasks (bite-sized for workers)

### Worker A — Branding upload end-to-end (backend + panel wiring)
Allowed:
- `core/crates/wabi-server/src/api/upload.rs`
- `core/crates/wabi-server/src/api/routes.rs` if needed
- `frontend/src/lib/components/admin/FrontendMetadataPanel.svelte`
- `frontend/src/lib/components/AdminWorkspace.svelte` (upload handlers only)
- optional CSS for branding drop zones in admin CSS

Deliver: working upload icon/banner → fileUrl in draft → save still publishes.

### Worker B — Right ops rail + entry + payments rehome
Allowed:
- `frontend/src/lib/components/AdminTab.svelte` (rewrite as ops rail)
- `frontend/src/lib/components/AdminCenterStage.svelte` (nav: drop payments or fold)
- `frontend/src/lib/components/AdminWorkspace.svelte` (section routing for payments → settings/overview only)
- `frontend/src/lib/components/admin/OverviewSection.svelte` (payment summary card)
- `frontend/src/lib/components/admin/ServerPolicyPanel.svelte` or settings section composition
- `frontend/src/lib/layoutStore.ts` (entry helpers only)
- `frontend/src/lib/components/settings/AdminSettingsTab.svelte` (open dashboard button)
- `frontend/src/styles/components/admin-tab.css` (ops rail compact)
- `frontend/src/styles/components/admin-center-stage.css` (design polish)

Deliver:
- Right Admin tab = ops rail with stats/channels + Open dashboard
- Center = full dashboard
- Payments not a lonely nav; on overview + server policy
- CSS closer to mock without breaking tokens

## Forbidden
- Calling/media/socket core refactors
- WabiDB engine
- Full app redesign outside admin surfaces
- Commits
- Mock React port

## Verification
```bash
cd /var/home/Ronin/wabi && cargo check -p wabi-server
cd /var/home/Ronin/wabi/frontend && bun run check
```
Optional: curl POST upload with token after server running.

## Reports
- `docs/ADMIN_BRANDING_WORKER_REPORT.md`
- `docs/ADMIN_OPS_RAIL_WORKER_REPORT.md`
