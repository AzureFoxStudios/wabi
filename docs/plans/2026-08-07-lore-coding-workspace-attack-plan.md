# Lore/Coding Workspace — Attack Plan

> **Status:** In Progress
> **Date:** 2026-08-07
> **Author:** Pokee-Isaac (captain), OpenCode workers (deepseek-v4-flash-free)
> **Context:** Brainstormed destination with Ronin. This plan maps build order, dependencies, and explicit non-goals.

---

## Destination (Locked)

Wabi becomes a **creative team HQ** where code lives alongside chat, wiki, forum, and planning. Lore (Epic Games VCS) is the engine. Wabi builds the collaboration layer: policy, review, citations, editor bridge, and timeline.

**Product truths:**
1. **Forks** — Branch inside workspace; clone/export out for true independence. No hosted fork social graph.
2. **Protection** — Fine-grain ref + path policy, role-driven capabilities, channel↔repo binding. Presets are sugar.
3. **Citations** — `^c/` extends existing object-ref system. Pinned (snapshot) + tracking (live). Pin-default in chat.
4. **Edit** — Draft/branch → lightweight review → protected land. Gate on the ref, not the act of typing.
5. **Editor** — Ephemeral code-server session default + warm cache. Sticky personal settings optional.
6. **New files** — First-class create + template scaffold, path-ACL aware.
7. **Fetch** — Authz + concurrency/egress quotas + sparse default + export-as-job. No DRM theater.
8. **Open source** — Optional off-box mirror/publish. Wabi is workshop, not warehouse.

---

## Explicit Non-Goals (v1)

- Full CI product / Actions runners
- Kubernetes, enterprise SAML, supply chain graphs
- Social fork network / "GitHub.com" clone
- DRM / "view-only-no-download" fantasy
- Hosting infinite public forks/clones as a social network
- Rebuilding Lore's binary layer in Git LFS cosplay

---

## Build Order

### Phase 0: Foundation (Policy Engine + Protocol)
**Goal:** Server-side policy that gates what roles can do to what refs and paths.

- **P0.1** — Capability vocabulary: `lore.ref.push`, `lore.ref.merge`, `lore.path.write`, `lore.lock`, `lore.review.approve`, `lore.policy.edit`
- **P0.2** — Ref policy: per-branch/tag rules (who can push, merge, force, delete)
- **P0.3** — Path policy: per-pattern ACLs (`assets/**` → Artist write, `src/**` → Developer write)
- **P0.4** — Role↔capability mapping: existing Wabi roles → lore capabilities
- **P0.5** — Channel↔repo binding: channel binds a Lore repo/view, default branch, role mapping
- **P0.6** — Fetch quotas: per-user concurrency + egress budget, workspace ceiling
- **P0.7** — Audit events: policy changes, egress pause, god-ops logged immutably

**Files:** `core/crates/wabi-server/src/api/lore.rs`, `core/crates/wabidb/src/domain/`, `packages/wabi-protocol/`, `docs/plans/`

### Phase 1: Browser VCS UX (Tree, History, Diff)
**Goal:** See the repo, browse files, view history, blame, diff — in Wabi's workspace.

- **P1.1** — LoreChannel workspace panel: file tree browser, navigation, path breadcrumbs
- **P1.2** — File viewer: syntax-highlighted source, binary preview indicators
- **P1.3** — History: revision list, commit messages, author, timestamp
- **P1.4** — Blame: line-by-line attribution
- **P1.5** — Diff viewer: side-by-side or unified, revision↔revision, branch↔branch
- **P1.6** — Branch/tag picker: list, create, delete, switch
- **P1.7** — Lock status: who holds what lock, acquire/release in UI

**Files:** `frontend/src/lib/components/LoreChannel.svelte`, `frontend/src/lib/loreStore.ts`, new CSS

### Phase 2: Citations — `^c/` Extension
**Goal:** Cite code fragments in chat/wiki/forum. Pinned + tracking modes. Drift UX.

- **P2.1** — Extend `MessageEntityKind` with `CodeFragment` (protocol)
- **P2.2** — Object registry: register code paths, resolve `^c/path:lines@ref`
- **P2.3** — Composer: `^c/` trigger, autocomplete paths, insert citation chip
- **P2.4** — Renderer: citation chip with pinned/tracking badge, hover preview, click → open file
- **P2.5** — Drift detection: tracking citation whose content changed → diff notice + actions (update/pin/open/ignore)
- **P2.6** — Wiki/forum citation embeds: static render of cited fragment with update link

**Files:** `packages/wabi-protocol/`, `frontend/src/lib/objectRefRegistry.ts`, `frontend/src/lib/components/chat/`, `frontend/src/lib/markdown.ts`

### Phase 3: Lightweight Review Flow
**Goal:** Propose change → diff → discuss → approve → merge. One object, not GitHub LARP.

- **P3.1** — Review object: create from branch, diff view, status (open/approved/merged/closed)
- **P3.2** — Inline comments: annotate diff lines, threaded discussion
- **P3.3** — Actions: Approve / Request Changes / Merge / Close
- **P3.4** — Merge gate: check ref policy, execute merge via Lore, record in WabiDB
- **P3.5** — Chat integration: review mentioned in chat → chip → navigate
- **P3.6** — Draft saves: in-browser edits → draft branch → promote to review

**Files:** `core/crates/wabi-server/src/api/lore.rs`, `core/crates/wabidb/`, `frontend/src/lib/components/review/`, protocol

### Phase 4: Templates + New File Creation
**Goal:** Create files from templates, scaffold multi-file structures, path-ACL aware.

- **P4.1** — Template registry: repo-local (`templates/`), workspace library, channel-scoped
- **P4.2** — New file dialog: path autocomplete (ACL-filtered), template picker, create
- **P4.3** — Scaffold packs: multi-file templates as one op
- **P4.4** — Duplicate file: copy existing → new path
- **P4.5** — Lock on create: optional auto-acquire lock for binary paths
- **P4.6** — Open as draft: created file opens in editor workspace

**Files:** `frontend/src/lib/components/lore/`, `core/crates/wabi-server/src/api/lore.rs`

### Phase 5: Editor Sessions (Ephemeral Code-Server Bridge)
**Goal:** Open real editor in Wabi workspace, ephemeral by default, warm cache.

- **P5.1** — Session lifecycle: create, hydrate (sparse Lore sync), idle TTL, destroy
- **P5.2** — OpenVSCode embed: iframe or WebSocket proxy to ephemeral code-server
- **P5.3** — Sparse checkout: hydrate only touched paths from Lore
- **P5.4** — Commit/push from editor: integrate with Wabi's review/draft model
- **P5.5** — Personal sticky volume: editor settings, extensions, shell history (not repo)
- **P5.6** — Warm cache: read-only deps/build cache keyed by revision hash
- **P5.7** — Presence: "Ronin editing player.rs" visible in workspace

**Files:** `frontend/src/lib/components/editor/`, `core/crates/wabi-server/`, infrastructure config

### Phase 6: Activity Timeline + Push Calendar
**Goal:** Git activity feed, contribution heatmap, release tracking.

- **P6.1** — Activity feed: commits, reviews, merges, locks, releases — formatted timeline
- **P6.2** — Push calendar: contribution heatmap, filterable by author/path/time
- **P6.3** — Release management: tags, release notes, artifact attachment
- **P6.4** — "What's Cooking" digest: open reviews, stale branches, conflicts
- **P6.5** — Lore notification subscriptions → Wabi real-time events

**Files:** `frontend/src/lib/components/timeline/`, `core/crates/wabi-server/`, `loreStore.ts`

### Phase 7: Governance Polish
**Goal:** Admin controls, audit, capability split, incident tools.

- **P7.1** — Admin UI: policy editor (ref + path), capability assignment
- **P7.2** — Audit viewer: immutable log of god-ops, policy changes, egress actions
- **P7.3** — Incident tools: freeze user fetch, pause workspace egress, revoke tokens
- **P7.4** — Device/session management: list, revoke per-user
- **P7.5** — Clone token management: scoped tokens, expiry, revoke

**Files:** `frontend/src/lib/components/admin/`, `core/crates/wabi-server/src/api/`, `loreStore.ts`

---

## Dependency Graph

```
P0 (Policy Engine) ──────────────────────────────────────────────────┐
  │                                                                  │
  ├─→ P1 (Browser VCS UX) ──→ P2 (Citations)                       │
  │        │                  │                                      │
  │        │                  └─→ P3 (Review) ──→ P5 (Editor)       │
  │        │                         │              │               │
  │        │                         │              └─→ P6 (Timeline)
  │        │                         │                          │
  │        ├─→ P4 (Templates) ───────┘                          │
  │        │                                                     │
  │        └─────────────────────────────────────────────────────┘
  │
  └─→ P7 (Governance) — can run in parallel with P1-P6
```

**Critical path:** P0 → P1 → P3 → P5 (editor needs policy, review, and tree)

---

## Worker Dispatch Strategy

- **Captain:** Pokee-Isaac (architect, prioritize, verify, integrate)
- **Workers:** OpenCode (deepseek-v4-flash-free), 2-3 parallel
- **Pattern:** Write prompt → dispatch → verify diff → integrate → commit
- **Gate:** `cargo check` + `bun run check` green before commit

---

## First Dispatch

Starting with **P0.1-P0.4** (capability vocabulary + ref policy + path policy + role mapping) as the foundation everything else depends on.