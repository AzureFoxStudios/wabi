# Documents, Sheets, and Present implementation

Status: work in progress on `codex/docs-sheets-present-20260917`; do not infer deployment or full specification completion from this source checkpoint. The owner's reported hosting/calling tests are accepted and remain independent of this work. Music is unchanged.

## Implemented source boundaries

Reader's Share and Collaborate actions preserve and flush the existing local draft, then open an explicit shared-document workbench. Publishing, access changes, comments/suggestions and merge-safe updates use the existing Rust Authority and a private WabiDB projection. Legacy Reader content is not automatically uploaded or deleted. Shared updates are not public chat events.

The client uses Yjs v1 updates, a scope-isolated IndexedDB store, per-operation pending IDs and persisted-before-transmit ordering. The server uses the Rust-1.93-compatible Yrs 0.24.0 and acknowledges through WabiDB. Shared workspace updates currently use bounded HTTP polling, not cursor-presence or a completed websocket editor protocol. Same-browser windows are supplementary coverage, not proof of independent-user sharing.

Sheets and Present are independently enabled frontend addons. Their registrations do not import their editors. Browser/desktop client code selection is a build-time decision:

- `WABI_WORKSPACE_ADDONS=none` (default): neither authoring engine is packaged.
- `WABI_WORKSPACE_ADDONS=sheets`: Sheets only.
- `WABI_WORKSPACE_ADDONS=present`: Present only.
- `WABI_WORKSPACE_ADDONS=all`: both, still disabled on the device until explicitly enabled.

The lightweight audience viewer and shared Documents remain available without either editor. Runtime installation of downloaded executable addons is not implemented. A minimal client must not label its unavailable editor as installable with one click.

A normal expanded static build is `cd frontend && WABI_WORKSPACE_ADDONS=all STATIC_BUILD=1 npm run build`. Existing CLI/server/desktop build instructions otherwise apply. Server workspace settings separately control shared Sheets and presentation sessions; local editing does not require server capability activation. Source editing, comment and viewer grants are distinct from presentation control.

## Current functional subset

Sheets has a native grid, persistent stable rows/columns, conflict-preserving scalar values, a deliberately bounded formula grammar, worker-backed parsing/calculation, CSV/TSV/XLSX/ODS import with a private-copy preview, and supported-subset exports. Imported cached formula results are labeled and marked stale after native changes. Workbook originals and removed-cell content remain recoverable. This is not arbitrary Excel compatibility.

Present has native text/image decks, slide identities/reordering, device-private speaker notes, static PDF/image import, an audience-safe PPTX subset export, and print-to-PDF. Room presentations use pinned visible-slide payloads, controller generations, explicit handoff and independent audience browsing. Hidden slides and private notes must not appear in audience payloads. PPTX/ODP import conversion is not installed in this implementation and produces an explicit limitation rather than a fake preview.

## Validation entry points

The read-only `Office workspace acceptance` workflow runs type checks, focused native model tests, real Authority API/replay tests, independent-profile production-component browser tests and minimal/selected/expanded bundle inspection. It has no source-write permission. All temporary dependency-kit and source-rewriting workflows have been removed from this branch.

- Frontend model tests: `cd frontend && bun test src/lib/workspaces`
- Real server contract: `cargo test -p wabi-server --test workspace_contract --locked`
- Browser host: `cargo build -p wabi-server --example workspace_test_host --locked`
- Office browser fixture: `frontend/scripts/office-workspace-browser-smoke.mjs`; requires an isolated loopback test host and never substitutes mocked replication.
- Existing `frontend/scripts/workspace-browser-smoke.mjs` is unrelated existing coverage and has not been overwritten.

The generated `wabi-workspace-bundle.json` records relevant emitted chunks and module boundaries. Bundle inspection is not an installer or physical-device acceptance result. Final verified commit/results belong in the PR checkpoint after the checks actually finish.

## Remaining acceptance and product work

Do not call the full approved specification finished merely because the first UI exists. Remaining work includes precise anchored/reply review workflows and legacy-review migration, full docking/restoration acceptance, protected-range authorization and richer spreadsheet types/formats, range-to-chat/task actions, performance/stress fixtures, more complete deck authoring controls, presenter disconnect/pointer behavior, optional Office import conversion, and actual Tauri/mobile/installer validation. Shared-update resource hardening needs hostile-input testing beyond basic size/schema checks.

No merge, deployment, fresh-machine installer test, physical-device office test, or complete 36-scenario acceptance claim is made by this document. Local failure/recovery and audience confidentiality remain blocking invariants rather than optional polish.
