# Local Notes

**Candidate implementation:** `codex/production-finish-20260915`. This document does not mean the candidate is deployed on wabi.chat or merged into main.

## Where writing lives

Notes and scratchpad writing live in this browser/device's IndexedDB database, `wabi-local-notes`. A notebook belongs to a normalized server address and account. Guest notebooks are separate. Signed-out use requires an explicit, separate offline notebook; it does not open a signed-out account's writing.

This is local storage, not server synchronization, collaboration or end-to-end encryption. Browser storage eviction, clearing site data, losing a device, or changing browser profiles can remove access. Keep backups outside the browser. Server backups do not include local Notes.

Channels continue to anchor location. Center-stage Notes owns the primary notebook task. Stubs and right panels remain additive multitasking surfaces. Each editor has an independent draft; Full on a scratchpad opens that same note in center stage.

## Saving and recovery

“Saved on this device” appears only after the note transaction completes. Concurrent editors use record revisions. A stale save cannot overwrite a newer note, rename or trash action.

If another editor changes the same note, keep the draft, download it, or save a recovery copy. Conflicting/failed drafts are also written to recovery storage when it is available. If all device storage fails, the draft remains only in its original scoped browser runtime, with Download and a before-leave warning. **That runtime copy cannot survive a browser crash or reload.** Reopening Notes must expose retained drafts even when database reads still fail.

Trash reserves note titles and has no automatic expiry. Restore keeps identity. Permanent deletion is a separate explicit action. Profile annotations use their own owner/person records and revision tombstones; they are outside the notebook graph and notebook backup.

## Links

Use `[[Title]]` or `[[Title|label]]`. Link targets and backlinks appear below the editor. Titles are unique after Unicode NFKC normalization, whitespace normalization and lowercase comparison. Renaming updates incoming links atomically while preserving aliases. Code, escaped brackets and raw HTML do not become notebook links.

Links retain target UUIDs. Deleting a target and creating another note with the same title does not silently redirect existing links. Missing and trashed targets are visibly unavailable. The storage service supports explicit relinking; the user-facing relink picker remains part of the next Notes finishing pass.

## Recovering older writing

Choose **Import and recovery**. Existing Notes, DM-note and scratchpad sources are previewed and copied only after an explicit destination choice. Their old keys do not reliably identify a server/account. Numeric IDs alone are not evidence of ownership.

Recovery preserves the exact source bytes, imports valid rows from partially malformed lists, reports invalid rows, and records an idempotent receipt. Old localStorage values are not removed. Conversation notes are recovered without attaching an ambiguous channel ID. Original profile annotations remain separate until an explicit owner/person mapping is implemented; the profile UI explains this limitation.

## Backups

**Back up saved notes** exports a versioned JSON file with note identities, titles, bodies, timestamps, revisions, pin/color, links and Trash. Unsaved drafts and profile annotations are not included; download those separately.

Imports are additive. Existing records are kept; conflicting titles receive suffixes, colliding UUIDs and internal links are remapped together, and exact repeated imports are skipped. Imported revisions are provenance, not local concurrency revisions. Associations from another notebook are detached instead of matching coincidental channel numbers.

This candidate supports a maximum **20 MB UTF-8 JSON backup**, 10,000 notes and 100,000 indexed references. Export validates the same limits as import and refuses to create an unsupported file. If a notebook exceeds those limits, download individual notes; multipart backups remain future work. Keep downloaded files private if their contents are sensitive.

**Open a copy in Reader** copies the current text under a stable note source identity. Reader edits do not write back to the note. A dedicated return-to-note control, portable Markdown bundle export, and Markdown editor completion remain unfinished.

## Acceptance evidence

- `frontend/scripts/notes-storage-browser-smoke.mjs`: real IndexedDB, two-window writes, additive upgrades, link identity/rename, trash, failed drafts, reload recovery, legacy migration, backup remapping and a typing-during-rename regression.
- `frontend/scripts/notes-scope-browser-smoke.mjs`: account/server/path boundaries, logout and switching fences, guest identity, explicit offline storage failure.
- `frontend/scripts/notes-workspace-browser-smoke.mjs`: isolated Authority and headful workspace journeys, editor height, shared scratchpad and mobile rendering.
- `frontend/scripts/profile-notes-browser-smoke.mjs` and `profile-popout-browser-smoke.mjs`: scoped annotation transactions and actual profile UI save/reopen/clear/failure/download behavior.

These checks do not certify physical devices, browser storage eviction behavior, native webviews, a production deploy, or the whole release campaign.
