# Wabi UI Upgrade — Full Action Plan for hy3
**Date:** 2026-07-13  
**Author:** Hermes (Grok) after design audit + mock yoink  
**Constraint:** User has ~$5 OpenCode credits — **do not burn credits on exploration**. This plan is self-contained so hy3 can execute surgically with local tools only.  
**Source of truth:**  
- `/var/home/Ronin/wabi/DESIGN_AUDIT_2026-07-13.md` (esp. §11 visual design)  
- Mocks (read-only design refs, do not port React):  
  - `~/Downloads/discord-clone-admin-dashboard-design(4).zip`  
  - `~/Downloads/advanced-collaborative-whiteboard-development (1).zip`  
  - `~/Desktop/Wabi_Mockup/standalone-wabi-ui-mockup(9).zip` (chat cozy — already accepted; leave alone)

---

## Mission (one sentence)
Make Notes, center DMs, and Admin match the **spatial/visual design** of the admin mock (left nav / center work / right ambient) without redesigning the product or burning credits on open-ended agent loops.

## Hard rules
1. **Frontend only** under `/var/home/Ronin/wabi/frontend/` unless a tiny store helper is required.
2. **No commits** unless Ronin explicitly asks.
3. **Tokens only** — no hard Discord blurple / mock orange `#F26522` as production brand. Use `--accent-primary-color`, surfaces, borders.
4. **Do not clamp** right-panel width / kill resize-dock.
5. **Do not touch** cozy chat density (accepted 2026-07-09).
6. **No new features** beyond wiring existing panels into the correct surfaces.
7. Backup before batch:  
   `tar czf ~/wabi-backups/frontend-pre-hy3-ui-$(date +%Y%m%d-%H%M%S).tar.gz -C ~/wabi frontend`
8. After each phase: `cd ~/wabi/frontend && bun run check` (0 errors) + `bun run build`.
9. Prefer small patches over rewrites. Prefer filling the pretty AdminCenterStage shell over polishing AdminTab in 300px.

## Visual design law (carry this in your head)
```
LEFT = navigate (leading edge)
CENTER = primary work (F-pattern: hero metrics → detail)
RIGHT = ambient context (Users / DMs / Notes / Map)
```
- Admin tools belong **center**, not right dock.
- Notes belong **right**, as a **card stack** (not dual-pane list|editor in 300px).
- Center DM: **list left of thread** inside center (~280–320px | flex), not full-bleed side-panel swap.
- Pretty = hierarchy + spacing + one accent, not more chrome.

---

## Phase A — Stop the bleeding (do first; highest visual payoff)

### A1. Notes: mount the real notes UI + narrow layout
**Why:** Right panel "Notes" mounts `QuickScratchpad` (one textarea). `NotesWorkspace.svelte` is orphaned. Mock is multi-note cards.

| ID | Task | Done when |
|---|---|---|
| A1.1 | In `WorkspacePanelHost.svelte`, change `panel.component === 'notes'` from `<QuickScratchpad />` to `<NotesWorkspace …>` with a real `storageKey` from `getKeepNotesStorageKey($currentUser?.id)` (import from `$lib/notesStore` + `currentUser`). | Notes tab shows list + editor, not bare scratchpad |
| A1.2 | Pass sensible props: `title="Notes"`, `emptyMessage`, `placeholder`. | Empty state readable |
| A1.3 | **Narrow mode (critical):** when container width ≤ 320px (or always in right panel), NotesWorkspace must **not** show list + splitter + editor at once. Modes: (a) list of note cards, (b) editor with back button. Use a simple `view: 'list' \| 'editor'` state. | No dual-pane crush in dock |
| A1.4 | Card list visual (yoink mock NotesTab): micro header + add; rows as rounded cards; time + preview; active state uses accent wash; hover actions pin/delete if cheap (delete already exists). | Looks intentional, not form dump |
| A1.5 | Keep QuickScratchpad available only if QuickResources still wants a one-shot pad — do not use it as the main Notes tab. | Main Notes ≠ scratchpad |
| A1.6 | `bun run check` + smoke: create 2 notes, select, edit, refresh (localStorage). | Persists |

**Files (allowed):**  
`src/lib/components/WorkspacePanelHost.svelte`  
`src/lib/components/NotesWorkspace.svelte`  
(optional) `src/lib/notesStore.ts` — only if storage key helpers missing

**Forbidden:** backend notes API, new note types, redesign whole right panel.

---

### A2. Admin: pretty center shell gets real tools
**Why:** AdminCenterStage looks like the mock but is hollow (Phase 2 placeholders). Real tools live in cramped AdminTab on the right.

| ID | Task | Done when |
|---|---|---|
| A2.1 | Map each AdminCenterStage section that already has an AdminTab panel to that panel (or extract shared components). Minimum map: | |
| | `users` → AdminUserList (or equivalent from AdminTab) | |
| | `roles` → RoleNamesPanel | |
| | `channels` → ChannelAccessPanel | |
| | `gates` → RoleGatePanel (+ EmojiRoleRules if fits) | |
| | `payments` → PaymentAccessPanel | |
| | `runtime` → RuntimeTuningPanel + CompressionPanel | |
| | `branding` → FrontendMetadataPanel | |
| | `settings` → remaining server policy bits from AdminTab / sensible placeholder only if truly missing | |
| | `overview` → keep OverviewSection (already good) | |
| A2.2 | Delete or replace all `"coming in Phase 2"` for sections that now have real UI. | Zero Phase 2 for shipped tools |
| A2.3 | Right-panel `admin` entry: **do not** dump AdminTab forms. On select, call `layoutStore.showAdminCenterStage()` (or `centerPanelView.set('admin')`) and optionally open a default section. | Admin opens center stage |
| A2.4 | Preserve AdminTab components as **section content** inside AdminCenterStage main — reuse, don't duplicate 757 LOC. Prefer importing the same panels AdminTab uses. | One source of truth for panels |
| A2.5 | Visual shell stay mock-like: 200px left nav, 48px topbar, content pad ~20–24px, max-width ~1200px, card gaps 12–16px. Use tokens not hardcoded orange where easy. | Shell still pretty |
| A2.6 | `bun run check` + build. Manually: open admin center → each nav item shows real UI. | Navigable |

**Files (allowed):**  
`src/lib/components/AdminCenterStage.svelte`  
`src/lib/components/AdminTab.svelte` (may thin to re-export / open center)  
`src/lib/components/WorkspacePanelHost.svelte`  
`src/lib/components/admin/*` (reuse)  
`src/styles/components/admin-center-stage.css`  
`src/lib/layoutStore.ts` / `layoutStoreStates.ts` if needed for section deep-link

**Forbidden:** implementing full mock sections without backend (audit log, automod, etc.) — leave those as honest empty states with design, not fake "Phase 2" walls if possible: empty state card > sarcastic placeholder.

---

### A3. Center DM: list | thread spatial fix
**Why:** Full-bleed side-panel thread feels empty/awkward. Eye wants list on the leading edge of the stage.

| ID | Task | Done when |
|---|---|---|
| A3.1 | When `activeView === 'dm'` or center DM open: render **two columns** inside center chat surface: left `DmHub`/`DmListPanel` (~280–320px), right `DmConversationView` or empty state. | List stays visible while reading |
| A3.2 | Selecting a conversation updates right column only (not whole-stage swap that loses list). | Context preserved |
| A3.3 | Thread header: remove or hide **dead** voice/video buttons (`on:click={() => {}}`). Keep back/close + move surface if useful. | Honest chrome |
| A3.4 | Align header height ~48px with chat chrome; tokenize hover rgba whites. | Visual consistency |
| A3.5 | Optional P1: cap message column max-width ~720–800px inside thread on ultra-wide. | No 120-char rivers |
| A3.6 | `bun run check`; smoke open hub → pick DM → list still visible. | |

**Files (allowed):**  
`src/lib/components/MainLayout.svelte` (center branch only)  
`src/lib/components/DmHub.svelte`  
`src/lib/components/DmConversationView.svelte`  
`src/lib/components/DmListPanel.svelte` (reuse styles if needed)

**Forbidden:** rewriting message list/composer; changing crypto; new call features.

---

## Phase B — Visual parity (after A is green)

### B1. Right panel default calm strip
| ID | Task |
|---|---|
| B1.1 | Default dock tabs / recent panels prefer: `users`, `dms`, `notes`, `map` (mock strip). |
| B1.2 | Power features (admin open-center, media, reader, transfers, splits) behind overflow / "More" — don't remove capability. |
| B1.3 | Optional: collapsed icon rail visual (48px) matching mock — only if layoutStore already supports collapse cleanly. |

**Files:** `RightPanel.svelte`, `RightPanel.css`, `layoutStore` defaults / workspacePanels order.

### B2. Notes card polish (mock NotesTab)
| ID | Task |
|---|---|
| B2.1 | Color chips (store optional color on LocalNote — only if cheap; else skip). |
| B2.2 | Pin to top (boolean on note + sort). |
| B2.3 | Skeleton / empty states with mono micro-label "Notes — N". |

### B3. Admin overview polish
| ID | Task |
|---|---|
| B3.1 | Ensure 4-col → 2 → 1 responsive breakpoints. |
| B3.2 | Card hover lift + reduced-motion respect. |
| B3.3 | Section headers mono uppercase tracking like mock. |

### B4. DM list row unification
| ID | Task |
|---|---|
| B4.1 | Shared row density: 32px avatar, status dot, unread badge, time-ago, preview 10–11px. |
| B4.2 | Use same language in DmHub + DmListPanel. |

---

## Phase C — Whiteboard studio feel (later)
| ID | Task |
|---|---|
| C1 | Channel list LIVE pill when presence > 0. |
| C2 | Tools lead (left/top of canvas); layers trail (right). |
| C3 | Checkerboard under transparent areas. |
| C4 | Do not port React CanvasStudio; skin live WhiteboardTab only. |

---

## Explicit non-goals (this upgrade)
- Cozy message density changes  
- Backend / WabiDB / calling media  
- Full mock section inventory (bans/automod/webhooks) without APIs  
- OpenCode multi-hour combs (credits)  
- Commits / branch switches  

---

## hy3 master TODO checklist (copy into your tracker)

```
[ ] PRE.0  tarball backup frontend
[ ] PRE.1  read DESIGN_AUDIT_2026-07-13.md §11
[ ] PRE.2  bun run check baseline (note warning count)

[ ] A1.1   NotesWorkspace mounted in WorkspacePanelHost
[ ] A1.3   Notes narrow list|editor mode (no dual-pane crush)
[ ] A1.4   Notes card list visuals
[ ] A1.6   Notes persistence smoke
[ ] A1.x   bun check green

[ ] A2.1   Wire AdminCenterStage sections → real admin/* panels
[ ] A2.2   Remove Phase 2 for shipped tools
[ ] A2.3   Right-panel admin → open center stage
[ ] A2.5   Keep shell spacing (200 / 48 / pad / max-width)
[ ] A2.6   bun check + build green

[ ] A3.1   Center DM two-column list|thread
[ ] A3.3   Remove dead call buttons
[ ] A3.4   Tokenize DM header
[ ] A3.6   bun check + smoke

[ ] B1.*   Right panel calm defaults (after A)
[ ] B2.*   Notes pin/color optional
[ ] B3.*   Admin overview responsive polish
[ ] B4.*   DM list row unify

[ ] C.*    Whiteboard (defer unless Ronin prioritizes)

[ ] DONE   Write short UI_UPGRADE_PASS_<date>.md: files touched, screenshots if any, remaining
```

---

## Suggested execution order for hy3 (same session)
1. PRE backup + baseline check  
2. **A1 Notes** (smallest, high relief)  
3. **A2 Admin** (biggest "pretty mock" win)  
4. **A3 Center DM**  
5. Report; stop. Do B only if A is fully green and Ronin wants more.

## Verification commands
```bash
cd /var/home/Ronin/wabi/frontend
bun run check 2>&1 | tail -5
bun run build 2>&1 | tail -10
```
Manual browser:
- Right panel Notes → multi-note list/editor, not blank pad  
- Admin → center shell with real sections; right admin entry opens center  
- DM mode → list stays left of thread  

## Handoff note to hy3
You are not redesigning Wabi. You are **correcting visual mass**: tools go where the eye expects them (center), ambient stays right, notes become cards, DMs keep a list on the leading edge of the stage. The admin mock is the aesthetic north star for **admin only**; chat cozy is already done. When unsure, re-read DESIGN_AUDIT §11.2–11.6.
