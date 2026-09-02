# Policy System (Admin-Configurable Limits)

Wabi now uses a reusable policy mechanism for server-wide, owner/admin configurable limits.

## Purpose

Avoid one-off feature settings. New controls (upload/download/call/runtime) should be added as policies so the same storage, validation, and admin API surface can be reused.

## Storage

- Table: `app_settings`
- Key format: `policy:<policy_key>`
- Value: JSON payload for that policy

Current policy keys:

- `upload_limits`
- `download_limits` (framework-ready, not yet enforced in download paths)

## API

Admin-only endpoints:

- `GET /api/admin/policies/:key`
- `POST /api/admin/policies/:key`

Legacy compatibility endpoint still exists for upload limits:

- `GET /api/admin/upload-limits`
- `POST /api/admin/upload-limits`

## Policy Shape (example)

Both `upload_limits` and `download_limits` use:

- `perRoleBytes` for roles:
  - `new`
  - `trusted`
  - `moderator`
  - `admin`
  - `owner`
- Global cap field:
  - `globalUploadCapBytes` (upload policy)
  - `globalDownloadCapBytes` (download policy)

`null` means unlimited.

## Backend Extension Pattern

When adding a new policy:

1. Add policy type in `backend/src/server.ts`.
2. Add default config and sanitizer.
3. Register it in `POLICY_DEFINITIONS`.
4. Consume via `getPolicyValue('<key>')` in feature code.
5. Enforce in backend logic where applicable.

No new DB tables or bespoke admin endpoints are required.

## Frontend Extension Pattern

Use generic helpers in `frontend/src/lib/api.ts`:

- `getAdminPolicy<T>(token, key)`
- `saveAdminPolicy<T>(token, key, config)`

Feature-specific wrappers can remain for convenience.
