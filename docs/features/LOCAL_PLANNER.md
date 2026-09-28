# Local Planner

**Candidate:** `codex/production-finish-20260915`; merge and deployment are separate operations.

Within community-bound My Planner, calendars, tasks, journal entries, projects and related collections are stored on the current device, scoped to the selected server and account. The separate personal workspace described below does not require a community account. Guests use a separate guest identity. These records are not shared with other channel members or synchronized to an Authority. A project channel link is context, not publication or permission enforcement.

## Views

The current worktree offers Calendar, Board, Journal and Projects. Projects opens a searchable inventory, with an Overview for each selected project and optional Reports & sprints for existing charts. Overview counts non-archived, non-scrapped tasks across every descendant once; chart scopes retain their existing direct-project behavior. Existing saved Insights navigation resolves to Projects.

Journal opens an entry stream without an empty sidebar; selecting an entry opens its reading/editor view. Images, tags, privacy fields and sign-offs remain available. Journal supports sanitized Markdown (including tables and fenced code), a preview, text/code-file imports up to 1 MiB, attached/pasted images up to 5 MiB each, and images-only entries. Imported code is inert text. Async imports are discarded when the editor switches entry. Generic binary file attachments are not yet part of the local journal record. Project channel references explicitly do not publish local content. “Add my name” records endorsement metadata; it never publishes or changes access. The personal journal marker is also local metadata, not a server permission. Controlled publication is still planned and requires real shared records plus an explicit audience preview.

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

## Proposed shared boards and AI work

The [AI organizing center proposal](../proposals/multi-computer-ai-workers-and-kanban.md) describes a conversational Pokee/Hermes entry point, shared project journals, multi-computer execution and progress charts. A separate [shared Project Plan](PROJECT_WORKSPACE.md) is under implementation in the current worktree; it does not change the local storage contract above or upload personal records. Publishing selected local content would require an explicit user action; private diaries remain separate from agent-authored project journals.

## Independent personal workspace — development candidate

Open **Personal Planner** from the login screen, follow **Personal workspace** from community-bound My Planner, or visit `/personal`. Calendar, Board, Journal and Projects use a personal identity independent of the selected server/account; no community, guest session or channel is required. Existing account-scoped Planner snapshots remain separate and intact. Export from the original workspace and explicitly import into the personal workspace; imports retaining channel/Lore references require their verified original scope and are rejected across scopes.

In desktop Tauri, private main-window IPC calls the bundled `wabi-server --personal-planner` mode. This mode processes one bounded storage operation through stdin/stdout and exits. It creates no listener, community account, Authority WabiDB, relay or AI connection. Native storage lives under the app data directory's `personal-planner` folder. It uses versioned JSON snapshots, OS operation locking, revision checks, independently retained conflict drafts, file synchronization and immutable commit names. The preceding commit stays on disk; incomplete temporary writes are not loaded. Damaged or unsupported committed storage fails visibly and is never silently replaced by browser fallback. A matching sidecar binary is required.

In a browser, the same personal UI uses a separate IndexedDB identity. A normal browser cannot use the native sidecar or read its app folder. Export/import is the current explicit transfer and backup path. Browser-only origin changes remain separate storage locations.

Personal planning avoids community user-directory fetches, relay probing, queue replay and launch-brand lookup. It uses local “Me” attribution and offers no community channel-reference picker. Existing personal records are not uploaded or sent to a provider. Model access, publishing and cross-device synchronization have no personal-workspace implementation yet.

Limits: personal snapshots are capped at 20 MiB and 10,000 records; recovery state at 64 MiB/32 competing drafts. These limits return an error retaining the current in-memory draft rather than deleting older recovery copies. Storage is not encrypted at rest; the OS user can access the native files or browser storage. UI export/import backs up content, not complete native history. Native installer/WebView acceptance and Windows/macOS runtime durability checks remain separate release gates. See [candidate acceptance](../testing/PERSONAL_PLANNER_ACCEPTANCE_2026-09-28.md).
