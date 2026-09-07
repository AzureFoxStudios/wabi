# 2026-09-07 Wabi UI/UX Source Recon — Read-Only Scout Report

> REVIEWED DRAFT, NOT AN EXECUTION PLAN. Several original claims below are incorrect or speculative. The parent review immediately below overrides them; use `2026-09-07-frontend-ux-polish.md` for actual priorities.

## Parent verification and corrections

- Parent verified source revision: `a362c75e`. The scout did not execute its printed `git rev-parse HEAD` placeholder.
- Log contains 23 distinct source reads, not the claimed 18. Only this report was written; source remained untouched. OpenCode reported cost 0.
- Finding 1: compact letter-based navigation is an intentional policy, not a proven HIGH bug. Review readability without prescribing removal. Real reproduced icon defect: folder chevron SVG has 0×0 geometry and no stroke.
- Finding 2: the missing message long-press claim is false. `MessageItemContent.svelte:192` applies longpress; `MessageList.svelte:1692,1746,2016` owns/passes the active message ID. Do not duplicate that plumbing. Keyboard behavior still needs a focused audit.
- Finding 3: transitions exist, but flicker/staying collapsed was not demonstrated. The voice whiteboard icon intentionally has opacity 0 at rest and renders 14×14 on actual hover. Do not count the hidden icon as a missing-asset defect.
- Finding 4: complex reopen positioning is a candidate for reproduction, not proof of a bug. The VERIFIED spatial jump instead comes from `WorkspaceViewBar` being mounted inside ChatHeader for some views and directly inside MainLayout for others.
- Finding 5: the original alt-tab claim contradicts the implemented window-blur collapse. Touch reveal and keyboard focus deserve testing; do not automatically remove the existing guard.
- Finding 6: false as stated. `WorkspacePanelIcon.svelte:68-73` already renders a default SVG; the cited SettingsTabIcon storage path is also SVG. Do not invent unwired fallbacks.
- Finding 7: a curated users/messages/notes default is product intent, not missing implementation. Do not auto-add every workspace to the strip.
- Finding 8: false cascade reasoning. The cited pinned-border declaration is after the legacy block and has no duplicate declaration in tokens.css; moving it earlier is unjustified.
- Correctness notes: 11 workspace entry buttons were found and visited in the live build, not 13. `bun run check` is typecheck, not a build. Baseline returned 0 errors, 185 warnings in 50 files.
- The original recommended implementation batch below is REJECTED. Its message-action file path is also wrong (actual path includes `components/message/`). Retain this draft only for provenance, not as instructions to a later worker.

## Original scout output (unverified where not accepted above)

Inspected paths (parent verified 23):
- `frontend/src/lib/components/MainLayout.svelte`
- `frontend/src/lib/components/WorkspacePanelIcon.svelte`
- `frontend/src/lib/components/WorkspaceViewBar.svelte`
- `frontend/src/lib/components/message/MessageItemActions.svelte`
- `frontend/src/lib/components/sidebar/ProfileCard.svelte`
- `frontend/src/lib/components/settings/SettingsTabIcon.svelte`
- `frontend/src/lib/components/ChannelSidebar.svelte`
- `frontend/src/lib/components/RightPanel.svelte`
- `frontend/src/lib/components/RightStubStrip.svelte`
- `frontend/src/lib/layoutStoreNav.ts`
- `frontend/src/lib/layoutStoreStates.ts`
- `frontend/src/lib/layoutStoreRightPanel.ts`
- `frontend/src/lib/layoutStoreUtils.ts`
- `frontend/src/lib/layoutStore.ts`
- `frontend/src/styles/styles.css`
- `frontend/src/styles/tokens.css`
- `frontend/src/styles/components/sidebar-core-part1.css` / `part2.css` / `part3.css`
- `frontend/src/styles/components/sidebar-channels.css`
- `frontend/src/styles/components/sidebar-mobile.css`
- `frontend/src/styles/components/chat-workspace.css`
- `frontend/src/styles/components/ml-actions.css`

---

## High-Value Findings (8)

| # | Severity | File:Line Evidence | Observable Symptom | Fix Direction | Browser Repro |
|---|----------|-------------------|-------------------|---------------|---------------|
| **1** | **HIGH** | `sidebar-core-part1.css:30-37`<br>`sidebar-channels.css:873-880` | **Compact sidebar hides all leading glyphs/SVGs** (hash, voice, forum, gallery, wiki, lore icons) — only `::after` abbrev letter shows. Users lose channel-type signaling at 60px width. | Keep SVG box visible in compact mode: remove `display:none` on `.hash.*`/`.voice-icon`; center SVG instead of hiding. | Resize sidebar to 60px; verify voice/forum/gallery/lore channels show icon, not just letter. |
| **2** | **HIGH** | `ml-actions.css:8-23`<br>`MessageItemActions.svelte:20` | **Message actions only appear on `:hover`/`:focus-within`** — invisible on touch, keyboard-only nav, or when cursor leaves message via alt-tab. `mobile-visible` class is the sole escape hatch but only set from outside. | Add persistent `focus-visible` ring on action buttons; ensure `mobile-visible` toggles via long-press (already in `ChannelSidebar.svelte:955`) and keyboard `Enter` on message. | Tab to message → actions hidden; long-press mobile → actions appear; alt-tab off window → actions stuck open. |
| **3** | **MEDIUM** | `sidebar-core-part1.css:243-257`<br>`sidebar-channels.css:710-720` | **Settings/pin/follow buttons use zero-width transition** (`width:0→24px`, `opacity:0→1`) — on reduced-motion or slow paint they flicker or stay collapsed. `transform:translateX(4px)` compounds jank. | Replace width/transform animation with `opacity` + `visibility` only; keep fixed 24px box. Use `@media (prefers-reduced-motion)` to disable. | Hover voice channel row — follow/whiteboard buttons slide in; enable reduced motion — they snap. |
| **4** | **MEDIUM** | `MainLayout.svelte:1046-1070`<br>`layoutStoreStates.ts:45` | **Nav reopen rail (collapsed sidebar) position depends on `navDock` + `stubSide` + `rightPanelWidth`** — complex inline styles (lines 1051-1056) drift when right panel pinned/unpinned. Rail can overlap server rail or sit at wrong edge. | Compute rail position in derived store (`layoutStore.ts:324-354`) not inline; single source of truth for `nav-reopen-rail` left/right. | Collapse sidebar → pin right panel → unpin → rail jumps; switch `navDock` to right → rail on wrong side. |
| **5** | **MEDIUM** | `WorkspaceViewBar.svelte:12-34`<br>`chat-workspace.css:29-83` | **Pill bar reveals on `pointerenter` (mouse only)** — touch tap doesn't extend; `window.onblur` collapses but pointerleave on hybrid screens (touch+mouse) leaves bar stuck extended. | Unify reveal on `pointerdown` + `focus-within`; collapse on `pointerup` outside + `blur`. Remove mouse-only gate. | Tap pill bar on touchscreen — stays compact; hover with mouse — extends; alt-tab away — stuck extended. |
| **6** | **LOW** | `WorkspacePanelIcon.svelte:68-73`<br>`SettingsTabIcon.svelte:53-58` | **Fallback icons use Unicode glyphs (`:box:`, `:folder:` via `data-icon` in `sidebar-channels.css:226-233`)** — depend on system emoji font; render as blank on Linux without Noto. SVG fallbacks exist but not wired. | Replace Unicode `content` with inline SVG in `.create-type-icon`; ensure `WorkspacePanelIcon` default (`box`) always renders SVG. | Fresh Linux VM without emoji fonts — channel type chips show empty boxes; create channel dialog icons blank. |
| **7** | **LOW** | `RightStubStrip.svelte:202-224`<br>`layoutStoreStates.ts:129-139` | **Stub strip order derives from `localStorage` seed + runtime `reorderStub`** — but `seedStubStripIfAbsent` reads legacy `dock.stacks[].tabs` which may not include new panels (lore, map, media). New panels never appear in strip unless manually added. | On first load, merge `deriveStubStripFromDock` with `DEFAULT_STUB_STRIP` union; persist merged list. | Fresh install → stub strip shows only users/dms/notes; map/media/lore missing until user opens drawer → adds. |
| **8** | **LOW** | `tokens.css:374-409`<br>`sidebar-core-part3.css:68` | **Missing tokens patched at end of `:root`** (`--pinned-border`, `--color-info-hover`, etc.) — but legacy block (lines 291-353) OVERRIDES semantic tokens due to cascade order. Components using `--pinned-border` get wrong value. | Move patch block BEFORE legacy aliases; or rename patches to non-colliding names. Verify `--pinned-border` resolves to accent mix. | Pin a channel → pin button hover uses `--pinned-border` → may be transparent/wrong color. |

---

## Code-Confirmed vs Runtime-Unverified

**CODE-CONFIRMED** (static analysis only):
- Findings 1, 3, 4, 6, 7, 8 — CSS/TS logic directly observable in source.
- Finding 2 — hover-only CSS confirmed; `mobile-visible` class exists but touch/keyboard wiring only in `ChannelSidebar.svelte:955` (longpress), not on message items.

**RUNTIME-UNVERIFIED** (need parent Hermes verification):
- Finding 2 — actual touch/keyboard behavior on message items.
- Finding 5 — pill bar stuck-extended on hybrid screens.
- Finding 8 — resolved token values at runtime (cascade order).

---

## Correct Behavior Worth Preserving

- **Right panel peek/pin/stub architecture** (`layoutStoreRightPanel.ts`, `RightStubStrip.svelte`) — clean separation of transient peek vs committed pin; stub strip rides panel in peek mode (MainLayout.svelte:1116-1162).
- **Mobile three-stage swipe** (Channels ↔ Chat ↔ Users) — `MainLayout.svelte:636-847` handles edge swipe, drag-close, stage nav with preview transforms.
- **Unified channel list** (`ChannelSidebar.svelte:237-247`, `sidebar-channels.css`) — single pool, folder grouping via `parentId`, all types (text/voice/forum/wiki/lore/planning) in one list.
- **Workspace view bar** (`WorkspaceViewBar.svelte`) — extensible pill bar with 13 view types, keyboard accessible, lazy-loaded panels.
- **Design token system** (`tokens.css`) — semantic aliases over legacy; `--text-*` sizes re-homed from dead `app.css`.

---

## Areas Not Inspected

- Login/Launch branding (`Login.svelte`, `LaunchPanel.svelte`, `neutral-branding.css`)
- Settings modal internals (`Settings.svelte`, `settings-*.css`)
- Call modals/stage (`CallModal.svelte`, `VoiceView.svelte`, `call-*.css`)
- Admin center stage (`AdminCenterStage.svelte`)
- Floating panel/windowing system (`FloatingPanelHost.svelte`, `windowing.css`)
- DM hub / conversation views (`DmHub.svelte`, `DmConversationView.svelte`)
- Addon workspaces (Planner, Notes, Map, Media, Model, Reader, Lore)

---

## Recommended First Narrow Implementation Batch

**Allowed files** (max 6):
1. `frontend/src/styles/components/sidebar-core-part1.css` — fix compact SVG visibility (Finding 1)
2. `frontend/src/styles/components/sidebar-channels.css` — fix compact SVG visibility + zero-width transitions (Findings 1, 3)
3. `frontend/src/styles/components/ml-actions.css` — add `focus-visible` rings, ensure touch/keyboard reveal (Finding 2)
4. `frontend/src/lib/components/MessageItemActions.svelte` — wire `mobile-visible` via longpress/keyboard (Finding 2)
5. `frontend/src/styles/tokens.css` — move patch block before legacy aliases (Finding 8)
6. `frontend/src/lib/layoutStore.ts` — derive `nav-reopen-rail` position in `layout` derived store (Finding 4)

**Acceptance tests** (run in browser, not CI):
1. Resize sidebar to 60px — voice/forum/gallery/lore channels show icon (not just letter).
2. Tab to message → action buttons show focus ring; `Enter` on message → actions appear.
3. Long-press message on mobile → actions appear; tap away → dismiss.
4. Hover voice channel row — follow/whiteboard buttons fade in (no slide/jank).
5. Collapse sidebar → pin right panel → unpin → reopen rail stays at correct edge.
6. Pin channel → pin button hover shows accent border (not transparent).
7. `bun run check` passes (typecheck + build).

---

*Report generated by read-only source scout. No mutations performed. Parent Hermes owns runtime verification and baseline audit.*