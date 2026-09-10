# Lore workspace presentation polish

Date: 2026-09-10
Base: PR #175 at `6e863479fb7bb544bc00eaf62f27b7e450ff1b10`.
Status: implementation for review, not merged or deployed. Full application, native desktop, and real-browser verification remain release gates.

## Approved direction

One repository should not have different navigation when opened from a channel versus Project. Files is the default. Files, Changes, History, Review and Settings are peers; Activity, Scripts/Mirrors, external editor and command-line connections remain secondary tools. Theme artwork stays in the surrounding application, with opaque, readable work surfaces inside Lore. Detection is automatic; publication and incoming file application remain deliberate user actions.

## Implementation

- `LoreChannelShell` is a context adapter for the new shared `LoreProjectWorkspace`. Both Project wrappers delegate to it, removing the previous Overview and Repository/Local changes navigation layers. The workspace uses per-instance, channel-bound data requests rather than the shared mutable loreStore for its metadata. Server/account/session/project changes remount the bound workspace; late requests cannot repaint another selection.
- One project header, primary navigation and file tool row. The file viewer has one filename/action header, including contextual history, copy, lock and deletion controls. Tree visibility and horizontal resize, responsive stacking, clear focus outlines, and reduced-motion styling are included. Existing file tree behavior is reused.
- The Files view and opened local Changes observer stay mounted when switching tabs. This preserves editor state and detection across Files/Changes/History/Review/Settings. Leaving the entire workspace still ends the observer; this is not an always-running tray sync service. Existing local transfer/detection/model code and native commands are unchanged.
- Files use readable document layouts, CodeMirror source/edit views, raster image previews and audio/video playback. Unknown binaries are not fetched and decoded as text; they receive an explicit download fallback. SVG is source-only. New text files retain document, Rust, TypeScript, Python, Cargo and package starter choices.
- Upload file/folder selection now opens an explicit destination/summary/review dialog. Writes are conditional on the loaded ETag, or create-only for a new path. Partial success removes accepted items from the queue, stops at the first failure and retains the remainder. File deletion and repository detach/delete keep explicit confirmations. File deletion refuses when the server provides no version identifier. Server authorization remains authoritative.
- `documentMarkdown.ts` uses a separate Marked parser and a document-specific DOMPurify allowlist. The existing chat renderer removes table elements; this renderer preserves sanitized GFM tables without broadening chat's rules. Remote inline images are represented by alt text rather than silently loading tracking images. Scripts, active embeds, forms, SVG/MathML, event attributes, and style attributes are not allowed. This is a document renderer, not a new chat parser or a claim of full Markdown/math feature parity.
- History sorts mixed legacy timestamp units consistently, places human summaries first, displays unavailable metadata honestly, and provides actual revision details. File comparison loads a selected path's own history and compares two explicit revisions, including paths of deleted files. Text diff and existing raster comparison are reused; unsupported binary comparisons offer version downloads. The repository history API does not expose an affected-file manifest per revision, so no changed-file counts/list are invented.
- Settings is a left-aligned page with General/workflow, project review policy, a clearly marked On this computer section and a separate danger zone. Branch listing remains explicit: this server does not expose a working-tree branch switch. Creating a branch must not pretend to switch the browser or local folder.
- Permissions uses a role list, one draft editor, visible capability explanations and a persistent Save/Cancel footer. Default access changes are drafted, not sent on radio selection. Owner/Admin are system-role summaries. Custom role create/delete and built-in protections are preserved. Labels explicitly say these repository roles are SERVER-WIDE, not confined to the selected project. Unknown existing capabilities are preserved.

## Verification performed here

- `node --experimental-strip-types --test frontend/scripts/lore-workspace-presentation.test.mjs`: **53 passed, 0 failed**. 46 tests execute pure production presentation helpers (timestamp ordering, labels, preview classification, relative paths, draft equality and request epochs); 7 supplementary source-contract tests inspect integration boundaries. Source-contract tests are NOT Svelte compilation or browser interaction tests.
- Strict standalone TypeScript type check of `workspacePresentation.ts`: passed.
- TypeScript syntax transpilation of the new/replaced TS modules and nine Svelte script blocks: 11 inputs, no syntax diagnostics. This does not compile the Svelte markup or resolve application types/imports.
- `lore-workspace-compile.mjs` adds real client/server Svelte compilation checks. A focused frontend-only GitHub workflow runs presentation + existing staging/detection tests, actual Svelte compilation, full frontend check and static build. It does not depend on the unrelated Rust CI job and has read-only permissions, no deployment steps or secrets.
- Local execution of that compiler/full-build workflow was NOT possible: the available container has Node/TypeScript but no installed project dependencies, Svelte compiler, Bun, Rust toolchain, or live Lore fixture. Network/dependency retrieval was unavailable. Do not treat the existence of a workflow as a passing result.

## Required before release

1. Run the added compiler check and full frontend check/build with the repository's pinned dependencies. Review compiler warnings, including imported legacy components. Run the original 38 comparison/staging and 41 detection/observer tests again; they were unchanged and not rerun in this UI-only environment.
2. In a real browser, test both entry points and project/server/account changes while responses are delayed. Verify selected files, history, error notices and role drafts do not cross contexts. Verify keyboard navigation, native-dialog focus, cancellation, small workspaces and dark/light/translucent themes.
3. Verify code edit/save/409 conflicts, unsaved changes, post-save preview refresh, review-required submissions, upload cancellation/partial failure, and typed deletion confirmations against a fixture server. Existing server ETag atomicity still needs the PR's original concurrency gates.
4. Exercise document tables, code, large content and malicious Markdown with the real renderer. The renderer does not support embedded raw HTML media or resolve repository-relative image URLs; do not silently enable those for visual parity.
5. Test the connected native Changes observer across all new tabs, incoming notices, stale staged selections, visibility pause and account switching. Inherit all original native compilation, filesystem, streaming, lockfile and safety gates in PR #175.
6. Explicit file/project-picker navigation warns before discarding dirty editor/settings state. Global application sidebar navigation can still unmount the workspace; application-wide navigation blocking/draft recovery is a separate integration concern, not advertised as solved here.

No new server routes, WabiDB events, generated protocol changes, native watcher/transfer changes, automatic file mutations, atomic multi-file commits, or production deployment are included.


## GitHub verification after publication

Implementation commit: `54953bbda444dc94dccc553989b30b58e483cfbf`.
Independent compiler-check commit: `701438d8602a5244454df49a5512c5e94e0910e4`.

Workflow run `34460938792`, markup job `102818352163`, completed successfully:
- All 53 presentation tests passed again on GitHub's PR merge checkout.
- The repository-pinned Svelte compiler **5.56.8** compiled all nine new/replaced components for both client and server: **18 targets, zero errors, six warnings**.
- Four warnings (two per target) identify deliberately captured initial server/channel props in the per-context keyed workspace. Two warnings identify a self-closing datalist option in the history picker. These warnings are not an assertion of full type-check or runtime success; review them alongside the full frontend gate.

The separate full frontend job `102818351906` failed during `npm ci`, before application checks. The first attempt's decoded log (`102816578576`) identifies the pre-existing dependency conflict: `typescript@7.0.2` versus `@sveltejs/kit@2.59.0`'s optional peer range `^5.3.3 || ^6.0.0`. The application dependency files and peer enforcement were NOT changed. The isolated compiler job installs only the repository-pinned Svelte package into a temporary tool directory; it does not make the full frontend job green.

The overall workflow is therefore still failing. Full application type-check/static build, browser interactions, and native desktop tests are still outstanding. No merge or deployment was performed.
