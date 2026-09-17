# Shared Documents, Sheets, and Present — implementation candidate

Source baseline: `d5eba19a7de64c60c6828be3f3447d58570fb330`.
This is a feature branch, not a deployed release. Owner-tested hosting/calling remains accepted evidence. Music is untouched.

## What is implemented

- The existing Reader retains all private local documents. Its Share/Collaborate buttons open a real publication flow seeded from a preserved local copy. Shared artifact IDs, ACLs, reviews, field revisions and mode generations are Authority-owned and stored through WabiDB's existing commit/projection path.
- A client-side durable recovery record is scoped to server/account/window. Saving commits locally before network submission. Independent fields merge; disjoint Unicode prose spans can merge; overlapping text and scalar edits retain explicit alternatives. This is versioned field synchronization with conservative three-way merge, **not a CRDT**. Active editor polling is currently 1.4 seconds, not a websocket cursor/presence service.
- Named recipients and ordinary-channel permissions support owner/editor/commenter/viewer distinctions. No plaintext artifact is published into a DM/group channel. Shared content is server-readable, not operator-blind E2EE. Revocation rejects future reads/writes; it cannot erase already downloaded copies.
- Sheets and Present are independently enabled first-party addons, with small registration entries and deferred editors/workers. Server settings only allow sharing; they do not force client activation.
- Sheets provides a virtualized grid, stable rows/columns, worker calculation, explicit supported formulas, range copy/paste/fill, row/column edits, local filtering/sorting, guarded per-field undo, simple charts, and bounded CSV/TSV/XLSX/ODS import/export. Unknown formulas remain unsupported; no macros or network formulas execute.
- Present provides native slides, image/text layouts, Markdown conversion, private local speaker notes, audience-safe publication, local/room presentation, independent audience browsing, authoritative handoff/revision control and reconnect state. Audience payloads do not contain notes or hidden slides. Ending does not touch voice calls.
- PDF import uses pinned optional PDF.js 6.3.289 with an owned worker. PPTX/ODP import is an **approximate static renderer for basic embedded images/text**, not lossless Office conversion. It explicitly reports missing masters, complex formatting, charts, animations and media. Original files remain stored privately. Native deck exports include a defined PPTX/ODP subset and static printable HTML; direct PDF export is not implemented (print HTML through the user's browser).

## Build and activation

Default build is lean: neither authoring addon is included. Build with `VITE_WABI_SHEETS=1`, `VITE_WABI_PRESENT=1`, or both. For a static expanded build:

```sh
cd frontend
VITE_WABI_SHEETS=1 VITE_WABI_PRESENT=1 STATIC_BUILD=1 npm run build
```

In Reader, open Workspace library. Enable each available addon independently. Create local documents without server support; an administrator can allow shared spreadsheets and presentations in the library's server settings. Library can reopen native/recovery exports. Share links use `?wabiArtifact=<id>` and `?wabiPresentation=<id>` on the already selected server.

This implements explicit lean/expanded build profiles, **not a downloadable runtime package manager**. Office rendering is worker-isolated and loaded on explicit import; no converter daemon or large bundled desktop office suite is introduced. A hostile-worker resource limit is not a complete sandbox certification.

## Limits still requiring explicit completion evidence

The approved 36-scenario product/addon contract is broader than a compile pass. Do not mark it complete without independent-client, actual Authority, runtime, packaging, and failure tests.

- Current per-request synchronization limit: 4,096 changed fields. Local imports up to 32 MiB; expanded ZIP up to 96 MiB, individual parts 32 MiB. Initial shared publication/session is bounded by WabiDB's 16 MiB event limit including metadata. Too-large publications fail visibly and preserve the local copy.
- Native spreadsheet supports up to 100,000 allocated rows, 256 columns and 100 tabs; these are validation ceilings, **not measured performance guarantees**. The initial file adapter bounds populated cells to 200,000. No pivots, macros, arbitrary network sources, advanced chart fidelity, protected-range ACL UI, or exact Excel round-trip claim.
- No always-live selection/cursor presence or network push; active polling only. Conflict resolution is per field; same-cell alternatives are preserved instead of being silently overwritten. Comments identify stable fields; rich paragraph anchors, task/chat-range handoffs and history browsing remain incomplete.
- Present uses simple layouts, not a full freeform PowerPoint designer. Basic Office reconstruction may lose appearance and text positioning. PDF font/XFA/annotation compatibility is bounded; scripts, annotation actions, external assets and network fetching are not enabled. Speaker notes are device-private and must be backed up separately.
- No separate optional download/install/update manager, native feature-package signing workflow, mobile/native certification, media regression measurement or full import fuzzing claim.
- Existing local Reader suggestions/comments are preserved in their original records; publishing canonical text does not silently invent authoritative historical authorship for them.

## Verification commands

```sh
cd frontend
npm ci --no-audit --no-fund
npm run check
node scripts/workspace-unit-tests.mjs
WORKSPACE_CHROMIUM=/path/to/test/chromium node scripts/workspace-browser-smoke.mjs
VITE_WABI_SHEETS=1 VITE_WABI_PRESENT=1 STATIC_BUILD=1 npm run build
cd ..
cargo test -p wabidb workspace_artifacts
cargo build -p wabi-server --bin wabi-server
node scripts/authority-workspace-smoke.mjs --binary target/debug/wabi-server
```

`workspace-browser-smoke.mjs` tests production components against an explicitly labeled HTTP contract double; it is not proof of server authorization. `authority-workspace-smoke.mjs` uses a real disposable Authority and separate real accounts. Never point the test at operator data.

Local evidence at the first checkpoint: 25 pure unit/format checks passed; independent openpyxl and python-pptx inspected generated files; full Svelte check had zero errors (existing and new warnings recorded). Local Chromium navigation is administratively blocked and Rust is unavailable, so those checks run in Actions and must be recorded against their exact head before merge. No deployment is included.
