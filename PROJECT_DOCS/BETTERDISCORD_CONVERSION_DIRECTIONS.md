# BetterDiscord Conversion Directions (Wabi)

## Purpose
Document the exact process used to convert BetterDiscord plugin ideas into Wabi-native features.
This is a behavior translation workflow, not raw code copy.

## What "Conversion" Means Here
1. Read plugin behavior and UX intent from BetterDiscord source/pages.
2. Re-implement the behavior in Wabi architecture (Svelte + existing backend/API).
3. Preserve outcome for users, not Discord-specific internals.
4. Ship in phases with test and rollback paths.

## Source Of Truth Docs
- Master plan: `PROJECT_DOCS/PLUGIN_PORTING_MASTER_PLAN.md`
- BetterDiscord catalog cross-analysis: `PROJECT_DOCS/PLUGIN_CROSS_ANALYSIS_BETTERDISCORD.md`
- Grading round 2: `PROJECT_DOCS/PLUGIN_GRADING_ROUND2_BETTERDISCORDPLUGINS.md`
- ZipPreview spec: `PROJECT_DOCS/PLUGIN_SPEC_ZIPPREVIEW.md`
- VideoCompressor spec: `PROJECT_DOCS/PLUGIN_SPEC_VIDEOCOMPRESSOR.md`
- Shared albums spec (ImageFolder track): `PROJECT_DOCS/FEATURE_SPEC_MEDIA_ALBUMS.md`

## Step-By-Step Workflow
1. Intake and grade
- Pull plugin candidate from BetterDiscord list/local plugin folder.
- Grade with the weighted rubric from the master plan.
- Route to `Core` vs `Addon` using the user-approved `+` rule.

2. Extract behavior contract
- Define exactly what users can do in the original plugin.
- Separate required behavior from Discord-only implementation details.
- Write requirements into a Wabi spec doc.

3. Build a Wabi mapping table
- For each plugin behavior, map to:
  - Wabi UI component(s)
  - Wabi data/API path
  - limits/guardrails
  - fallback behavior
- Reject features that violate Wabi constraints (security/perf/scope).

4. Phase the implementation
- Phase 0: Discovery
- Phase 1: MVP
- Phase 2: Harden
- Phase 3: Polish
- Every phase gets scope checklist, test checklist, rollback notes.

5. Implement in Wabi-native code
- Prefer existing Wabi component surfaces first.
- Keep features runtime-gated where needed (desktop/mobile/web differences).
- Add explicit UI failure states; never silently fail.

6. Validate each slice
- Run frontend checks and build.
- Add plugin-specific smoke checks where useful.
- Confirm behavior in packaged desktop runtime when desktop is in scope.

7. Update docs immediately after each slice
- Update spec progress checkboxes.
- Update master plan status row + phase.
- Record decisions and unresolved questions.

8. Promote/ship
- Mark complete only after manual pass + build pass + rollback path.
- Keep backlog items explicit instead of hidden.

## How The Current Conversions Were Done

### 1) ZipPreview (A+, Core)
Source intent:
- Let users inspect ZIP contents without full extraction.

Wabi translation:
- Detect `.zip` attachments in chat.
- Parse ZIP central directory in-browser.
- Render list/tree + sizes + entry counts.
- Add safety limits (archive size cap, entry cap, timeout, malformed archive rejection).
- Add cache + filter/search + retry.

Key implementation files:
- `frontend/src/lib/components/MessageList.svelte`
- `frontend/src/lib/components/ZipPreviewPanel.svelte`
- `frontend/src/lib/zip/zipPreview.ts`
- `frontend/scripts/zip-preview-fixture-smoke.ts`

Validation used:
- `bun run check`
- `bun run check:zip-preview`
- `bun run build:only`

### 2) VideoCompressor (B+, Core)
Source intent:
- Compress oversized videos before upload.

Wabi translation:
- Intercept large video attachments at composer intake.
- Prompt compression modal with presets.
- Run client-side compression path.
- Expose progress/cancel/retry/keep-original controls.
- Gate initial rollout to desktop runtime.

Key implementation files:
- `frontend/src/lib/components/Chat.svelte`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/video/videoCompressor.ts`
- `frontend/src/lib/video/videoCompressionSettings.ts`

Validation used:
- `bun run check`
- `bun run build:only`
- desktop runtime smoke during packaging cycle

### 3) ImageFolder -> Shared Media Albums (B+, Core)
Source intent:
- Persistent, easier media organization and retrieval.

Wabi translation:
- Add persistent albums scoped to channel/DM.
- Add album CRUD + item CRUD.
- Add search/sort/pagination and grid/list browsing.
- Add moderation-aware deletion rules.
- Add message context-menu "add to album" flow.

Key implementation surfaces:
- `frontend/src/lib/components/MediaAlbumsTab.svelte`
- `frontend/src/lib/components/MessageContextMenu.svelte`
- `frontend/src/lib/components/MessageList.svelte`
- API integration through `frontend/src/lib/api.ts`

Validation used:
- `bun run check`
- `bun run build:only`
- manual browse/upload/delete role checks

## Per-Plugin Delivery Checklist
- [ ] Spec file created/updated
- [ ] Grading recorded
- [ ] Phase status recorded in master plan
- [ ] Security/performance limits documented
- [ ] Feature implemented in Wabi-native code
- [ ] Manual tests done
- [ ] Build produced
- [ ] Rollback path documented

## Command Quick Reference
- `bun run check`
- `bun run build:only`
- `bun run check:zip-preview` (ZipPreview fixtures)
- `bun run build:tauri` (desktop packaging path when needed)

## Non-Negotiable Rules Used During Conversion
1. No blind copy/paste from BetterDiscord plugin internals.
2. Preserve functionality, rewrite implementation for Wabi architecture.
3. Keep safety/perf guardrails explicit in both code and docs.
4. Keep progress auditable in `PROJECT_DOCS` after every phase.
