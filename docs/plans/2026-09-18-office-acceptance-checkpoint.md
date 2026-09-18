# Office workspace acceptance checkpoint — 2026-09-18

Scope: PR #236, `codex/docs-sheets-present-20260917`. This checkpoint supersedes the earlier implementation-kit and source-repair notes. It is not a merge or deployment instruction. Existing owner-reported hosting and calling acceptance is unchanged; music remains on hold.

## Implementation now present

- Shared Documents with private originals, scoped IndexedDB drafts, explicit snapshot/live publication, independent-account grants, concurrent editing, authenticated passage-linked comments and suggestions, and private-copy/recovery actions.
- Explicit owner **Freeze live editing** and **Resume collaboration…** controls. Freeze preserves the committed shared content and current grants while incrementing the server mode generation. Old-generation writes fail without discarding the sender's pending local work. Resume requires approval in the sharing dialog and does not regrant revoked accounts.
- Independent optional Sheets and Present authoring packages. The default `none` profile excludes both editors; `sheets`, `present`, and `all` are independent physical build selections. This is not a runtime downloadable installer.
- Sheets stable identities, concurrent-value conflict handling, server-enforced protected ranges, private cell buffers, formulas/recalculation workers, formatting, whole-row ordering, local filters, charts, and original-preserving CSV/TSV/XLSX/ODS imports and exports. Literal formula-looking text is not promoted to a formula on export.
- Present native layouts/themes and stable canvas objects, keyboard/drag placement, raster images and finalized crops, tables and pinned chart values, private speaker notes, PPTX subset export and audience-only print/PDF output.
- Optional isolated PPTX/ODP-to-static-PDF conversion with explicit original-upload consent and bounded archive/time/size/concurrency limits. Empty directory descriptors are accepted; actual embedded programs, malformed paths and payload-bearing directory entries remain rejected. The user reviews converted pages before creating a private deck.
- Pinned audience revisions, explicit review/update, follow/independent browsing, controller heartbeat and disconnect pause/resume, pointer/questions, and generation-checked handoff/end. The public canvas projection does not include the legacy source body/image or private notes.
- Link-only chat drafts and private Planner handoffs; no implicit publication or copied private workbook content. Reader offline-save status and owner/server navigation guards are integrated.

See `docs/operations/office-workspaces.md` for supported formats, limits, optional converter setup and data ownership.

## Automated evidence and fixes

The retained `.github/workflows/office-workspace-checks.yml` has read-only repository permissions. It does not edit source, merge or deploy. The temporary `.github/workflows/office-finish-repair.yml` was removed in `f613451`.

Run `35329137975` tested PR head `bb5d07d` as merge tree `4b30c351c83f4b42a535fbd4a1aa64af3ba9924d` and confirmed:

- Frontend typecheck: zero errors; existing warnings remain.
- 55 focused frontend model tests, 4 storage tests, 15 server workspace unit tests, and 3 Authority/process-exit replay contract tests passed.
- Both Chromium and Firefox completed real PPTX and ODP conversion through the isolated sidecar. Assertions checked explicit consent, expected visible PDF content, exclusion of private notes/hidden slides, and retention of the original on the private imported deck.
- All four package profiles passed using the **complete emitted-module inventory**, including worker dependencies. `image-size` was absent from those browser/worker module inventories. The inventory previously filtered module names before checking them; that invalid evidence path was removed in `fd810bc`.

That run did **not** pass the final strict gate: the native-deck reopening check compared the restored deck with a baseline captured before asynchronous storage completed. The browser tests now use `waitForState`, which polls the resolved boolean from `page.evaluate`; it cannot accept an unresolved Promise as a successful storage predicate. Its own preflight checks require repeated false results to be retried, always-false results to time out, and storage exceptions to propagate. Assertions were not removed.

The browser suite also includes independent-profile review-draft recovery, suggestion application, freeze/resume, rejected offline writes, revocation, private copies, injected storage quota failure with portable recovery, and byte-identical original-file retention. These scenarios must complete in both browser engines before the strict acceptance gate passes.

**Use the PR's latest completed checks and final verification comment for exact-head results.** This source checkpoint does not predeclare a subsequent run successful. Every new source change must pass the retained strict gate.

## Dependency audit boundary

The pinned dependency installation reports two high-severity package findings associated with `image-size` and its transitive `pptxgenjs` dependency. The installation audit is not clean. The complete bundle check verifies that the affected Node image parser is not included in the shipped browser/worker code. The Rust server does not invoke the Node PPTX API. Do not reuse the Node generator on untrusted images without addressing those advisories. Keep the exclusion assertion and re-evaluate on dependency updates rather than silencing the audit.

## Release boundaries still requiring real-device evidence

Automated browser acceptance does not certify native Tauri installers, minimum-hardware performance, full call coexistence under load, device-specific keyboard/input behavior, or all 36 manual specification scenarios. No such certificate is asserted here. The bounded implementation does not claim lossless Office round trips, native editability of converted Office pages, macro/external-formula execution, or deletion of copies already downloaded by recipients.

No deployment or merge was performed as part of this checkpoint.
