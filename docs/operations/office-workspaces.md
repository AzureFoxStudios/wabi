# Documents, Sheets, and Present operations

This guide describes the feature implementation on PR #236. It is not release acceptance evidence. Use the latest checkpoint and exact-commit CI results to determine readiness; a queued test is not a passing test.

## Independent installation and data ownership

Documents use the shared workspace foundation. Sheets and Present are independently selected authoring addons. Build with `WABI_WORKSPACE_ADDONS=none`, `sheets`, `present`, or `all`; the lightweight audience view remains available without importing either authoring package. These are build selections, not a remotely downloadable runtime addon installer.

Enabling a packaged addon in the client and permitting it on the server are separate controls. Disabling an addon does not intentionally delete its local documents, pending edits, originals, recovery data, or private notes. Resolve local storage failures or export recovery before closing a workspace. A browser's own storage eviction or the user clearing site data can still remove device-local information; keep explicit backups for important work.

Local drafts are scoped by account and server. Sharing is an explicit upload to the chosen Wabi server and uses server-enforced artifact permissions. The server operator can read uploaded artifact contents; this feature does not claim end-to-end encryption. A link alone grants no new access. Snapshot publication and live synchronization are distinct modes.

## Editing and handoffs

The document editor preserves local edits and unsubmitted review drafts. The spreadsheet editor additionally retains unfinished cell entries and conflicting scalar versions. A protected range is enforced by the server, not merely by a disabled input.

Discuss in chat stages an unsent, access-controlled reference. It does not send a message, replace the existing composer draft, or attach selected source data automatically. Create private task saves a private Planner item containing the reference. Text quotes and private selection labels are stripped from copied URLs. References identify stable rows, columns, slides, and native objects rather than positional indexes.

For delimited spreadsheet input, UTF-8 CSV/TSV values remain literal text, including leading zeros and strings beginning with `=`. Safe-text CSV/TSV export neutralizes formula-looking string prefixes. XLSX/ODS exports preserve literal values as typed cells; only supported, parsed native expressions become formulas. Unknown or external expressions remain text instead of executable Office formulas. Resolve scalar conflicts before exporting a workbook.

Current import limits are 12 MiB originals, 20 sheets, 10,000 rows, 256 columns, and 50,000 populated cells per spreadsheet import. These limits are deliberately visible; they do not establish acceptance of a 100,000-cell import target.

## Present and audience privacy

Present includes ordinary slide templates and native object layouts. Native objects have stable identifiers, normalized geometry, text, inline raster images, simple shapes, tables, and pinned numeric charts. Charts store copied public values, not a live connection or an embedded copy of a private workbook. Native PPTX chart export uses bars and labels without an embedded workbook. Supported export is a subset, not a promise of arbitrary PowerPoint or OpenDocument round-trip fidelity.

Speaker notes are device-private and separated from the shared deck. Hidden slides and removed objects are excluded from the public audience rendition. Unused legacy slide body/image fields are not included in canvas audience output. A private notes backup is explicitly different from normal audience exports.

Starting a room presentation requires a preview and explicit approval. The room uses a pinned audience revision: authoring changes do not silently change the audience. Update presented version previews the new revision and checks it again after synchronization. Removing or hiding the currently displayed slide requires an explicit destination. Losing the presenter heartbeat or restarting the authority pauses control; resume or handoff is explicit. Returning to a local deck restores its saved presentation association.

PDF imports are static rasterized pages, not editable source objects. Current limits: 40 PDF pages, 100 visible room slides, 200 stored slides including removed ones, and 64 stored objects per native slide including removed ones. Layout replacement is undoable; recovery backups preserve the source model.

## Optional PowerPoint / ODP compatibility converter

The ordinary install does not require LibreOffice or Gotenberg. The optional gateway accepts `.pptx` and `.odp` only after the user explicitly approves uploading the entire original. That original can contain private notes, hidden slides, or embedded material; consent is about the original upload, not merely the visible output. Nothing from conversion is automatically published to a channel.

The supplied opt-in configuration is:

```sh
docker compose -f docker-compose.yml -f docker-compose.office.yml --profile office-conversion up -d --build
```

Present must also be enabled in Wabi. The override configures `WABI_OFFICE_CONVERTER_ENABLED=1` and the fixed internal `WABI_OFFICE_CONVERTER_URL`. Leaving the override unused keeps conversion disabled. Do not expose the converter port publicly or mount private data, the source tree, or the Docker socket into it.

The sidecar is pinned to Gotenberg 8.37.0, non-root and read-only, with dropped capabilities, resource limits, ephemeral temporary storage, an internal network, disabled URL downloads/webhooks/Chromium routes, and denied outbound URL access. Custom deployments must preserve those controls. Optional basic authentication can use `WABI_OFFICE_CONVERTER_USERNAME` and `WABI_OFFICE_CONVERTER_PASSWORD`; keep credentials in deployment secrets, not source control.

The gateway validates actual ZIP expansion, format identity, entry paths, size limits, and rejected active-program content without extracting archives to disk. It allows one conversion at a time, four requests per user per minute, a 30-second upstream request, and a 12 MiB PDF response. It rechecks account admission and addon permission after conversion.

Conversion returns a static PDF with hidden slides, notes pages, original-document attachments, and form fields excluded. The browser turns PDF pages into a separate private native deck and retains the original file for recovery. Fonts, layout, and unsupported media can differ. Review the conversion preview before creating or presenting the copy. Cancellation discards the result but cannot retract original bytes already delivered to the operator's converter. The gateway does not persist the original as a shared artifact; the operator's infrastructure and logging practices remain a separate trust consideration.

## Verification and release discipline

`Office workspace acceptance` runs frontend checking, focused models and real file round trips, real Rust Authority/storage contracts, Chromium and Firefox checks, optional converter fixtures with private-marker assertions, and independent addon build-content checks. All strict outcomes must pass. Logs and tested commit identifiers are retained in the `office-workspace-evidence` artifact. Continue-on-error on diagnostic stages does not waive the final strict gate.

Native desktop/mobile acceptance, owner tests, performance targets, and the full 36-scenario checklist must be reported separately. Neither a successful build nor model-only tests prove them. Remove source-writing development workflows before marking the PR ready. Do not deploy this draft based solely on this guide.
