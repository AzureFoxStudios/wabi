# Wabi Wiki UX-First Implementation Plan

> **Status:** approved focus shift; planning only.
>
> **Goal:** make Wabi's first-class wiki pleasant and useful for real documentation work before implementing any knowledgebox integration.
>
> **Scope:** frontend-first wiki UX, with only the smallest backend changes required to support a good editing experience. Knowledgebox protocol, pipe state, pairing, delivery, companion Docker project, and MCP are explicitly deferred.

---

## Product direction

The wiki should feel like a calm documentation workspace inside Wabi, not like a bare CRUD screen and not like a second application competing with chat.

Wabi should remain the source of truth. Markdown remains the canonical page format for this phase. The goal is a strong documentation surface with:

- comfortable reading;
- reliable editing;
- useful page hierarchy;
- images;
- citations;
- search;
- stable references;
- revision recovery;
- good desktop and mobile behavior.

### Explicitly deferred

Do not implement during this phase:

- knowledgebox synchronization;
- AI-readable flags;
- AI or MCP routes;
- outbound sync pipes;
- companion Docker project;
- vector search or embeddings;
- AI page writing;
- public/anonymous wiki access;
- arbitrary HTML/JavaScript embeds;
- Notion-style block databases;
- freeform canvas/layout editing;
- live collaborative cursors;
- full CRDT editing;
- external citation scraping;
- revision synchronization to another system.

The existing knowledgebox documents remain design context only:

- `docs/plans/2026-08-12-wiki-knowledgebox-mvp.md`
- `docs/research/wiki-knowledgebox-security-review.md`
- `docs/architecture/wiki-knowledgebox-protocol-v1.md`

Do not add implementation work for those documents until the wiki UX phase is accepted.

---

## Current verified foundation

Relevant current files:

- `frontend/src/lib/components/WikiChannel.svelte` — wiki shell, reading, editing, history, sharing.
- `frontend/src/lib/components/WikiPageTree.svelte` — page tree and current title filtering.
- `frontend/src/lib/components/WikiRevisionDrawer.svelte` — revision list and restore flow.
- `frontend/src/lib/wikiStore.ts` — page/revision API calls and stores.
- `frontend/src/styles/components/wiki.css` — wiki layout and styling.
- `frontend/src/lib/markdown.ts` — existing markdown renderer/sanitization path.
- `frontend/src/lib/objectRefRegistry.ts` — wiki object references and navigation.
- `frontend/src/lib/shareToChannel.ts` / `ObjectShareMenu.svelte` — sharing and stable object references.
- `frontend/src/lib/components/chat/uploadResumable.ts` — authenticated resumable uploads.
- `core/crates/wabi-server/src/api/wiki.rs` — direct `/api/wiki` CRUD and revision routes.
- `core/crates/wabi-server/src/adapter/mod.rs` — wiki event and persistence path.
- `core/crates/wabidb/src/projections/wiki.rs` — page/revision projections.

Already implemented in the current working slice:

- pure wiki helper module and focused tests;
- stable page-tree sorting and breadcrumb helpers;
- channel-scoped client-side search helper;
- stale wiki-load response protection;
- normalized page/revision API responses;
- breadcrumbs and page citation copy action;
- heading-based table of contents;
- split edit/preview mode;
- small markdown insertion toolbar;
- existing resumable image upload wired into the editor.

These changes are not a substitute for browser review. The next work must inspect the actual rendered result and improve the full interaction flow.

---

## UX acceptance bar

A user should be able to:

1. Open a wiki channel and understand the page structure immediately.
2. Find a page by title or body text without hunting through the tree.
3. Read a page without excessive chrome or cramped line length.
4. See where the page sits in the hierarchy.
5. Create a page or child page with an obvious next action.
6. Edit markdown with enough assistance to avoid remembering syntax.
7. Preview before saving.
8. Know whether changes are unsaved, saving, saved, or failed.
9. Add an image with alt text and see it render safely.
10. Add a source citation without repeated manual formatting.
11. Copy a stable page link or citation.
12. Open revision history and understand what changed.
13. Restore a revision without ambiguity.
14. Use the wiki on a narrow screen without losing the page tree or editor.
15. Recover gracefully from API failures, expired auth, empty state, and deleted pages.

---

## Implementation order

1. Baseline and browser audit.
2. Page-tree and navigation UX.
3. Reading layout and typography.
4. Search and result navigation.
5. Editing state and safety.
6. Markdown toolbar and preview.
7. Images and attachments.
8. Citations and stable references.
9. Revision history and restore UX.
10. Empty/error/loading/mobile states.
11. Focused tests and real-browser verification.
12. UX acceptance review.

Do not begin backend schema changes or knowledgebox work before the browser audit identifies a concrete need.

---

## Task ledger

### WIKI-UX-01 — Establish the baseline

**Files:** no edits initially.

- Run `git status --short` in `/home/Ronin/wabi`.
- Treat unrelated dirty files as owned by other workstreams.
- Run the existing frontend check and record baseline failures separately.
- Start the local Wabi frontend/backend using the repository's normal development flow.
- Inspect the wiki in a real browser at desktop and mobile widths.
- Capture the actual pain points in the implementation notes below before changing layout.

**Verify:** baseline notes include loading, empty, populated, nested, editing, history, error, and narrow-screen states.

### WIKI-UX-02 — Make page navigation understandable

**Files:**

- Modify: `frontend/src/lib/components/WikiPageTree.svelte`
- Modify: `frontend/src/lib/components/WikiChannel.svelte`
- Modify: `frontend/src/styles/components/wiki.css`
- Reuse/test: `frontend/src/lib/wikiHelpers.ts`

Implement:

- deterministic ordering by `orderIndex`, then stable title/ID fallback;
- safe handling of orphaned parent IDs;
- arbitrary-depth tree rendering rather than the current fixed-depth repetition;
- clear active-page treatment;
- expand/collapse state that survives page refresh within the channel;
- accessible tree controls and keyboard navigation;
- search results that reveal matching pages even when nested;
- clear “new page” and “new child page” actions;
- breadcrumbs that are clickable where navigation is meaningful;
- no duplicate sidebar or competing workspace rail.

**Verify:** nested pages at four levels, orphan page, duplicate titles, keyboard tree navigation, search-to-page selection, and mobile collapse.

### WIKI-UX-03 — Improve reading composition

**Files:**

- Modify: `frontend/src/lib/components/WikiChannel.svelte`
- Modify: `frontend/src/styles/components/wiki.css`
- Inspect: existing surface toolbar and workspace chrome.

Implement:

- readable content measure and vertical rhythm;
- title/header hierarchy with less wasted space;
- metadata that is useful but quiet;
- visible page actions grouped by intent: edit, copy, history, share;
- generated table of contents placed where it helps reading rather than competing with content;
- consistent heading anchors for internal links;
- preserved markdown links/code/quotes/tables formatting;
- clear distinction between viewing current content and viewing a historical revision;
- responsive content layout with no horizontal overflow.

Do not turn the page into a card grid or add decorative panels that bury the document.

**Verify:** long documentation page, headings, code block, table, quote, links, image, historical revision, and narrow viewport.

### WIKI-UX-04 — Make search genuinely useful

**Files:**

- Modify: `frontend/src/lib/wikiHelpers.ts`
- Modify: `frontend/src/lib/wikiStore.ts`
- Modify: `frontend/src/lib/components/WikiChannel.svelte`
- Modify: `frontend/src/lib/components/WikiPageTree.svelte`
- Modify: `frontend/src/styles/components/wiki.css`

Implement:

- title and body search;
- case-insensitive matching;
- safe excerpts with highlighted match;
- nested-page results regardless of tree expansion;
- result count and explicit no-results state;
- keyboard navigation through results;
- selecting a result opens the page and clears or preserves the query intentionally;
- no network request per keystroke during the client-side phase;
- deleted pages excluded.

Keep search channel-scoped. Add server-side search only after real page-volume evidence requires it.

**Verify:** empty query, punctuation, repeated matches, nested results, deleted result, keyboard selection, and large in-memory page set.

### WIKI-UX-05 — Make editing safe

**Files:**

- Modify: `frontend/src/lib/components/WikiChannel.svelte`
- Modify: `frontend/src/lib/wikiStore.ts`
- Modify: `frontend/src/styles/components/wiki.css`

Implement:

- explicit editor states: clean, dirty, saving, saved, failed;
- unsaved-change confirmation before page/channel navigation;
- save button disabled only when appropriate;
- clear failure message while preserving the draft;
- retry without losing text;
- title/body validation;
- no autosave in this phase;
- no accidental reset when switching preview/edit;
- prevent stale update responses from replacing a newer draft;
- focus management when entering and leaving edit mode.

Keep current full-page PUT semantics unless a concrete backend limitation requires change.

**Verify:** edit/cancel, edit/preview/edit, save success, save failure, retry, navigation with dirty draft, and slow response ordering.

### WIKI-UX-06 — Finish the markdown editing toolbar

**Files:**

- Modify: `frontend/src/lib/components/WikiChannel.svelte`
- Modify: `frontend/src/lib/wikiHelpers.ts`
- Modify: `frontend/src/styles/components/wiki.css`

Support reliable selection insertion for:

- heading;
- bold;
- italic;
- link;
- quote;
- unordered list;
- ordered list;
- code block;
- table;
- image;
- citation/reference.

Rules:

- preserve selected text when wrapping it;
- put the cursor in the useful location for links/images/citations;
- preserve undo where browser behavior allows;
- provide labels/tooltips, not icon-only mystery buttons;
- keep markdown canonical;
- no arbitrary HTML/JS insertion.

**Verify:** selected text and no-selection cases for every toolbar action, keyboard focus, mobile toolbar wrapping, and preview output.

### WIKI-UX-07 — Add image insertion properly

**Inspect first:**

- `frontend/src/lib/components/chat/uploadResumable.ts`
- `frontend/src/lib/galleryStore.ts`
- `core/crates/wabi-server/src/api/upload.rs`
- existing uploaded-file serving/security headers.

**Modify only what is required:** wiki editor, upload helper integration, and focused styles.

Implement:

- image-only picker and clear invalid-file feedback;
- upload progress or an explicit uploading state;
- alt-text prompt before or immediately after insertion;
- safe markdown image reference;
- responsive rendered image;
- broken-image fallback;
- no second blob store;
- no attachment metadata added to postcard page records without a compatibility design.

**Verify:** PNG/JPEG/WebP upload, invalid MIME, large file rejection, cancel/failed upload, reload persistence, image rendering, and auth behavior.

### WIKI-UX-08 — Add citations and stable references

**Files:**

- Modify: `frontend/src/lib/wikiHelpers.ts`
- Modify: `frontend/src/lib/components/WikiChannel.svelte`
- Modify: relevant share/reference UI and wiki CSS.

Implement:

- citation dialog accepting title, URL, and optional access date;
- markdown-compatible reference insertion;
- URL validation and escaping;
- duplicate-source handling;
- copy-page-link;
- copy-page citation with server origin, channel, page slug/ID, and update time;
- consistent citation output in search and share actions;
- clear source-vs-page distinction.

Do not scrape external pages or promise scholarly citation management.

**Verify:** valid/invalid URLs, duplicate citations, missing title/date, server URL with a trailing slash, copied output, and page slug fallback.

### WIKI-UX-09 — Make revision history useful

**Files:**

- Modify: `frontend/src/lib/components/WikiRevisionDrawer.svelte`
- Modify: `frontend/src/lib/components/WikiChannel.svelte`
- Modify: `frontend/src/lib/wikiStore.ts`
- Modify: `frontend/src/styles/components/wiki.css`
- Backend only if required: wiki revision API/types.

Implement:

- meaningful revision summary display;
- editor and timestamp metadata;
- clear current-vs-historical state;
- preview historical content without accidental editing;
- restore confirmation explaining that restore creates a new edit;
- stale revision response protection;
- empty history state;
- revision loading/error/retry state.

If edit summaries require persistence changes, inspect postcard compatibility before touching records. Prefer an additive/versioned strategy.

**Verify:** no history, one revision, many revisions, slow response, historical preview, restore, and restore failure.

### WIKI-UX-10 — Finish empty, loading, error, and mobile states

**Files:** wiki components and `wiki.css` only unless a shared primitive is genuinely needed.

Implement:

- first-use empty state with one clear “Create page” action;
- no-search-results state with query and reset action;
- loading skeleton or stable loading presentation without layout jump;
- actionable API failure state preserving retry;
- expired-auth handling consistent with the rest of Wabi;
- mobile page-tree drawer/collapse;
- mobile editor with usable toolbar and save controls;
- no horizontal scroll from code, tables, toolbar, or citations.

**Verify:** desktop, tablet, narrow mobile, long title, long unbroken URL, code block, table, and failed API states.

### WIKI-UX-11 — Focused tests and browser acceptance

Add or update tests for:

- tree construction and sorting;
- breadcrumbs and cycles;
- search results/excerpts;
- citation formatting;
- markdown insertion/cursor positions;
- stale page/revision responses;
- upload result handling;
- restore state transitions.

Run:

```bash
cd /home/Ronin/wabi/frontend
bun test src/lib/wikiHelpers.test.ts
bun run check
STATIC_BUILD=1 bun run build
```

The full `bun run check` must be compared against the recorded baseline. Do not claim a clean suite if unrelated pre-existing failures remain.

Perform real-browser verification for:

- wiki channel load;
- nested navigation;
- search;
- create/edit/preview/save/cancel;
- image upload/render;
- citations/copy;
- history/restore;
- API failure;
- desktop and mobile layouts.

### WIKI-UX-12 — Acceptance review and cleanup

Before moving to knowledgebox work:

- remove dead wiki state and unused props created by the old UI;
- verify no duplicate search path remains;
- verify no wiki-specific upload storage was introduced;
- verify no AI/knowledgebox routes or flags slipped into this phase;
- inspect path-scoped diff only;
- update this plan with implemented/verified status;
- record remaining UX gaps as deferred tasks rather than silently expanding scope.

---

## Backend change guardrails

Backend changes are allowed only when the frontend cannot deliver the UX safely without them.

Before changing a WabiDB record:

1. inspect its codec and existing replay compatibility;
2. determine whether the field belongs in a separate projection/config store;
3. add compatibility tests for old persisted data;
4. add API tests for old and new payloads;
5. avoid unrelated refactors.

Do not add a wiki AI flag, sync pipe, knowledgebox credential, or public wiki route during this UX phase.

---

## Worktree rules

The Wabi checkout already contains unrelated dirty work. The implementer must:

- run `git status --short` before each implementation slice;
- leave unrelated modified/untracked files untouched;
- never silently stash or reset;
- use path-scoped `git diff` and `git diff --check`;
- not touch `data/`, `data/admin_policies.json`, `data/jwt_secret`, or `docs/wabi-carl-watch.md`;
- not hand-edit generated `packages/wabi-protocol` files;
- not commit, push, or deploy unless explicitly instructed.

---

## Definition of done for the UX phase

The UX phase is complete when:

- the wiki is comfortable for documentation, not merely technically functional;
- page hierarchy is understandable and usable at arbitrary depth;
- search finds nested content and opens the correct page;
- editing preserves drafts and exposes save state;
- preview, markdown toolbar, images, and citations work together;
- revision history is understandable and restoration is safe;
- empty/error/loading/mobile states are deliberate;
- focused tests pass;
- frontend build succeeds apart from documented baseline issues, if any;
- real-browser verification is complete;
- no knowledgebox implementation has been started.

Only after this acceptance review should the project return to the deferred knowledgebox plan and choose the companion repository/location.

---

## Status ledger

- [x] UX-first scope approved.
- [x] Knowledgebox implementation deferred.
- [x] Current wiki implementation surface inventoried.
- [ ] Real-browser baseline audit.
- [ ] Navigation/tree pass.
- [ ] Reading layout pass.
- [ ] Search pass.
- [ ] Editing safety pass.
- [ ] Toolbar pass.
- [ ] Image pass.
- [ ] Citation pass.
- [ ] Revision pass.
- [ ] Mobile/error/empty pass.
- [ ] Focused verification.
- [ ] Acceptance review.
