# Nullframe-Inspired Business/Admin Dashboard Implementation Plan

> **For Hermes/OpenCode:** Implement this plan task-by-task. The first OpenCode attack should only execute Phase 1: the `/business` visual shell and Business Hub dashboard language. Do not re-skin all admin/settings panels in the first pass.

**Goal:** Adapt the visual language of `https://project-nullframe.vercel.app/` into Wabi’s Business Hub and future admin/owner console without copying the site or making normal chat look like a terminal.

**Architecture:** Treat the Nullframe aesthetic as a special “control room” layer for owner/business/ops surfaces. Keep Wabi chat/social/media surfaces warm and readable. Use existing Business Hub route-level CSS (`frontend/src/routes/business/businessPage.css`) and business theme tokens (`frontend/src/lib/business/theme.css`) for the first pass so the change is contained.

**Tech Stack:** Svelte, SvelteKit, Bun, existing Wabi CSS variables, existing business route components. No new JS dependencies. No new browser libraries. No backend/STDB changes in this pass.

---

## Design Reference Summary

The reference page’s usable qualities:

- Near-black canvas, not blue-grey SaaS chrome.
- Sparse charcoal cards with thin borders.
- Small uppercase monospace labels.
- Wide empty space and calm information density.
- Subtle dotted grid texture inside cards.
- Orange accent used as signal, not decoration spam.
- Telemetry-like cards: live status, memory, render/FPS, CI, uptime.
- Feels like a private machine/control-room dashboard.

What Wabi should adapt:

- “Server owner control room” mood.
- Big metric cards and small mono metadata.
- Calm status widgets for business/admin facts.
- Matte black/charcoal panel language.
- Dot-grid or micro-grid texture on important cards.
- Clear status accents: orange for attention, green for healthy, red for danger.

What Wabi should not copy:

- Do not make all of Wabi monochrome terminal UI.
- Do not reduce real admin labels to unreadable tiny text.
- Do not use this style for normal chat message flow.
- Do not hide destructive/admin actions behind aesthetic ambiguity.
- Do not pull FFXIV/gameScreenshotPipe into core Business Hub or core media UI.

---

## Current Codebase Targets

Primary first-pass files:

- `frontend/src/routes/business/+page.svelte`
- `frontend/src/routes/business/businessPage.css`
- `frontend/src/lib/business/theme.css`

Likely secondary files for polish if time remains in Phase 1:

- `frontend/src/lib/components/business/TaskPanel.svelte`
- `frontend/src/lib/components/business/Calendar.svelte`
- `frontend/src/lib/components/business/CalendarImpl.svelte`
- `frontend/src/lib/components/business/ProjectsView.svelte`
- `frontend/src/lib/components/business/KanbanBoard.svelte`
- `frontend/src/lib/components/business/KanbanBoardImpl.svelte`

Do not touch in Phase 1 unless a compile error requires it:

- `frontend/src/lib/components/AdminTab.svelte`
- `frontend/src/lib/components/settings/AdminSettingsTab.svelte`
- `frontend/src/lib/components/settings/admin/**`
- backend files
- SpacetimeDB reducers/schema
- media albums / game screenshot pipe / FFXIV addon surfaces
- transfer/P2P files from the previous batch

Protected boundaries:

- `gameScreenshotPipe` must remain out of core Wabi and out of this Business Hub pass.
- Shared/server truth remains STDB; this design pass must not invent local-only admin state as authoritative data.
- Business Hub can remain local/mock/personal-productivity oriented; do not pretend business metrics are persisted server truth unless existing code already does that.

---

## Phase 0: Baseline and Safety

### Task 0.1: Confirm dirty state and backup

**Objective:** Preserve existing uncommitted work before OpenCode edits.

**Files:** none.

**Commands:**

```bash
git status --short
mkdir -p /home/Ronin/wabi-backups
STAMP=$(date +%Y%m%d-%H%M%S)
git status --short > /home/Ronin/wabi-backups/pre-opencode-nullframe-business-${STAMP}.status.txt
git diff > /home/Ronin/wabi-backups/pre-opencode-nullframe-business-${STAMP}.patch
```

**Expected:** Backup files exist outside the repo.

**Current backup already made:**

- `/home/Ronin/wabi-backups/pre-opencode-nullframe-business-20260613-224754.status.txt`
- `/home/Ronin/wabi-backups/pre-opencode-nullframe-business-20260613-224754.patch`

### Task 0.2: Baseline checks

**Objective:** Know whether new work introduces errors.

**Commands:**

```bash
cd /var/home/Ronin/wabi/frontend
bun run check
STATIC_BUILD=1 bun run build
```

**Expected:** Existing warnings may remain. New errors are not acceptable.

---

## Phase 1: Business Hub Control-Room First Pass

This is the first OpenCode implementation target.

### Task 1.1: Retokenize Business Hub theme toward Nullframe/Wabi control-room

**Objective:** Change the Business Hub token palette from navy SaaS dashboard to matte black/charcoal control-room while preserving readability.

**Files:**

- Modify: `frontend/src/lib/business/theme.css`

**Implementation details:**

Add/adjust CSS variables, keeping existing variable names so existing components continue working:

```css
:root {
  --biz-bg-primary: #030405;
  --biz-bg-secondary: #090a0c;
  --biz-bg-tertiary: #111316;
  --biz-bg-card: #0d0f12;
  --biz-bg-hover: #171a1f;

  --biz-accent: #f36b21;
  --biz-accent-hover: #ff7a2f;
  --biz-accent-soft: rgba(243, 107, 33, 0.16);

  --biz-info: #7dd3fc;
  --biz-info-soft: rgba(125, 211, 252, 0.12);

  --biz-success: #35d07f;
  --biz-success-soft: rgba(53, 208, 127, 0.12);
  --biz-warning: #f59e0b;
  --biz-warning-soft: rgba(245, 158, 11, 0.14);
  --biz-danger: #ff4d4d;
  --biz-danger-soft: rgba(255, 77, 77, 0.13);

  --biz-text-primary: #f4f4f5;
  --biz-text-secondary: #a1a1aa;
  --biz-text-tertiary: #71717a;
  --biz-text-muted: #52525b;

  --biz-border: rgba(255, 255, 255, 0.085);
  --biz-border-light: rgba(255, 255, 255, 0.14);

  --biz-shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.45);
  --biz-shadow-md: 0 10px 30px rgba(0, 0, 0, 0.34);
  --biz-shadow-lg: 0 24px 80px rgba(0, 0, 0, 0.46);

  --biz-font-mono: 'Geist Mono', 'SFMono-Regular', 'Cascadia Code', 'Roboto Mono', monospace;
  --biz-dot-grid: radial-gradient(circle at 1px 1px, rgba(255, 255, 255, 0.075) 1px, transparent 0);
}
```

Also add reusable utility component classes in this file or route CSS:

- `.biz-card-control`
- `.biz-card-grid`
- `.biz-kicker`
- `.biz-metric-value`
- `.biz-metric-unit`
- `.biz-status-dot`
- `.biz-status-dot.live|warn|danger|idle`

**Acceptance criteria:**

- Existing Business Hub components still resolve old `--biz-*` variable names.
- No unreadable low-contrast main body text.
- Orange accent is restrained, not sprayed everywhere.

### Task 1.2: Add a top “control strip” to Business Hub

**Objective:** Make `/business` immediately feel like a Wabi business/control dashboard instead of a generic app header.

**Files:**

- Modify: `frontend/src/routes/business/+page.svelte`
- Modify: `frontend/src/routes/business/businessPage.css`

**Implementation details:**

Below the header, add a compact dashboard overview section before `.dashboard-body`:

```svelte
<section class="business-control-strip" aria-label="Business status overview">
  <article class="biz-control-card biz-control-card--hero">
    <div class="biz-card-topline">
      <span>LOCAL · BUSINESS HUB</span>
      <span>WABI · OWNER SPACE</span>
    </div>
    <div class="biz-hero-metric">
      <span class="biz-hero-number">{quickStats.todayCount}</span>
      <span class="biz-hero-unit">due today</span>
    </div>
    <div class="biz-card-footerline">
      <span>{quickStats.completedTasks}/{quickStats.totalTasks} tasks complete</span>
      <span class="biz-status"><i class="biz-status-dot live"></i> local data</span>
    </div>
  </article>

  <article class="biz-control-card">
    <div class="biz-card-label">FOCUS</div>
    <div class="biz-card-value">{activeView}</div>
    <div class="biz-card-subtle">Current workspace mode</div>
  </article>

  <article class="biz-control-card">
    <div class="biz-card-label">OVERDUE</div>
    <div class:warn={quickStats.overdueCount > 0} class="biz-card-value">{quickStats.overdueCount}</div>
    <div class="biz-card-subtle">Items needing attention</div>
  </article>

  <article class="biz-control-card">
    <div class="biz-card-label">PRIVACY</div>
    <div class="biz-card-value">LOCAL</div>
    <div class="biz-card-subtle">Private-by-default workspace</div>
  </article>
</section>
```

Adjust exact copy/classes as needed. Do not add fake revenue/user metrics unless existing data exists.

**Acceptance criteria:**

- The strip uses real existing `quickStats` and `activeView` values.
- Copy is honest: “local data,” “private-by-default,” “workspace mode,” not fake server stats.
- At 1440px width, the hero card dominates and the smaller metric cards sit to the right/next to it.
- At mobile widths, the strip becomes a vertical stack and does not push core controls offscreen.

### Task 1.3: Restyle existing Business Hub header/nav/actions

**Objective:** Make the header match the control-room language without breaking navigation.

**Files:**

- Modify: `frontend/src/routes/business/businessPage.css`

**Implementation details:**

- Keep the current DOM and click handlers.
- Convert header to low-profile black glass/charcoal bar.
- Style nav tabs like small instrument switches:
  - uppercase optional small labels allowed, but preserve readable text.
  - active tab = orange left/top border or soft orange capsule.
  - hover/focus states visible.
- Panel action buttons should become square/compact instrument buttons with visible focus rings.
- Quick stats should become micro telemetry pills.

**Acceptance criteria:**

- Keyboard focus remains visible.
- Import/export/task buttons are still discoverable via titles and icons/text.
- Header remains usable at <= 1024px.

### Task 1.4: Restyle dashboard body panels and right task/chat surfaces

**Objective:** Make existing main content, task panel, and chat panel feel like cards inside the same system.

**Files:**

- Modify: `frontend/src/routes/business/businessPage.css`
- Potentially modify scoped styles in:
  - `frontend/src/lib/components/business/TaskPanel.svelte`
  - `frontend/src/lib/components/business/KanbanBoard*.svelte`
  - `frontend/src/lib/components/business/Calendar*.svelte`

**Implementation details:**

- Apply card surface treatment to `.main-content`, `.task-panel`, `.chat-panel-business` as appropriate.
- Avoid breaking internal component layouts.
- If child components have scoped bright/navy styles that clash badly, add minimal overrides from the route stylesheet using existing classes; do not rewrite every child component.
- Add micro-grid/dotted texture only to broad cards/empty states, not every input.
- Keep task/kanban cards readable and distinct.

**Acceptance criteria:**

- Calendar, Journal, Projects, Kanban views remain reachable.
- Task panel still opens/closes.
- Chat panel still opens/closes/expands.
- Text remains readable against the darker background.

### Task 1.5: Business Hub empty/loading/read-only states

**Objective:** Make non-happy states feel intentionally designed.

**Files:**

- Modify: `frontend/src/routes/business/businessPage.css`
- Potentially modify: `frontend/src/routes/business/+page.svelte`

**Implementation details:**

- `loading-screen`: use subtle black/orange radial or grid, not bright generic gradient.
- `read-only-banner`: make it a warning telemetry strip, not a plain banner.
- Empty states inside task/kanban/project areas should inherit the control-room surface if they currently look generic.

**Acceptance criteria:**

- Guest read-only banner is legible.
- Loading does not flash an unrelated color palette.
- Empty states do not look like raw default browser panels.

### Task 1.6: Runtime smoke and visual evidence

**Objective:** Prove the route builds and renders.

**Commands:**

```bash
cd /var/home/Ronin/wabi/frontend
bun run check
STATIC_BUILD=1 bun run build
VITE_WABI_LOCAL_MOCK=1 bun run dev -- --host 127.0.0.1 --port 5173
```

Then open:

- `http://127.0.0.1:5173/business`

Capture screenshots:

- `/tmp/wabi-nullframe-business-desktop.png` at 1440x1000
- `/tmp/wabi-nullframe-business-mobile.png` around 390x844

**Acceptance criteria:**

- `/business` renders without runtime error overlay.
- Header, control strip, main content, task panel, and chat panel visible on desktop.
- Mobile does not clip primary nav/actions unusably.
- Report any limitations honestly, especially if mock/business route lacks data.

---

## Phase 2: Admin/Owner Console Direction, Not First Attack

Do not implement this in the first OpenCode run unless explicitly asked after Phase 1 review.

### Task 2.1: Extract a reusable admin/business dashboard card language

**Objective:** Reuse the style without duplicating one-off CSS forever.

**Possible files:**

- Create: `frontend/src/lib/components/admin/OpsMetricCard.svelte`
- Create: `frontend/src/lib/components/admin/OpsStatusGrid.svelte`
- Modify: `frontend/src/lib/components/AdminTab.svelte`

**Notes:**

Use the same language for:

- owner/admin/mod/guest counts
- compression panel health
- runtime guardrails
- frontend metadata status
- payment access policy

### Task 2.2: Admin overview/control-room panel

**Objective:** Add an overview at the top of Admin tab before the dense settings panels.

**Potential honest metrics from existing data:**

- owner count
- admin count
- mod count
- guest count
- channel count
- visible users count
- payment policy enabled/disabled
- compression panel loaded/error
- runtime panel loaded/error

**Do not invent:**

- revenue
- disk usage
- STDB health
- helper-node health
- backup age

unless those values already exist in current frontend/API data.

### Task 2.3: Admin settings panels progressive polish

**Objective:** Apply the visual language to dense admin panels without hurting form clarity.

**Files likely involved:**

- `frontend/src/lib/components/admin/*.svelte`
- `frontend/src/lib/components/settings/admin/*.svelte`

**Rules:**

- Keep labels readable.
- Destructive actions must remain obvious.
- Inputs/selects/buttons need full theme states.
- Do not let tiny mono labels replace normal form labels.

---

## OpenCode First-Run Prompt Scope

The first OpenCode run should be told:

- Implement Phase 1 only.
- Use the reference page as inspiration, not a clone.
- Do not touch backend/STDB/admin/settings/media/transfer/gameScreenshotPipe files.
- No commits.
- Run `bun run check` if possible.
- If build/runtime checks are too slow, report exactly what ran and what remains.

---

## Manual Review Checklist After OpenCode

Hermes must independently verify before reporting success:

1. `git status --short`
2. Inspect diffs for allowed files only.
3. Confirm forbidden paths were not changed:
   - backend
   - `frontend/src/lib/gameScreenshotPipe*`
   - media albums core UI
   - transfer/P2P files
   - admin/settings unless explicitly Phase 2
4. Run:
   - `cd frontend && bun run check`
   - `cd frontend && STATIC_BUILD=1 bun run build`
5. Runtime smoke `/business` in mock mode.
6. Screenshot review desktop/mobile.
7. Patch obvious overreach or broken contrast before final report.

---

## Definition of Done for Phase 1

Phase 1 is done when:

- `/business` has a visibly Nullframe-inspired Wabi control-room style.
- Design uses real existing data only.
- Main route remains functional.
- Static checks pass with no new errors.
- Runtime smoke reaches `/business` without visible error overlay.
- Desktop screenshot looks intentionally designed, not just recolored.
- Mobile remains usable enough for review.
- Remaining caveats are documented honestly.
