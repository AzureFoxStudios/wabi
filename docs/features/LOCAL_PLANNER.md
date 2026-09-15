# Local Planner

**Candidate:** `codex/production-finish-20260915`; merge and deployment are separate operations.

Planner calendars, tasks, journal entries, projects and related collections are stored on the current device, scoped to the selected server and account. Guests use a separate guest identity. These records are not shared with other channel members or synchronized to an Authority. A project channel link is context, not publication or permission enforcement.

## Saving and account changes

The browser uses the `wabi-planner` IndexedDB database. Writes commit a complete snapshot with a checked revision. A second window cannot silently overwrite a newer revision: its losing snapshot is retained as a recovery draft for the same account. The saved indicator appears after transaction completion.

Storage failures retain the active draft in memory and show an error with export/retry actions. Closing the browser while a save is pending triggers the browser's unsaved-work warning where supported. Memory-only drafts cannot survive a forced browser termination or device power loss. Export them before closing when storage is unavailable.

Changing accounts or servers retires the active editor and clears the visible collections before loading the next account. Pending writes retain their captured original account and data. The same numeric account ID on another server is a different Planner. Windows do not automatically merge concurrent edits; use the recovery export to reconcile conflicts.

## Older data

Older versions used the single browser-wide `business_data` localStorage key without ownership. The candidate leaves its exact bytes intact and does not automatically claim it for the signed-in account. Expand the older-data notice to download the original, then import the file in its intended account. Malformed originals remain downloadable even when import rejects them.

Unassigned legacy data may contain writing from multiple past users of the browser. An import is an explicit ownership choice. Back up the original before editing it for recovery.

## Export and import

Planner options export a JSON snapshot with a version, export time and source account scope. Imports accept the complete nine-collection format used by previous Planner exports, up to 20 MiB and 10,000 incoming records. Invalid/partial files, duplicate IDs and records the compatibility parser would discard are rejected.

Imports add new records and preserve existing records. Identical IDs with equivalent content are skipped. A differing ID collision rejects the entire import; it does not replace current work. Missing referenced projects or graph endpoints also reject the import. Files with server channel/Lore references require the original verified account scope, preventing an old numeric channel ID from silently referring to a different server's channel.

Conflict recovery downloads include multiple snapshots under a recovery envelope. Extract the intended snapshot for ordinary import, or retain the envelope for manual reconciliation. Recovery copies are account-scoped and are not automatically deleted after downloading.

## Remaining limits

- Daily, weekly, monthly and yearly occurrences render in the visible calendar and upcoming-event summary. Clicking an occurrence edits the original series; months/years without its date are skipped. Display computation is bounded to 366-day ranges and spans. Independent occurrence-edit controls remain unavailable.
- Whole-Planner design, accessibility, zoom and physical-device acceptance remain open.
- Server sync has no implemented protocol. Settings and compatibility methods report it unavailable and perform no speculative network writes.
- Local IndexedDB storage is not end-to-end encryption or an Authority backup. Keep device exports separately when needed.
