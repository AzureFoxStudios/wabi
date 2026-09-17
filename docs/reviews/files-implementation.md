# GF07 Files implementation closure

Scope: `frontend/src/lib/components/FilesWorkspace.svelte`,
`frontend/src/lib/filesWorkspaceSession.ts`,
`frontend/src/lib/filesWorkspaceSession.test.ts`,
`frontend/scripts/files-workspace-regression.mjs`.
No shared APIs or other components were edited. No push/merge/deploy,
no accounts, no live browser/data/secrets.

## What changed

- Added `createFilesWorkspaceSession()` (`filesWorkspaceSession.ts`):
  per-mounted-instance stores for spaces/files/search/preview/uploads with
  captured scope (server/token/subject/account/generation/retirement plus
  channel) before every await and re-checks between continuations using the
  existing primitives (`authSessionGeneration`, `accountTokenSubject`,
  `captureGroupAccess` via injectable `captureAccess`, plus
  `onAuthSessionCleared`/`groupMembership.onContextChanged`/`onRevoked`).
  Same-account token refresh is tolerated; logout/account/server switches,
  revocation, preview close, and disposal retire the scope. Per-operation
  seq + key guards stop A-B-A resurrection. Object URLs are revoked on
  close/replace/retirement/disposal. Completed-but-retired uploads/downloads
  never mutate, toast, or download into the new scope.
- `loadSpaces` distinguishes absent repos (404/null) from errors, keeps
  partial spaces with a warning, reports total failure as an error, and
  resolves signed-out immediately instead of spinning.
- Search keeps partial results with a warning, separates no-match from
  failure, never rejects unhandled, and supports retry.
- Preview close bumps the preview generation so late bytes are dropped;
  text has a second fence after `blob.text()`.
- Uploads use stable unique ids (`createUploadJobId`, keyed by `job.id`),
  retain `error`/`conflict`/`cancelled` for explicit retry/dismiss (no 4s
  auto-prune), preserve acknowledged counts via `summarizeUploads`, surface
  409 as `conflict` without overwriting, respect `readOnly` (mirror), and
  keep the existing upload-then-reload contract without adding background
  sync.
- Rewired `FilesWorkspace.svelte` to real `currentChannel`/`channels`
  subscriptions (removing `$derived(get(...))`), one session per mount with
  disposal, and actionable Retry/Dismiss affordances for spaces/files/
  search/preview/uploads. Shell/channels/stubs untouched.

## Verification

- `npm exec --yes --package=bun@1.3.14 -- bun test src/lib/filesWorkspaceSession.test.ts`
- `npm exec --yes --package=bun@1.3.14 -- bun run check`
- `node scripts/files-workspace-regression.mjs` (static wiring guard)
- Results are recorded in the closing report, not here.

## Honest test boundaries

- Bun tests use injected deferred transports and recorder fakes (no
  network/DOM): they prove ownership/fencing, partial-result honesty,
  stable ids, retry/dismiss retention, conflict handling, revocation, and
  component wiring strings.
- They do not prove browser acceptance: real rendering, drag/drop bytes,
  image decoding, anchor downloads, Svelte effect timing, or live
  server/auth behavior still need a real browser/native pass (explicitly
  out of scope for this task).
