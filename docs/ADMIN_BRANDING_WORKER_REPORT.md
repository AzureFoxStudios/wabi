# Worker A — Admin Branding Upload Fix (Icon + Banner)

Workdir: /var/home/Ronin/wabi
Plan: docs/plans/2026-07-15-admin-hard-design-pass.md (B1)

## Summary

Both verified bugs are fixed. The frontend now actually uploads the selected
file, and the backend now exposes an authenticated simple multipart image
upload endpoint that the frontend was already posting to.

## Backend

**File:** `core/crates/wabi-server/src/api/upload.rs`

- Added `POST /api/upload` (mounted as `"/"` inside the `/upload` router, so it
  resolves to `/api/upload`) that accepts a multipart `file` field.
- Auth: requires `AuthUser` (Bearer JWT) and rejects guests, mirroring the
  security posture of other protected admin/auth endpoints.
- Validation:
  - Allowed content types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`
    (also accepts these by file extension when no content type is supplied).
  - Max size 10 MB (`SIMPLE_UPLOAD_MAX_BYTES`).
  - Files are written to the configured `uploads_dir` (same dir used by
    group-avatar / profile-picture) under a UUID + safe extension.
- Response: `{ "fileUrl": "/uploads/<uuid>.<ext>" }`, matching the shape the
  frontend reads (`payload.fileUrl`).
- Mirrors `upload_group_avatar` / `upload_profile_picture` storage + logging
  patterns. The uploads dir is created if missing.

**File:** `core/crates/wabi-server/src/api/routes.rs`

- No change required: `/api/upload` is served by the existing
  `.nest("/upload", upload::routes(...))`.

## Frontend

**File:** `frontend/src/lib/components/admin/FrontendMetadataPanel.svelte`

- Replaced the misused `onTriggerUpload` prop with
  `onUploadAsset: (target: 'icon' | 'banner', event: Event) => void`.
- The hidden file inputs' `on:change` now call
  `onUploadAsset('icon', event)` / `onUploadAsset('banner', event)` — so the
  selected file is actually handed to the upload handler (previously
  `onTriggerUpload` only re-clicked an unbound parent input and never uploaded).
- Buttons are retained as clickable dropzones that still click the local
  `iconInput` / `bannerInput`. Added drag-and-drop affordance (drag-over
  highlight) using Wabi design tokens; the zone also opens the native picker on
  click / Enter / Space, so it is fully functional even where drop is not used.
- Live preview thumbnail shows the current draft icon/banner inside the zone.

**File:** `frontend/src/lib/components/AdminWorkspace.svelte`

- Passes `onUploadAsset={uploadFrontendMetadataAsset}` to `FrontendMetadataPanel`
  in both the `all` and `branding` sections.
- Removed the dead `frontendIconInput` / `frontendBannerInput` refs and the
  now-unused `triggerFrontendMetadataUpload` function.
- `uploadFrontendMetadataAsset` (already present) performs the real `POST
  /api/upload` with the Bearer token, validates type/size, updates the draft
  `iconUrl`/`bannerUrl`, and shows save status — no change needed to its logic.

**File:** `frontend/src/styles/components/admin-center-stage.css`

- Added branded dropzone styles (`.frontend-metadata-dropzone`, icon square +
  banner wide previews, drag-over state) using Wabi tokens. Did not override the
  global `.frontend-metadata-upload-row` rule to avoid a cascade conflict with
  `admin-tab.css`; instead size the dropzones within the existing flex row.

## Verification

- `cargo check -p wabi-server` — passes (only pre-existing dead-code warnings).
- `bun run check` — no new errors introduced by these changes. The 6 remaining
  errors are pre-existing in `AdminTab.svelte` (`UserStatus` comparison type
  mismatches) and are unrelated to this task. `FrontendMetadataPanel.svelte`
  emits only a pre-existing unused-export warning.

## Out of scope

No commits, no unrelated admin redesign, no calling/other worker changes.
