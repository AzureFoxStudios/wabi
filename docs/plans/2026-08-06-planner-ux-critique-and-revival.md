# Planner / Business UX Critique & Revival Plan

**Date:** 2026-08-06  
**Scope:** Calendar · Kanban (Board) · Journal · Projects · Tasks · Planner shell  
**Bar:** Same as Settings — space-first, no squished text buttons, every control makes sense, theme-connected to main Wabi (not a second product).  
**Reference that worked:** standalone `wabi.chat/business` / `BusinessSurface.svelte` — denser hub chrome, real stats, full nav.  
**What users hit in main app today:** thin `PlannerWorkspace.svelte` tab in center stage.

---

## 0. Executive diagnosis

| Layer | Reality |
|-------|---------|
| **Data** | Still solid local-first module: `frontend/src/lib/business/*` (todos, projects, calendar, diary, sprints, localStorage). |
| **Full hub** | `BusinessSurface.svelte` + `businessPage.css` + `--biz-*` theme — the “looked okay” surface. |
| **Main-app shell** | `PlannerWorkspace.svelte` (~99 lines) is a **stub host**: tabs + dead **New** + fake stats (always `0`) + embeds Calendar/Kanban/Diary/Projects **without** hub chrome. |
| **CSS** | Three palettes fighting: main app tokens, `--planner-*` (orange accent), `--biz-*` (nullframe charcoal/orange). Kanban/Calendar/Diary CSS still hard-depend on `--biz-*`. |
| **Integration plan** | `docs/plans/2026-07-28-business-into-main.md` called for Business as first-class surface; main path became “Planner pill” instead of full hub revival. |

**Core product truth:** Users don’t want a second “Business Hub” brand inside chat. They want **Planner** as a first-class workspace that **feels as complete as `/business`**, unified with Wabi chrome.

---

## 1. Structural problems (must fix before polish)

### 1.1 Dual surfaces (confusion + half features)

```
Main app → PlannerWorkspace (thin)
              ├─ Calendar
              ├─ KanbanBoard
              ├─ DiaryView
              └─ ProjectsView

/business → BusinessSurface (full hub)
              ├─ same children
              ├─ real quick stats
              ├─ task side panel
              ├─ import/export
              ├─ privacy toggle
              └─ optional chat sidepanel
```

**Issues**
- Feature parity broken: import/export, guest, real stats, task panel wiring live on hub only.
- Two headers when both shells try to own tabs (Planner tabs + each view’s own header).
- “Board” vs “Kanban” naming split.

**End state**
- **One host:** `PlannerWorkspace` becomes the real shell (absorb BusinessSurface behaviors worth keeping).
- `/business` → redirect into main Planner (already partially true; finish honestly).
- Child views stop shipping competing full-width “app headers” when hosted; they expose **content + optional secondary toolbar only**.

### 1.2 Dead / lying UI in Planner shell

| Control | Bug |
|---------|-----|
| **New** | `handleNew()` no-ops (sets calendar to calendar). |
| **Stats strip** | Hardcoded `Overdue/Today/This week/Upcoming → 0`. |
| **Task panel toggle** | Flips `rightPanelView` to `'tasks'` but doesn’t guarantee TaskPanel mount/content parity with hub. |
| **LOCAL badge** | Correct for storage, but reads like a beta sticker; prefer subtle “On this device” in footer/settings, not a loud chip. |

### 1.3 Token / theme split

- `PlannerWorkspace.css` uses orange `--planner-accent` defaults (`#f36b21`) while main Wabi is indigo.
- Kanban/Calendar/Diary styles: `var(--biz-bg-secondary)`, `var(--biz-accent)` etc.
- Memory preference: **Planner = unified main-app tokens (no `--biz-*`)** — still not done for child CSS.

**End state**
- Scope once: `.planner-surface { /* map --biz-* → main tokens for transition */ }` then delete `--biz-*` from child CSS in a dedicated pass.
- Accents = `--accent-primary-color` / `--accent-secondary-color`.
- Surfaces = `--surface-base|raised|sunken`, text = `--text-*`, radii/space from tokens.

### 1.4 Auth header corruption (functional)

`KanbanBoardImpl.svelte` user fetch uses broken `Authorization: *** ${authToken}` pattern (same class of bug as Profile uploads). Assignee picker can silently fail.

---

## 2. UX critique by surface

### 2.1 Planner chrome (host)

**What’s wrong**
- Tabs are fine conceptually (segmented control) but sit next to a **lying primary CTA**.
- Stats strip wastes a full row of chrome for zeros — worse than no stats.
- No density awareness of nested headers (Calendar still has big header with Today / + Add Event).
- No empty-state story for “first open, no data.”

**Target chrome (space-first)**
```
[ Planner ]  ( Calendar | Board | Journal | Projects )     [ + New ▾ ]  [ Tasks ]
```
- **+ New ▾** context menu: Event / Task / Journal entry / Project (by active tab default).
- Stats: **only show non-zero badges**, or a single compact line `3 overdue · 2 today` — never four zero pills.
- Tasks = icon+label button with min-height 36px, not a lone 32px glyph.

### 2.2 Kanban / Board (revival priority)

**Why `/business` felt better**
- Full board header: filters (project/priority), column settings, add task, clear layout.
- Amber/charcoal instrument look was intentional and readable.
- Columns + cards have hierarchy (title, meta, assignee, priority).

**What’s wrong inside main Planner**
- Board is dropped into `.planner-view` with padding; double chrome + `--biz` colors look like a foreign iframe.
- Header buttons risk **squish**: small padding (`0.5–0.6rem`), mixed text+icon without min-width / gap discipline.
- Column settings / manage columns UX is powerful but visually “admin form in a drawer,” not calm product UI.
- Drag-and-drop works; empty columns need a real drop target + “Add task” ghost card.

**Revival goals**
1. **Visual:** map to Wabi glass/indigo; keep kanban readability (column color rails OK as status, not orange-everything).
2. **Header (one row):**  
   `Board  ·  Project filter  ·  Priority  ·  [Columns]  ·  [+ Task]`  
   No second “Kanban” title if Planner already says Board.
3. **Cards:** title 1–2 lines, meta row (priority chip · due · assignee avatar), no wall of buttons on card face — actions on hover/menu.
4. **Columns:** min-width ~280px, horizontal scroll, not compressed equal flex that squishes labels.
5. **Modals:** Task modal uses main settings-style inputs (focus ring, not raw dark form).

### 2.3 Calendar

**Strengths**
- Month grid + day/event modals exist; Today / Add Event clear.

**Problems**
- Header competes with Planner header (two “toolbars”).
- Nav as bare `←` `→` text buttons can look like broken links when styles miss.
- Event chips in cells can overflow/squish on dense days — need +N more.
- Complete-control as raw `✓` span is easy to miss / misclick.

**Target**
- When hosted: calendar toolbar is **secondary** (month title + chevrons + Today + Add) — compact, 40px, no page title.
- Day cell: max 3 events visible + overflow.
- Event modal: same control language as Profile/Settings.

### 2.4 Journal (Diary)

**Strengths**
- List + editor split is the right IA.

**Problems**
- Welcome / empty CTAs are long text buttons (“+ New Entry for Today”, “Write Your First Entry”, “Start Writing”) — same action thrice.
- Edit/Delete/Today row can wrap into squished button soup on narrow center stage.
- Image upload block is heavy for default view.

**Target**
- One primary: **New entry** (today). Secondary: date nav.
- List rows are the browse UI; editor chrome minimal.
- Destructive Delete behind confirm; not always-visible red text button.

### 2.5 Projects

**Problems (typical of this module)**
- Sidebar + detail can feel like a third app.
- Project cards / list actions often mix icon-only and long labels inconsistently.

**Target**
- Projects = portfolio list → detail (sprints/tasks summary).
- Creating a project from Planner **New ▾** lands you in detail with empty state, not a dead click.

### 2.6 Tasks panel

**Hub behavior:** docked side panel with width, todos, filters.  
**Planner behavior:** icon toggles layoutStore right panel — easy to open empty/wrong host.

**Target**
- Prefer **in-planner split** (optional right column inside `.planner-surface`) so leaving chat right-panel semantics alone.
- Or register a real `tasks` right-panel view that mounts `TaskPanel` with business store init guaranteed.

---

## 3. Control design rules (anti-squish law)

Apply everywhere in Planner (same spirit as Settings pass):

1. **Min touch/click:** height ≥ 36px (desktop), padding `0.5rem 0.85rem` text buttons.
2. **No orphan text buttons** without border/background in a toolbar (ghost OK only with hover + min size).
3. **Segmented tabs** for view switch; don’t mix 6 different button classes in one header.
4. **Icons:** 18px optical, 36×36 hit target; if label needed, `icon + gap + label`, never icon crammed in 24px with 10px type.
5. **Primary = one per toolbar.** Secondary = quiet. Destructive = explicit.
6. **Don’t ship controls that don’t work** (remove or wire New).
7. **Don’t show zero-state metrics** as four badges.
8. **Nested headers:** max one “app” header (Planner) + one optional local toolbar.

---

## 4. Information architecture (end state)

```
ChatHeader / workspace: Planner
└─ PlannerWorkspace (only host)
   ├─ chrome: title · view switch · New ▾ · Tasks
   ├─ optional compact status line (non-zero only)
   └─ body:
        Calendar | Board | Journal | Projects
   └─ optional Tasks split / drawer
```

**Data:** keep `lib/business` local-first for v1; label storage honestly in Planner settings gear later (“Data on this device · Export/Import”).

**Chat integration (later phase):** deep-link from message → task/event (see `2026-07-18-chat-object-refs-kanban.md`) — after shell revival.

---

## 5. Phased work plan

### Phase A — Honesty + host revival (P0, ~1–2 days)

**Goal:** Planner stops lying; New works; stats real; one clear chrome.

| # | Task | Files |
|---|------|--------|
| A1 | Wire **New ▾** by view: calendar→add event, board→add task, journal→today entry, projects→add project | `PlannerWorkspace.svelte`, child open-modal APIs |
| A2 | Bind stats to `overdueTodos` / `todaysTodos` / week helpers from business store; hide zeros | `PlannerWorkspace.svelte`, `store.ts` |
| A3 | Ensure business store `loadFromStorage` runs when Planner mounts | `PlannerWorkspace.svelte`, `store.ts` |
| A4 | Task toggle mounts real TaskPanel (in-surface split preferred) | `PlannerWorkspace.svelte` |
| A5 | Remove loud LOCAL badge or demote | CSS + markup |
| A6 | Fix Kanban `Authorization: Bearer` user fetch | `KanbanBoardImpl.svelte` |

**Exit:** Opening Planner shows real data counts; New creates something; assignees can load.

### Phase B — Token unification (P0/P1, ~1–2 days)

| # | Task |
|---|------|
| B1 | On `.planner-surface`, alias `--biz-*` → main semantic tokens (compatibility shim) |
| B2 | Restyle Planner chrome to indigo/glass (drop default orange) |
| B3 | Sweep kanban/calendar/diary CSS: replace `--biz-*` with shim or direct tokens |
| B4 | Kill global `:root { --biz-* }` bleed from `theme.css` when only Planner needs it — scope under `.planner-surface` / `.business-surface` |

**Exit:** Board doesn’t look like a foreign orange admin tool inside indigo chat.

### Phase C — Kanban revival (P1, ~2–3 days) ⭐

| # | Task |
|---|------|
| C1 | Single board toolbar (filters + columns + add); remove duplicate titles |
| C2 | Column layout: min-width, gap, scroll; no squished headers |
| C3 | Card redesign: hierarchy, hover actions, priority chips via tokens |
| C4 | Empty column CTA + drag affordance |
| C5 | Task modal control polish (match Settings inputs) |
| C6 | Column management UI calm pass (not a wall of tiny buttons) |

**Exit:** “Board looks as good or better than old `/business` kanban,” fits Wabi.

### Phase D — Calendar + Journal (P1, ~1–2 days)

| # | Task |
|---|------|
| D1 | Hosted-mode prop `embedded` → compact toolbars |
| D2 | Calendar overflow +N; chevron buttons as icon buttons |
| D3 | Journal: one primary CTA; simplify edit chrome |
| D4 | Shared modal/button classes under `.planner-surface` |

### Phase E — Projects + Tasks (P2)

| # | Task |
|---|------|
| E1 | Projects list/detail density + New path |
| E2 | TaskPanel in-planner split, filters, keyboard-ish clarity |
| E3 | Import/export entry under Planner menu (from BusinessSurface) |

### Phase F — Parity / cleanup (P2)

| # | Task |
|---|------|
| F1 | `/business` → main Planner deep link with view query `?view=board` |
| F2 | Deprecate thin dual headers; delete dead Business-only chrome once unused |
| F3 | Guest/privacy: only if still required for shared hubs |
| F4 | Optional: chat object refs → kanban (existing plan) |

---

## 6. Explicit non-goals (this revival)

- Rewriting business data model / server sync (local-first stays v1).
- Turning Planner into a full Jira.
- Keeping orange nullframe as a permanent second brand inside main app.
- Pixel-perfect clone of old `/business` if it fights main shell — **steal its density and completeness**, not its isolation.

---

## 7. Verification checklist

- [ ] Planner open: store hydrated; stats match real todos/events  
- [ ] New works on every tab  
- [ ] Board: drag task across columns; filters; add/edit/delete  
- [ ] Calendar: add/edit event; month nav; no double page titles  
- [ ] Journal: one clear create path; edit/save/delete  
- [ ] No toolbar button &lt; 36px height; no unlabeled icon without `title`/`aria-label`  
- [ ] No `--biz-*` required outside `.planner-surface`  
- [ ] `bun run check` baseline; visual pass in real browser (not headless)  
- [ ] `/business` lands users somewhere that isn’t a worse shell  

---

## 8. Suggested implementation order (when executing)

1. **A** (honesty) — stops embarrassment  
2. **B** (tokens) — stops “wrong app” feel  
3. **C** (kanban) — highest emotional ROI (“revive what looked good”)  
4. **D** calendar/journal  
5. **E/F** tasks, projects, redirect cleanup  

---

## 9. File map (primary)

| Area | Paths |
|------|--------|
| Host | `frontend/src/lib/components/business/PlannerWorkspace.svelte` + `.css` |
| Full hub (donor) | `BusinessSurface.svelte`, `businessPage.css`, `lib/business/theme.css` |
| Board | `KanbanBoard*.svelte`, `styles/components/kanban-board-*.css` |
| Calendar | `Calendar*.svelte`, `calendar-view-*.css` |
| Journal | `DiaryView.svelte`, `diary-view-*.css` |
| Projects/Tasks | `ProjectsView.svelte`, `TaskPanel.svelte`, `Project*.svelte` |
| Data | `frontend/src/lib/business/*` |
| Entry | `MainLayout.svelte`, `chat/ChatHeader.svelte`, `plannerWorkspace.ts` |
| Prior plans | `docs/plans/2026-07-28-business-into-main.md`, `2026-07-18-chat-object-refs-kanban.md` |

---

## 10. One-line summary

**Don’t polish the stub — promote Planner into the real Business hub host, unify tokens, revive Kanban density, kill dead controls and squished buttons, then bring Calendar/Journal/Projects up to the same control law.**

---

## 11. Implemented (2026-08-07)

Phases A–F landed. See `docs/plans/2026-08-06-planner-ux-implementation-report.md` for the full file-by-file breakdown. Highlights: `PlannerWorkspace` host rewrite (honest stats, working New menu, in-surface Tasks split, `?view=` deep links), `.planner-surface` `--biz-*` → Wabi token shim, Kanban/Calendar/Journal `embedded` hosted modes, kanban card/column/empty-state revival, task modal dialog semantics, `/business` → Planner redirect. `bun run check` clean in all touched files; `STATIC_BUILD=1 bun run build` passes. Remaining: real-browser visual pass and E3 import/export entry.
