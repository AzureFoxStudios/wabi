# Wabi Wiki + Knowledgebox MVP Plan

> **Status:** architecture and security-review brief; implementation not started.
>
> **Goal:** make Wabi's wiki useful as a real documentation surface, then let an owner optionally synchronize selected wiki content to a separate knowledgebox without turning Wabi into an AI-crawl target.
>
> **Architecture:** Wabi remains the authority for wiki content. A separately operated knowledgebox receives owner-approved wiki snapshots and change events over an outbound, paired, authenticated pipe. AI/MCP clients talk to the knowledgebox, not directly to Wabi. The first release should use a small Docker companion rather than adding an AI runtime, vector database, or general-purpose agent system to Wabi.
>
> **Tech stack:** existing Wabi Rust/Axum API and WabiDB event/projection model; existing Svelte 5 wiki surface; companion service/container with a small durable store and HTTP API. Exact companion language and search engine are intentionally deferred until the protocol contract is fixed.

---

## 1. Product decision

The product is **not** “AI access to Wabi.”

The product is:

> **Wiki Knowledge Sync:** an owner-paired companion that maintains a searchable copy of explicitly selected Wabi wiki content.

The knowledgebox is a separate trust and failure boundary:

```text
Wabi authority
  └── outbound signed wiki sync ──▶ knowledgebox
                                      ├── local search/read API
                                      ├── optional MCP adapter
                                      └── optional local or remote AI
```

Wabi must not expose a general AI credential, a database reader, a broad crawl endpoint, or an AI runtime in the core server for this MVP.

### Non-goals for the MVP

- AI writing back into Wabi.
- AI reading messages, users, private channels, uploads, admin data, or revisions by default.
- Automatic synchronization of every wiki channel.
- Cloud-hosted Wabi knowledge infrastructure.
- Full collaborative page-layout software.
- General-purpose vector/RAG platform.
- Arbitrary public webhooks as the official AI integration.
- “AI-safe” claims or protection against a compromised host owner/root account.
- Lore integration. Lore is a separate addon and is not the right dependency for the core wiki knowledge path.

---

## 2. Current Wabi facts verified in the repository

The current wiki is already a first-class Wabi surface:

- REST routes are mounted directly at `/api/wiki` in `core/crates/wabi-server/src/api/routes.rs`.
- `core/crates/wabi-server/src/api/wiki.rs` exposes page list/get/create/update/delete and revision reads.
- Wiki handlers require ordinary `AuthUser` authentication; there is no anonymous wiki read path.
- Bot credentials exist, but they are general bot identities and include a message-send capability. They should not be reused as the knowledgebox identity.
- WabiDB stores wiki pages and revisions in `core/crates/wabidb/src/projections/wiki.rs`.
- Wiki mutations emit durable events: `wiki_page_created`, `wiki_page_edited`, `wiki_page_deleted`, and `wiki_revision_created` in `core/crates/wabi-server/src/adapter/mod.rs`.
- The current frontend is `frontend/src/lib/components/WikiChannel.svelte` with `WikiPageTree.svelte`, markdown rendering, page editing, and a revision drawer.
- The current frontend API/store is `frontend/src/lib/wikiStore.ts`; it loads the entire page list for a channel and updates the local store after writes.
- The current page model has title, markdown-ish body, parent page, slug, order index, author, timestamps, and deletion state.
- The current wiki UI has no image attachments, no block/layout editor, weak/no page search implementation, and no convenient citation/reference workflow.
- Wabi already has a global rate limiter in `core/crates/wabi-server/src/rate_limit.rs`, configured in `main.rs` with `WABI_RATE_LIMIT_RPS` and `WABI_RATE_LIMIT_BURST`.
- Wabi already has webhook delivery machinery for `message.created` in `core/crates/wabi-server/src/bot_delivery.rs`, but wiki events are not currently delivered through it.
- The repository has a helper-node/job-queue direction. A knowledgebox should fit the “separate worker/sidecar with authority-owned truth” model, not add a second database authority to Wabi.

### Important implementation caveat

The Wabi contribution rules prohibit casually adding fields to postcard-encoded records without a compatibility strategy. A per-channel sync flag must therefore not be added directly to `Channel` or another postcard record without a dual-decode/migration design. For the MVP, prefer a separate versioned knowledge-sync configuration/projection or a server-side configuration store that can be evolved safely.

---

## 3. Questions for public security and architecture review

These questions should be sent to security reviewers, self-hosting communities, AI-agent/MCP researchers, and experienced Wabi users. The request should ask for design critique against a disposable local test deployment, not invite probing of a production Wabi instance.

### 3.1 Trust-boundary review

1. Does an outbound-only paired pipe materially reduce risk compared with giving an AI a read-only inbound Wabi token?
2. What network paths must be blocked so a knowledgebox cannot use Wabi as a proxy or SSRF primitive?
3. Should Wabi ever accept inbound requests from the knowledgebox after pairing, or should all synchronization be initiated by Wabi?
4. Is a local sidecar on the same host a meaningful boundary, or should the first supported deployment use a separate container/network namespace?
5. What is the minimum capability a knowledgebox needs to recover from missed events?
6. Can replay and snapshot recovery be designed without giving the box a general wiki crawler?

### 3.2 Credential and pairing review

1. Should pairing use a one-time code, one-time token, or a local Unix-socket/bootstrap flow?
2. How should the pair identity be rotated and revoked?
3. Should credentials be scoped to one server, one pipe, one wiki channel, or one page collection?
4. Can the protocol prevent a knowledgebox credential from being replayed as a normal Wabi Bearer or Bot credential?
5. What should happen if the pairing token leaks from shell history, logs, Docker inspection, or a reverse proxy?
6. Is mutual TLS warranted for a later version, or is signed HTTPS event delivery plus token rotation enough for the MVP?

### 3.3 Data-scope review

1. Is per-channel selection sufficient, or must owners select individual pages?
2. Should the default sync payload contain current page bodies only, excluding revisions?
3. How should attachments and embedded images be represented?
4. How do we guarantee that deleted or un-synced content is removed from the knowledgebox's source store, search index, embeddings, caches, and backups?
5. Should the pipe transmit raw markdown, sanitized rendered text, or both?
6. Are wiki pages allowed to contain content that downstream AI should treat as hostile/untrusted data?
7. Should private-page ACLs be represented in the knowledgebox, or should the MVP make one explicit rule: selected wiki channel content becomes readable to the knowledgebox operator?

### 3.4 Abuse and rate-limit review

1. What prevents a compromised or malfunctioning knowledgebox from requesting snapshots repeatedly?
2. Should quotas be per server, per pipe, per channel, per IP, and per operation?
3. What are safe bounds for page size, snapshot size, replay range, queue depth, and reconnect frequency?
4. What happens when the box falls behind: bounded replay, forced snapshot, or operator intervention?
5. Can a reconnect storm degrade normal wiki edits or the rest of Wabi?
6. Is the existing global API limiter enough for ordinary Wabi traffic, with separate pipe quotas for sync traffic?
7. Should the pipe be backpressure-aware so Wabi never waits on the knowledgebox?

### 3.5 AI and prompt-injection review

1. How should the knowledgebox label page text as untrusted data rather than executable instructions?
2. Can a malicious wiki page cause an MCP-connected agent to call tools outside the knowledgebox?
3. Should the knowledgebox return content and provenance separately from any generated summary?
4. Should the first MCP adapter expose only `search` and `get_document`, with no arbitrary URL fetch, shell, write, or Wabi proxy tools?
5. How should citations preserve exact page, section, revision, and source-server identity?
6. What tests demonstrate that a page containing “ignore previous instructions” cannot alter the connector's authorization behavior?
7. Should embeddings be optional and local-only in the MVP to reduce retention and provider leakage?

### 3.6 Operational and self-hosting review

1. Can a normal self-host operator install Wabi and the knowledgebox without managing a second database cluster?
2. Can the companion be stopped, upgraded, backed up, restored, and removed without touching Wabi data?
3. Is a Docker Compose companion acceptable, while keeping the Wabi binary deployment unchanged?
4. What is the simplest LAN-only setup, and what changes when the box is on another machine?
5. What diagnostics must Wabi show: last sync, backlog, last error, destination identity, selected channels, and revoke action?
6. Can a user inspect and delete the knowledgebox's local copy without needing Wabi admin access?
7. What should the documentation say about the knowledgebox operator's ability to read synced content?

### 3.7 Review protocol

Public reviewers should receive:

- a threat model;
- a protocol draft;
- a local Compose fixture with synthetic wiki data;
- a small test client;
- explicit in-scope targets;
- a responsible disclosure contact;
- no production hostname, token, personal data, or real Wabi database.

Ask for findings categorized as:

- protocol flaw;
- authorization flaw;
- data leakage/retention flaw;
- resource exhaustion;
- prompt-injection/agent integration flaw;
- self-hosting/operational hazard;
- documentation/UX ambiguity.

---

## 4. Recommended knowledgebox MVP

### 4.1 Companion responsibilities

The companion owns:

- paired identity and local credential storage;
- a durable source-document store;
- sync cursor and replay state;
- full-text search;
- page/source provenance;
- deletion and tombstone handling;
- a read-only local HTTP API;
- optional MCP adapter after the basic API is proven.

The companion does **not** own Wabi permissions, Wabi users, Wabi writes, or Wabi's canonical page data.

### 4.2 Wabi responsibilities

Wabi owns:

- owner authorization to create/revoke a pipe;
- selected wiki-channel scope;
- durable wiki events;
- outbound delivery or pull-session initiation;
- bounded queue/replay state;
- sync status and operator-visible errors;
- no blocking of wiki edits on companion availability.

### 4.3 Preferred transport for the strong MVP

Use a **paired outbound sync session**, not an unrestricted inbound webhook and not a knowledgebox crawler.

Recommended flow:

1. The knowledgebox starts locally and displays a short-lived pairing code.
2. The owner authenticates to Wabi and confirms the code plus selected wiki channels.
3. Wabi creates a pipe record with a unique pipe ID and scoped secret/key.
4. The knowledgebox establishes an outbound HTTPS connection to Wabi.
5. Wabi sends a bounded initial snapshot for selected channels.
6. Wabi sends ordered wiki deltas over the connection.
7. The knowledgebox acknowledges the highest contiguous event sequence.
8. After disconnect, the box reconnects and resumes from its cursor.
9. If the cursor is outside the replay window, Wabi requires a fresh snapshot.
10. Revocation terminates future sessions and invalidates the pipe credential.

This is more work than “POST to an arbitrary URL,” but it produces a coherent product boundary and avoids requiring Wabi to expose a new public AI-ingest endpoint.

### 4.4 Protocol minimum

Every event should include:

- protocol version;
- pipe ID;
- event ID;
- monotonic server sequence;
- event type;
- channel ID;
- page ID when applicable;
- page title/body or tombstone;
- source server identity/fingerprint;
- content hash;
- source timestamp;
- signature or authenticated session framing.

Required event types:

- `wiki.snapshot.begin`;
- `wiki.snapshot.page`;
- `wiki.snapshot.end`;
- `wiki.page.upserted`;
- `wiki.page.deleted`;
- `wiki.sync.reset_required`;
- `wiki.pipe.revoked`.

Do not send revisions in the first sync payload. Preserve revision support in Wabi, and add revision synchronization only after deletion, replay, and citation semantics are proven.

### 4.5 Knowledgebox API minimum

The first read API should be deliberately boring:

- `GET /health`;
- `GET /status`;
- `GET /collections`;
- `GET /collections/{id}/documents/{document_id}`;
- `POST /collections/{id}/search`;
- `GET /collections/{id}/documents/{document_id}/source`;
- `DELETE /collections/{id}`.

Search responses should include citations/provenance:

- source server fingerprint;
- Wabi channel ID and display name;
- page ID and slug;
- page title;
- section/anchor if available;
- source revision or updated timestamp;
- exact content excerpt;
- canonical Wabi link where one exists.

No arbitrary proxy/fetch endpoint. No Wabi API passthrough. No write endpoint for Wabi. No shell or filesystem tool.

### 4.6 MCP is an adapter, not the core

MCP should be a thin optional adapter around the knowledgebox API. It should expose only:

- `search_wiki`;
- `get_wiki_page`;
- optionally `list_sources`.

It should not expose Wabi credentials, arbitrary HTTP, page writes, shell execution, or “fetch URL.” Retrieved page text must be clearly marked as untrusted source material in the adapter's result contract.

---

## 5. Wiki facelift MVP

The wiki needs to become a useful documentation surface independently of AI. Knowledgebox quality depends on source quality and provenance, so the wiki work comes first.

### 5.1 Experience goals

- Fast page-tree navigation.
- Clear page hierarchy and breadcrumbs.
- Comfortable reading layout.
- Reliable editing with explicit save state.
- Useful search.
- Images and attachments without making the wiki a full publishing suite.
- Simple citations and stable page links.
- Revision history that helps recovery instead of being a drawer nobody uses.
- Mobile-safe layout.

### 5.2 Strong MVP feature set

#### Reading

- Two-pane desktop layout: tree/sidebar + reading pane.
- Breadcrumbs for nested pages.
- Table of contents generated from headings.
- Copy-link and copy-citation actions.
- Stable page slug links.
- “Last updated by / when” metadata.
- Empty, loading, and error states that explain what to do.

#### Editing

- Markdown editor retained as the canonical storage format.
- Split preview/editor mode rather than an immediate block-editor rewrite.
- Heading, bold, italic, link, quote, list, code, table, and image insertion toolbar.
- Drag/drop or file-picker image upload into the current page.
- Uploads stored through existing authenticated Wabi upload/blob paths, with page references recorded in the body.
- Unsaved-change warning and clear save/error state.
- Edit summary field so revisions are meaningful.
- Page move/reorder controls that preserve the existing parent/order model.

#### Citations

Implement citations as first-class page references, not just pasted URLs:

```text
[Source title](https://example.com) — accessed 2026-08-12
```

MVP behaviors:

- insert source URL and title through a small citation dialog;
- render citation links consistently;
- copy a page citation containing server URL, channel, page slug, and updated revision/time;
- allow references/endnotes at the bottom of a page;
- preserve source URL/title/accessed date in markdown-compatible syntax;
- knowledgebox search results reuse the same page and section provenance model.

Do not build a scholarly citation manager or external metadata crawler in the MVP.

#### Search

- Client-side search across the loaded wiki channel as an immediate improvement.
- Server-side search endpoint only when page counts make client search insufficient.
- Search titles, headings, and body text.
- Highlight matching excerpts.
- Keep search channel-scoped by default.

#### Images

- Use a simple attachment/reference model.
- Store image metadata separately from the page record if necessary; do not expand postcard records casually.
- Render responsive images with alt text.
- Keep image uploads authenticated and channel-scoped.
- Defer galleries, image editing, layout canvases, and arbitrary embeds.

### 5.3 Explicitly defer

- Notion-style block database.
- Freeform canvas layout.
- Arbitrary HTML/JS embeds.
- Live multi-user cursor editing.
- Full collaborative conflict-free editing.
- AI-generated page writing.
- Automatic external-page scraping.
- Public wiki access.
- Revisions synchronized to the knowledgebox.

---

## 6. Delivery phases

### Phase A — lock the contract before code

- Record the outbound-pipe architecture in this document and Wabi's top-level documentation.
- Define the threat model and review questions above.
- Define what “selected wiki content” means for the first release.
- Decide whether the MVP companion uses Docker Compose only or also supports a single local binary.
- Define deletion, revocation, replay, and stale-cursor behavior.
- Define the exact citation object returned by Wabi and the knowledgebox.
- Publish a review brief for external feedback using synthetic data.

### Phase B — wiki source-quality foundation

- Audit the current `WikiChannel.svelte`, `wikiStore.ts`, tree component, and wiki styles against the required reading/editing behaviors.
- Add robust page selection/loading state and prevent duplicate `loadWiki` effects.
- Add breadcrumbs, table of contents, copy link, and copy citation.
- Add edit summary persistence into the revision path.
- Add image upload/reference support using existing Wabi upload primitives.
- Add markdown toolbar and split preview without changing canonical storage away from markdown.
- Add channel-scoped search and highlight.
- Add focused frontend tests for parsing, citations, page-tree operations, and search.
- Verify in a real browser; headless Chromium is not an acceptable visual verification path for Wabi.

### Phase C — safe Wabi sync primitives

- Add a separate versioned knowledge-pipe configuration/projection; do not add an ad hoc field to a postcard-encoded channel record.
- Add owner-only pipe creation, list, revoke, and rotate operations.
- Add selected wiki-channel scope.
- Add a bounded event/replay cursor model.
- Add snapshot and delta serialization tests.
- Add deletion/tombstone tests.
- Add pipe-specific quotas in addition to the existing global API limiter.
- Ensure wiki writes never await companion delivery.
- Add sync status for the owner: connected, behind, stale, revoked, last error.

### Phase D — companion knowledgebox

- Create a separate companion project/repository or clearly isolated top-level companion directory; do not make it a Wabi addon that must be compiled into the Wabi binary.
- Provide a minimal Docker Compose deployment with one service and one persistent volume.
- Implement pairing and outbound session establishment.
- Implement snapshot ingestion.
- Implement ordered delta ingestion and acknowledgements.
- Implement cursor persistence and forced snapshot recovery.
- Implement source-document storage and full-text search.
- Implement deletion propagation and local purge.
- Implement read-only API with provenance.
- Add a local CLI or health page for status, reset, export, and wipe.

### Phase E — optional MCP adapter

- Add a separate optional MCP process/container or adapter package.
- Expose search/get/list-sources only.
- Mark returned page material as untrusted source content.
- Add prompt-injection regression fixtures.
- Verify MCP cannot reach Wabi or invoke arbitrary URLs through the knowledgebox.
- Document provider-retention implications for remote models.

### Phase F — external security review and hardening

- Publish the protocol and threat model.
- Ask reviewers to test the disposable Compose fixture.
- Run protocol/property tests for replay, duplicates, gaps, revocation, and deletion.
- Run abuse tests for reconnect storms, snapshot amplification, oversized pages, queue overflow, and repeated replay.
- Run prompt-injection tests against the MCP adapter.
- Fix findings before calling the MVP strong.

---

## 7. MVP acceptance criteria

### Wiki

- A user can create a hierarchical documentation page, read it comfortably, edit it, preview it, attach an image, cite a source, copy a stable citation, search the channel, and recover a previous revision.
- A page edit has an explicit edit summary.
- The interface clearly shows save status and unsaved changes.
- A page citation identifies the Wabi server, channel, page, and revision/update time.
- No new page layout system is required to make the wiki useful.

### Knowledgebox

- Wabi remains fully usable when the companion is stopped, unavailable, slow, or corrupted.
- The owner must explicitly pair a companion and select at least one wiki channel.
- The companion receives only selected current wiki content.
- The companion cannot use its credential as a normal Wabi user or bot credential.
- The companion has no Wabi write capability.
- There is no arbitrary Wabi proxy or URL-fetch capability.
- Duplicate events are harmless.
- Missed events resume from a cursor or trigger a bounded fresh snapshot.
- Deletes remove content from the source store and search results.
- Revocation stops further synchronization.
- Pipe traffic has independent bounds for snapshot size, replay range, queue depth, reconnect frequency, and request rate.
- Search results include exact page provenance and stable citations.
- The knowledgebox can be wiped independently of Wabi.
- MCP, if enabled, exposes search/read only and treats page content as untrusted data.

### Security posture statement

The MVP may claim:

> “Wabi can synchronize owner-selected wiki content to a separately operated knowledgebox through a scoped, revocable, outbound pipe.”

It must not claim:

> “Wabi is safe for AI access,” “AI cannot exfiltrate data,” or “the knowledgebox is a security boundary against a compromised host owner.”

---

## 8. Recommended immediate next actions

1. Treat this document as the architecture decision record and review brief.
2. Ask external reviewers to critique the threat model and protocol shape before implementing the pipe.
3. Build the wiki facelift independently of the knowledgebox so Wabi gains value even if the companion design changes.
4. Define the sync protocol against synthetic fixtures before choosing the companion's search/index technology.
5. Keep the first companion read-only, source-backed, local-first, and disposable.
6. Do not add an AI-facing inbound route to Wabi for the MVP.
7. Do not reuse the general bot credential for knowledge sync.
8. Do not deploy or publish a live challenge target; use a local disposable Wabi instance.

---

## Sources for the external review rationale

- OpenAI, “OpenAI and Hugging Face partner to address security incident during model evaluation”: https://openai.com/index/hugging-face-model-evaluation-security-incident/
- Hugging Face, “Anatomy of a Frontier Lab Agent Intrusion”: https://huggingface.co/blog/agent-intrusion-technical-timeline
- Hugging Face, “Security incident disclosure — July 2026”: https://huggingface.co/blog/security-incident-july-2026
- OWASP GenAI Security Project, “Prompt Injection”: https://genai.owasp.org/llmrisk/llm01-prompt-injection/
- OWASP GenAI Security Project, “Excessive Agency”: https://genai.owasp.org/llmrisk/llm06-sensitive-information-disclosure/
- “Agentic AI Security: Threats, Defenses, Evaluation, and Open Challenges”: https://arxiv.org/html/2510.23883v2
- Palo Alto Networks Unit 42, “AI Agents Are Here. So Are the Threats.”: https://unit42.paloaltonetworks.com/agentic-ai-threats/

These sources motivate the threat model; they do not certify the proposed design or prove that any future model will behave in a particular way.

---

## 9. AI handoff / execution contract

This section is explicit so another AI can continue without re-discovering the architecture or rewriting the repository.

### 9.1 Working-tree safety

The Wabi checkout was dirty when this plan was expanded. Before implementation:

1. Run `git status --short` in `/home/Ronin/wabi`.
2. Treat every pre-existing modified or untracked file as owned by another workstream unless explicitly assigned.
3. Do not stash, reset, checkout, clean, commit, push, or deploy unrelated files.
4. Use path-scoped diffs: `git diff -- <exact-file> ...`.
5. Do not touch `data/`, `data/admin_policies.json`, `data/jwt_secret`, or `docs/wabi-carl-watch.md`.
6. Do not edit `packages/wabi-protocol` by hand; it is generated.
7. Do not deploy. A deploy requires the user's explicit word `deploy` or `push`.
8. If a task overlaps a dirty file, stop and report the collision instead of silently taking ownership.

### 9.2 Required reading before coding

Read these files in order:

1. `/home/Ronin/wabi/AGENTS.md`
2. `docs/architecture/overview.md`
3. `core/crates/wabi-server/src/api/routes.rs`
4. `core/crates/wabi-server/src/api/wiki.rs`
5. Wiki methods in `core/crates/wabi-server/src/adapter/mod.rs`
6. `core/crates/wabidb/src/projections/wiki.rs`
7. Wiki methods in `core/crates/wabidb/src/engine/wabi_store.rs`
8. `frontend/src/lib/components/WikiChannel.svelte`
9. `frontend/src/lib/components/WikiPageTree.svelte`
10. `frontend/src/lib/wikiStore.ts`
11. `frontend/src/styles/components/wiki.css`
12. Existing upload implementations, especially `frontend/src/lib/components/chat/uploadResumable.ts` and `frontend/src/lib/galleryStore.ts`
13. Existing webhook delivery only as a pattern; do not assume it is the final knowledgebox protocol.

### 9.3 Implementation order

Do not start with the knowledgebox container:

1. Wiki contract and UX audit.
2. Wiki facelift primitives and tests.
3. Wiki citation/source model.
4. Wiki image upload/reference flow.
5. Wiki search and stable links.
6. Transport-independent sync protocol fixtures.
7. Wabi pipe configuration and owner controls.
8. Wabi event/snapshot delivery.
9. Companion ingestion and storage.
10. Companion search/provenance API.
11. Optional MCP adapter.
12. Security review fixture and abuse testing.

Each stage must remain useful if the next stage is cancelled.

---

## 10. Detailed task ledger

A task is not complete from a diff alone; it requires the listed verification.

### WIKI-01 — Freeze the current contract

**Files:** no code changes; inspect the files in §9.2.

- Record actual wiki page/revision request and response shapes.
- Record markdown parsing and sanitization behavior.
- Record upload response shape and attachment URL handling.
- Record page-tree ordering and deep-link behavior.
- Confirm whether the frontend uses the backend delete API.

**Verify:** run `bun run check` from `frontend/` before edits and record pre-existing failures. Do not repair unrelated failures.

### WIKI-02 — Extract testable wiki helpers

**Create:** `frontend/src/lib/wikiHelpers.ts` and a focused test file beside it.

Extract pure helpers for page-tree construction, stable sibling ordering, breadcrumbs, citations, heading/TOC extraction, safe search excerpts/highlights, slug normalization, and textarea selection insertion. Keep markdown storage unchanged.

**Verify:** run the repository's narrow frontend test command, then `bun run check`. Tests call helpers, never read source text.

### WIKI-03 — Repair wiki loading lifecycle

**Modify:** `frontend/src/lib/wikiStore.ts`, `frontend/src/lib/components/WikiChannel.svelte`.

- Ignore stale `loadWiki` responses after channel changes.
- Prevent duplicate reactive loads for one channel.
- Clear selection/revisions on channel changes.
- Preserve selection on successful refresh when the page remains.
- Normalize list/create/update responses through one mapper.

**Verify:** regression test for stale response ordering and `bun run check`.

### WIKI-04 — Improve reading surface

**Modify:** `WikiChannel.svelte`, `WikiPageTree.svelte`, `frontend/src/styles/components/wiki.css`.

Add breadcrumbs, page metadata, generated TOC, copy-page-link, copy-citation, and visible feedback. Preserve existing surface chrome and tree-plus-content composition; mobile should collapse the tree rather than create a second app.

**Verify:** real browser at desktop and mobile widths. Headless Chromium is not valid Wabi visual verification.

### WIKI-05 — Make editing safe

**Modify:** wiki editor and styles; add child components only at real boundaries.

Add split editor/preview, dirty/saving/saved/failed states, unsaved-change confirmation, and edit summary. Keep full-body updates and do not introduce autosave.

If summaries persist, inspect `api/wiki.rs`, adapter update path, and revision types. Use a compatibility-safe revision codec strategy; never silently alter postcard records.

**Verify:** old payload and new payload backend tests, frontend check, and real-browser edit/cancel/save/reload flow.

### WIKI-06 — Add small markdown toolbar

Support insertion of headings, emphasis, links, quotes, lists, code blocks, tables, image references, and citation entries. Use textarea selection insertion; do not add arbitrary HTML/JavaScript embeds.

**Verify:** pure selection-helper tests and real-browser keyboard/mouse checks.

### WIKI-07 — Add citations

Use markdown-compatible references:

```markdown
## References

1. [Source title](https://example.com) — accessed 2026-08-12
```

Add a URL/title/access-date dialog, consistent rendering, stable copy citation containing server/channel/page/update metadata, and safe URL handling. Do not scrape external sites. Page text remains untrusted data.

**Verify:** URL escaping, malformed URLs, duplicates, stable output, and copy behavior.

### WIKI-08 — Add images through existing uploads

Inspect `uploadResumable.ts`, `galleryStore.ts`, and backend upload routes first. Reuse the authenticated upload mechanism, enforce MIME/size limits server-side, insert markdown image references with alt text, and render safe responsive images. Do not add a second blob store or casual postcard fields.

**Verify:** upload/reload/render, invalid MIME/oversize rejection, and authenticated access.

### WIKI-09 — Add channel-scoped search

Start client-side over loaded pages. Search title, headings, and body; return safe excerpts/highlights; exclude deleted pages; debounce locally. Defer a server index until scale demonstrates the need.

**Verify:** tests for case, punctuation, empty query, multiple matches, and deleted pages.

### SYNC-01 — Freeze transport-independent protocol

Create protocol schemas and fixtures in the companion project or isolated protocol package. Support snapshot begin/page/end, page upsert, page delete, reset-required, contiguous acknowledgements, duplicate delivery, gaps, source fingerprint, content hash, version, pipe ID, scope, and bounded sizes.

**Verify:** fixtures for duplicates, reordering, gaps, deletion, restart, and snapshot replacement without Wabi or AI dependencies.

### SYNC-02 — Choose companion boundary

Create a separate companion project/repository or approved isolated `knowledgebox/` tree. Default: one container, one volume, one small durable database, local full-text search, no vector database, no AI provider, no Lore dependency, and no Wabi database mount.

Provide README, Compose, secret-only `.env.example`, backup/wipe instructions, and threat-model notes.

**Verify:** clean start, restart with data preserved, wipe removes all indexed data, and no Wabi volume is mounted.

### SYNC-03 — Define pairing identity

Wabi provides owner-only create/list/revoke/rotate controls scoped to selected wiki channels. The companion uses a short-lived single-use bootstrap code and durable pipe identity.

Never reuse `Bot <token>`, make the pipe a normal JWT, print durable secrets in logs, or allow a pairing code to be reused.

**Verify:** expired/reused code, wrong scope, revoked pipe, rotated credential, and attempts to use the pipe on `/api/wiki` or `/api/messages` all fail.

### SYNC-04 — Add Wabi pipe state safely

Inspect existing config/projection, owner-only, sequencer, node, and job identity patterns before choosing paths. Store pipe ID, display name, credential hash/key ID, selected channels, state, acknowledged sequence, snapshot time, last error, and timestamps. Keep page content out of pipe metadata and do not add an ad hoc `aiReadable` channel field.

**Verify:** restart/projection rebuild, owner authorization, bot/non-owner rejection, revocation persistence, and old-data compatibility.

### SYNC-05 — Implement bounded Wabi delivery

Deliver after durable wiki commits, never block wiki writes on the network, support bounded replay or cursor state, per-pipe snapshot/replay/body/queue/reconnect limits, reset-required when replay is unavailable, and delete tombstones. Do not send revisions in protocol v1.

**Verify:** companion unavailable during writes, restart recovery, duplicates, gaps, queue overflow, and rate limits.

### SYNC-06 — Implement companion ingestion

Verify identity/scope; stage and atomically apply snapshots; apply deltas idempotently; reject out-of-scope events; persist cursor after durable application; purge deleted content from source/search; expose stale/reset state.

**Verify:** crash at each snapshot stage, duplicates, partial snapshot, deleted-page search, and malicious out-of-scope events.

### SYNC-07 — Implement read-only knowledgebox API

Expose only health/status, collections, document get/source, search, and collection wipe. Require local/operator auth for non-health routes. Return exact excerpts and source provenance. Do not add arbitrary URL fetch, Wabi proxy/write, shell, or filesystem endpoints.

**Verify:** API contracts and negative tests for every forbidden capability.

### SYNC-08 — Add optional MCP last

Keep it outside Wabi core. Expose search/get/list-sources only. Return source text in an explicitly untrusted-content field. Do not expose filesystem, network client, or Wabi credential.

**Verify:** MCP tests, prompt-injection fixtures, arbitrary URL rejection, and network isolation.

### REVIEW-01 — Publish and run fixture

Build a disposable Compose deployment with synthetic benign and malicious-looking pages. Publish threat model, protocol, scope, setup, and responsible-disclosure instructions. Ask reviewers to attack only the fixture or their own copy. Record findings in a review ledger and fix authorization/retention issues before polish.

**Verify:** independent reproduction, abuse results, and residual-risk write-up.

---

## 11. Handoff commands and verification gates

### Baseline

```bash
cd /home/Ronin/wabi
git status --short
cd frontend
bun run check
cd ..
cargo test -p wabidb
cargo test -p wabi-server
```

If failures arise from unrelated dirty work, record the exact failure; do not repair it under this plan.

### Wiki

```bash
cd /home/Ronin/wabi/frontend
bun run check
STATIC_BUILD=1 bun run build
```

Then use a real browser against local Wabi to verify loading, nesting, search, create/edit/cancel/save, images, citations, revisions, errors, and desktop/mobile composition.

### Companion

```bash
cd /home/Ronin/wabi/knowledgebox   # exact approved path may differ
docker compose config
docker compose up --build -d
curl -fsS http://127.0.0.1:<knowledgebox-port>/health
docker compose down
```

Check Docker availability first. Never use a public endpoint for initial verification.

### Security

Attempt forbidden routes with a pipe credential; use the pipe as normal Bearer/Bot auth; revoke and retry; rotate old/new credentials; send duplicate/reordered/oversized/out-of-scope/stale events; stop the companion during a wiki edit; restart both sides; delete a page and search; place prompt-like text in a page and confirm it remains data in MCP results.

### Claim discipline

Handoff reports must distinguish implemented, unit-verified, build-verified, runtime-verified, browser-verified, security-reviewed, and deployed. Deployment requires explicit authorization and proof. A starting container or successful search is not a security review.

---

## 12. Decisions another AI must not silently change

- Keep knowledgebox separate from Wabi and Lore.
- Keep Wabi as canonical wiki authority.
- Prefer outbound paired sync over direct AI crawling.
- No general AI route, AI writes, bot credential reuse, or arbitrary official webhook path.
- No vector database before source sync/search/provenance/deletion work.
- Keep markdown canonical for the facelift MVP.
- Do not turn the facelift into a full Notion/Excalidraw-style layout editor.
- No arbitrary HTML/JS embeds.
- No postcard record fields without compatibility design.
- Do not touch unrelated dirty files, generated protocol files, deployment state, or secrets.
- Do not claim security guarantees beyond the threat model.

---

## Current workspace note

This plan was authored without modifying the existing dirty Wabi worktree. The repository already contains unrelated concurrent changes; implementation should begin only after path-scoped ownership and the current branch state are confirmed.
