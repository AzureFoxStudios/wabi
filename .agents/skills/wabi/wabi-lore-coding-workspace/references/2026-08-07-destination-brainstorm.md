# Wabi Lore/Coding Workspace — Destination Brainstorm (2026-08-07)

Session with Ronin to lock the product destination for the Lore/coding workspace before planning implementation.

## Context

Ronin wants Wabi to be a "steadfast" tool for programmers. He hates making versions — wants to understand the final product first. Quality is a high desire. He's open to adding vital QoL features for programmers.

## Lore VCS Reality Check

Lore (Epic Games) is a binary-first VCS with chunking, dedup, locks, branches, merge, rebase, sparse views, shared stores, and notification subscriptions. It's a VCS engine, not GitHub. Wabi builds the collaboration layer on top.

## Locked Decisions

### 1. Forks: Branch In, Clone Out
- **Problem:** Hosted forks on the same machine = storage bloat + bad-actor attack surface.
- **Decision:** Branch is the primary divergence verb. True independence = clone/export out to user's disk or their Lore server. No "Fork" button in main UI. Server-side partition only as gated advanced feature with quotas.
- **Closed source:** Almost never needs hosted forks. Branch + path ACLs + export covers it.

### 2. Protection: Fine-Grain Policy, Not Just Presets
- **Decision:** Ref policy (branch/tag rules) + path policy (per-path pattern) + role-driven capabilities.
- **Channel ↔ repo binding:** Channels bind views, sparse filters, default role mappings. Join `#art-characters` → you already have write to the right paths.
- **Presets** (Solo/Team/Strict) are optional on-ramps; policy is the real product.
- **Game-team superpower:** Path policy funnels artists to `assets/**`, not `src/**`. Server refuses the write, not a tutorial.

### 3. Citations: Both Pinned + Tracking
- **Decision:** Extend `^` object ref system to code (`^c/path:lines@ref`).
- **Pinned** (to revision) = snapshot, reproducible. **Tracking** (follows branch) = living reference.
- **Pin-default in chat** (conversation is a moment); tracking for dashboards/wiki.
- **Visible badge** on every chip. Drift UX: diff notice → Update/Pin/Open/Ignore. Never silent rewrite.

### 4. Edit Flow: Draft → Review → Protected Land
- **Decision:** Free edit into draft/branch; protect the *landing* into protected refs.
- Lightweight review (diff + discuss + Approve/Request Changes/Merge).
- **Never make chat the only editor.** In-browser for navigation, small fixes, review. Serious work → real editor.

### 5. Editor Bridge: Ephemeral Default
- **Decision:** Ephemeral code-server per-session, sparse Lore checkout. Warm caches + optional sticky personal settings.
- **Why ephemeral:** Matches Lore sparse model, multi-role workspace, clean failure domain, security (short-lived creds).
- Escape hatch: "Persistent dev box" per project (Advanced, with rot warning).

### 6. New Files: First-Class Templates
- **Decision:** Create + template scaffold, path-ACL aware. Role-aware menu (Artist sees art templates and legal paths only).
- Template sources: repo-local, workspace library, channel-scoped.

### 7. Download Security: Auth + Quotas + Sparse
- **Decision:** Auth on all blob endpoints. Per-user concurrency + daily egress quota. Workspace ceilings.
- Sparse/list cheap; full export = background job + quota. No anonymous clone.
- **No DRM theater:** Read means bytes for trusted members. Trust the boundary at *who is in the workspace*.
- Admin governance: capability split + audit + friction for god-ops.

### 8. Open Source Distribution: Workshop ≠ Warehouse
- **Decision:** Wabi = collaboration HQ. Optional "publish/mirror" to external remote or object storage.
- Wabi shows release notes, tag, checksum, link — without being the bulk byte hose for the world.

## Explicit Non-Goals (v1)
- Hosted fork social graph.
- Full CI/CD product or Actions runners.
- Kubernetes, enterprise SAML, supply chain graphs.
- DRM / "view-only-no-download" fantasy.
- Rebuilding Lore's binary layer in Git LFS cosplay.
- Social forks/stars network.

## Build Dependencies (High-Level)
1. Policy engine (ref + path + role capabilities) — everything else gates on this.
2. Browser VCS UX (history, blame, diff, branches).
3. Citations `^c/` extension — reuses existing `^` object ref system.
4. Review object (diff + discuss + approve/merge).
5. Templates + new file creation — path-ACL aware.
6. Editor sessions (ephemeral code-server).
7. Activity/timeline (push feed, contribution heatmap).
8. Tags/releases.

## Key Files
- Backend: `core/addons/lore/backend/`, `core/crates/wabi-server/src/lore.rs`
- Frontend: `frontend/src/lib/components/LoreChannel.svelte`, `frontend/src/lib/loreStore.ts`
- Protocol: `packages/wabi-protocol/src/generated/MessageEntityKind.ts`
- Object refs: `frontend/src/lib/objectRefRegistry.ts`
- Docs: `docs/addons/lore.md`, `docs/proposals/lore-integration-workspace-vision.md`