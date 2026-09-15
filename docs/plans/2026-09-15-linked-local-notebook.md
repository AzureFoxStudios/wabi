# Safe linked local Notes — implementation design

**Date:** 2026-09-15

**Status:** implementation-ready design; the notebook migration/linking is not yet implemented

**Parent:** [Production finish campaign](2026-09-15-production-finish-campaign.md), N01–N05

## Product contract

Notes is a device-local notebook owned by one server/account scope. It supports titled Markdown notes, search, links/backlinks, contextual DM notes, a useful scratchpad, deletion recovery and portable exports. It works offline after storage is available. It does not silently synchronize through the server or merge independent accounts.

Users must be able to answer: where is this writing stored, has it saved, what happens if another editor changes it, and how do I take it with me?

## Decisions

| Concern | Decision |
| --- | --- |
| Persistence | A dedicated transactional IndexedDB notebook; no false-success localStorage fallback. |
| Owner identity | Existing normalized server endpoint + stable stored account ID, captured with auth session generation. |
| Guest/offline use | Separate explicit session/device scopes; never a shared global `anon` bucket or automatic account merge. |
| Note identity | Stable UUID independent of title, list position, converted URL or UI mount. |
| Concurrent writes | Per-record revision check inside the write transaction; retain stale drafts as conflict copies or offer explicit comparison. |
| Cross-window state | Shared per-scope service in one realm; BroadcastChannel/storage notifications trigger rereads across realms. Transactions arbitrate writes. |
| Deletion | Persisted trash with restore; no automatic trash expiry in the pilot. Permanent deletion is a separate explicit action. |
| Scratchpad | One persistent note in the same notebook. Full opens that exact record. New scratchpad creates a new note. |
| DM notes | Contextual view in the owner's notebook with the conversation visibly labeled; still personal local writing. |
| Profile annotations | Separately scoped owner/subject metadata, outside the notebook graph and default export. |
| Links | `[[Title]]` and `[[Title|label]]`; stable ID indexes; unique normalized notebook titles and transactional rename updates. |
| Reader | “Open a copy in Reader,” with stable source identity and return-to-note; no implicit write-back ownership. |
| Export | Versioned JSON backup preserving metadata/IDs/trash, and a readable Markdown export with portable relative links. |

## Storage design

Suggested database name: `wabi-local-notes`. Use an explicit database version and per-record schema version. Create/extend object stores and indexes additively; never delete an existing store merely because a version changed.

| Store | Primary identity | Contents |
| --- | --- | --- |
| `notes` | `[scopeId, noteId]` | Title, Markdown body, context, revision, timestamps, pin/color, trash state and schema version. |
| `links` | Scope + source/target note identity | Derived outgoing/incoming links; missing-target references remain explicit. |
| `recovery` | Recovery ID | Original legacy bytes, invalid imports, recoverable conflicts and provenance. |
| `migrationReceipts` | Legacy-source fingerprint | The explicit destination scope and successful import version/checkpoint. |
| `profileNotes` | `[ownerScopeId, subjectAccountId]` | Personal annotation, revision and update time. |

Use existing server normalization; do not lowercase case-sensitive endpoint paths. Reuse stable account/session primitives from the current auth implementation. The browser WabiDB facade's CRUD methods are currently scaffolds; its working outbound-queue database is a separate responsibility.

Reader provides useful revision/save/broadcast patterns, but copy only verified behavior. Its existing upgrade callback and non-atomic localStorage fallback need separate review under campaign T03.

### Save operation

Capture `{scopeId, sessionGeneration, noteId, baseRevision}` with the draft. A transaction reads the record, checks the revision and owner, updates the note and derived links, then completes. Only transaction completion produces “Saved on this device.”

If the revision changed, retain the user's draft and show a recoverable conflict. Do not silently rebase an obsolete draft over a newer save, rename, trash action or replacement account. Changing scope retires its visible editors and callbacks; it does not delete durable local records.

Broadcast a committed identity/revision after success. Other editors reread the record, refreshing clean views and flagging conflicts for dirty drafts. BroadcastChannel is a notification mechanism, not a distributed lock.

Failure states: saving, saved, could not save, storage unavailable/blocked, conflict and recovering. Failed writes retain the draft and provide Retry and Download. Async teardown must not discard uncommitted writing or report success after scope retirement.

If both the notebook and recovery stores are unavailable, retain the draft in its original scoped runtime and show an unsaved warning with Download before leaving. A new account must never see that draft. Do not promise crash/reload recovery when no durable write succeeded. Recovery records with a known owner remain scoped; unclaimed legacy material is visible only through the explicit recovery flow.

## Preserve existing writing

Known sources:

- `wabi:keep-notes:v1:<user>`
- `wabi:dm-notes:v1:<user>:<channel>`
- `wabi:quick-scratchpad:v1:<user>`
- `wabi.userNotes.byUserId`

These keys do not prove server/account ownership. A matching numeric account ID is insufficient. The import flow must explain that existing writing was found and ask which local notebook should receive it.

Choosing an owner does not establish the identity of a legacy DM conversation or profile subject. Unknown contextual references stay detached until the user explicitly maps them. Imports from another server must never attach to a channel/person merely because a numeric ID matches.

1. Preserve the exact raw value in recovery storage or an explicit download before transformation.
2. Validate the container and every record. Recover valid rows without disguising invalid rows as an empty notebook.
3. Preview count, representative titles, context and destination. Profile annotations are selected separately.
4. Import additively in transactions; assign stable IDs and unique display titles without altering original prose.
5. Record a fingerprint of the source key, original bytes and source schema, plus the successful destination. Identical prose from two different sources remains two distinct sources. Interrupted/repeated attempts are idempotent; another account cannot silently claim the same source.
6. Verify readback and backup/export. Keep original values until explicit cleanup after successful recovery.

If storage cannot hold both source and migrated data, offer an export-first path. Do not delete the source to make space without a preserved copy and an explicit user choice.

## Links, renames and imports

Titles are unique within an owner scope after a documented Unicode/whitespace normalization rule. Preserve user-facing spelling. Duplicate import titles receive a previewed suffix and an import-batch mapping.

Support completion, keyboard insertion, a reading view with clickable links, a visible return path, backlinks, and clear unresolved/deleted targets. Exclude fenced/inline code, escaped brackets and raw HTML from link parsing. Render through existing safe Markdown/sanitizer patterns without modifying chat Markdown globally.

Renaming updates the title and stored incoming wiki-link target text in one transaction; explicit aliases remain unchanged. Backlinks follow stable IDs. A dirty editor whose revision predates a rename follows normal conflict handling. Trash/restore preserves identity and reserves the title. Permanent deletion leaves meaningful missing-link state: old UUID-backed links do not silently attach to a new note that reuses the title, including after an unrelated source edit. Retargeting requires an explicit relink action.

JSON backup preserves IDs, revisions as import metadata, original timestamps, context, pin/color, link identities and trash. Identical reimports are skipped. Conflicting imported UUIDs are remapped together with their internal link references; they do not overwrite an existing notebook. Imported revisions remain provenance, while destination records receive local concurrency revisions. Markdown export chooses portable unique filenames and rewrites note references consistently. Import validates size, schema, ownership and filename/path traversal; it is additive by default. Never fetch arbitrary external URLs while resolving note links.

## UI and code boundaries

Suggested new modules under `frontend/src/lib/notes/`: `types.ts`, `scope.ts`, `db.ts`, `store.ts`, `migration.ts`, `links.ts`, and import/export helpers. Keep a compatibility facade only while existing views are migrated.

Update the existing `NotesWorkspace`, `KeepNotesView`, `QuickScratchpad`, `QuickResourcesPanel`, DM Notes mount and `notesWorkspace` routing. Extend `editor/CodeMirrorEditor.svelte` narrowly for Markdown completion, wrapping, theme tokens and optional gutters; preserve defaults for other callers.

Titles/search/backlinks belong to the same Notes workspace. Give the active editor the available height instead of a shallow textbox above unused background. Lead list rows with the note title, keeping timestamps secondary. On phones, prioritize the editor and current title/save state; place secondary color/export actions in a reachable menu. Coordinate shared-shell labels so “Chat” does not ambiguously identify the active Notes destination. Do not add another persisted layout/navigation system. Verify the unused `NotesView.svelte` path before retiring it.

Update profile-note callers to await actual save outcomes and use explicit owner scope. Add storage/recovery/export entry points where users already manage local data. Retain a persistent “On this device” label with populated notebooks.

## Implementation order and acceptance

| Ticket | Automated proof | Browser / interaction proof |
| --- | --- | --- |
| N01 persistence | Revision transactions, scope/session fences, trash, aborted writes, schema upgrades; same account ID on different server endpoints. | Real IndexedDB in two pages: independent-note saves survive; same-note conflict retained; logout/server switch cannot redirect pending save; blocked/quota state stays recoverable; total storage failure keeps a scoped unsaved draft and Download. |
| N02 recovery | Valid/partial/malformed legacy fixtures, interrupted/repeated migration, source-key fingerprints, destination receipts, UUID collision/remapping and backup round trips. | Explicit destination selection; unknown channel/profile references stay detached; duplicate import into a populated notebook is safe; import errors preserve source; recover/export/trash after reload. |
| N03 one editor | Shared service/navigation identities and scratchpad record mapping. | Center → dock → Full → reopen/reload preserves note, draft and context; focus follows the user's action. |
| N04 linked notebook | Parser exclusions, aliases, Unicode/duplicate policy, rename/import mappings, trash/restore, concurrent rename/edit, and delete → same-title replacement → unrelated source edit without accidental retargeting. | Completion keyboard use, follow/back, backlinks, explicit relinking, missing-target creation and readable compact states. |
| N05 Reader/export/polish | Stable source-copy identity and export/import references. | Reader edits leave source intact; return opens the correct note; 1440px/dock/390px, text zoom, keyboard, reduced motion and failed-save journeys. |

Performance acceptance uses a realistic large notebook and a long note on a representative laptop/phone. Record typing latency and transaction behavior before selecting debounce/indexing thresholds. Do not serialize or scan the entire notebook on every keystroke.

## Out of scope for this milestone

Graph visualization, folder-vault watching, block references/transclusion, plugin execution, cloud sync, shared collaborative note editing, and E2EE. These require their own product/data boundaries and cannot displace the safe-save and recovery work.
