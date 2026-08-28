# Right panel rail redesign — interaction spec + file map (2026-08-16)

## Reference: Blender Properties Editor (the mental model Ronin asked me to internalize)

- Vertical icon nav rail on the far right; tabs are *context categories*, not tools.
- Context-sensitivity: the visible tab set changes with what's selected ("shown only when relevant").
- Each tab = scrollable column of settings sections; a Visible-Tabs filter tailors per workflow.
- The same editor type can be a corner pane OR fullscreen — "compact vs full" of one tool.

For Wabi, auto-sensing context is *not* the goal. A multitask station has no single "selection" — a call, a map, and a transfer can all be live at once — so auto-swapping the rail would fight the user. Manual pin is the correct primitive, not a workaround for missing auto-sense.

## Agreed 3-state model

1. **Rail (collapsed, default)** — thin icon column; hover an icon → its label tooltips out to the LEFT (never icon-only, never cryptic).
2. **Peek (transient)** — hover an icon → the panel flies out floating over the center with a full drop shadow ("temporary, above the page"). Mouse-out collapses it back.
3. **Pinned (persistent)** — click an icon → the panel docks beside content taking real width, with a *faint LEFT-only* shadow ("a tool resting beside the document", not a modal).

## Two zones (the "individual stubs" insight)

- TOP half of the right edge = nav icon rail ("which tool do I want to reach for?").
- BOTTOM half (below the halfway point) = **stubs**: the currently-docked panels collapsed to grabbable tabs ("what do I already have open?").
- A stub is ~32px of vertical space instead of a full-height panel, so several panels can be docked-but-collapsed below the midline and the upper half stays free.
- Stub must stay identifiable (icon always) + grabbable (label on hover, adequate hit target) — collapse it too far and it stops being a handle.
- Grab a stub → drag it out → it expands with draggable width; re-stub to dock back down.

## Dismissal model (Ronin's rules)

- Re-click the rail icon → collapse (toggle; the same gesture that opened it).
- Click the pin → explicit un-stick.
- "Open in center stage" → promote-to-full; the side panel collapses to its **stub** (not fully un-docked — you've moved the *focus*, not the intent to keep the tool).
- Click-off closes **transient** surfaces (peek / popover / dropdown) ONLY — never pinned. A pinned panel exists precisely to stay open while the user clicks in the center.

## Design principles (Ronin, durable — reuse for any Wabi UI work)

- A drop shadow signals *elevation*, not *secondary*. To de-emphasize a region, use muted contrast + a quiet boundary line; keep any side-panel shadow genuinely faint and left-only.
- Icon-only rails are power-user affordances; overwhelmed/new users decode icons poorly — keep labels reachable on hover/active.
- Don't over-simplify a rich design to make a concept legible — Ronin notices what's lost. Drag-resize, collapsed stacks, and per-panel stubs all already existed in `RightPanel.svelte`; surface richness at the *panel* level, not the stack level.

## Existing Wabi right-panel architecture (file map)

- `frontend/src/lib/components/RightPanel.svelte` — renders the dock: stacks, tabs, drawer, split/merge/collapse/pin actions, drag-reorder, resize handle, context menu (detach-to-window).
- `frontend/src/lib/components/RightPanel.css` — stack/tab/drawer/resize styling (`--surface-base`, `--accent-rgb`, `--border-subtle`, `--text-secondary`, `--text-heading`).
- `frontend/src/lib/components/WorkspacePanelHost.svelte` — `component` key → actual Svelte component router.
- `frontend/src/lib/workspacePanels.ts` — `BUILTIN_WORKSPACE_PANELS` manifests (People, Messages/DMs, Notes, Whiteboard Layers, Map, Media, Admin, Transfers, Code) + plugin panel registry.
- `frontend/src/lib/layoutStoreRightPanel.ts` — operations: `toggleRightPanel`, `openRightPanel`, `setActiveRightPanel`, `moveRightPanelTab`, `splitRightPanelTab`, `resizeRightPanelStacks`, `toggleRightPanelStackCollapsed`, `toggleRightPanelStackPinned`, `mergeRightPanelStack`, `resetRightPanelDock`.
- `frontend/src/lib/layoutStoreStates.ts` — writable stores: `rightPanelView`, `activeRightTab`, `rightPanelDock`.
- `frontend/src/lib/docking/layoutSchema.ts` — `WorkspacePanelStackV1` (`id, tabs, activePanelId, size, minSize, maxSize, collapsed, pinned`), `WorkspacePanelDockV1` (`orientation, stacks, overflowThreshold`).
- `frontend/src/lib/docking/layoutConstants.ts` — `DEFAULT_WORKSPACE_PANEL_IDS`, `DEFAULT_PANEL_OVERFLOW_THRESHOLD=4`, `AUX_MIN_SIZE=22`.

## Existing primitives vs needed semantics

- `collapsed` (stack) — collapses stack to a header button (icon + label). Close to "stub" but at the STACK level; the redesign needs it at the PANEL level.
- `pinned` (stack) — today means "tabs stay put when adding/removing panels" (tab-arrangement stability), NOT "stay open". The redesign must re-semanticize it or add a panel-level pin.
- `resizeRightPanelStacks` / `.stack-resize-handle` — drag-resize already exists; restore at panel level for the draggable-width requirement.
- `splitRightPanelTab` / `mergeRightPanelStack` — vertical + horizontal split already exist.

## Softlock-prevention anchor — the permanent `+` / `Dock` tab (2026-08-18)

**The problem:** if the user undocks every panel, the tab strip disappears entirely and there's no way to add a new panel back. The user is softlocked with no visible affordance to recover. Even with a small dashed `+` square, it's easy to miss — it looks like a decorative element, not the sole recovery path.

**The rule:** the rail MUST have exactly one **permanent, always-visible, non-undockable anchor tab** — the `+` / `Dock` tab. Even with zero docked panels, this tab is always present and clearly labeled.

### Design lesson: subtle fails for critical affordances (v6→v9, 2026-08-18)

Multiple iterations proved that **subtle design is invisible** for a critical recovery affordance:

- **v6 (dashed square, transparent bg):** "there's still no + sticking out. Nothing is clear." — the `+` was invisible against the dark rail.
- **v7 (floating label, still subtle):** "nope, not seeing a change" — browser caching masked it, but even when visible the floating label was easy to miss.
- **v8 (pill button, low-contrast bg):** "visually there's nothing there. nothing that sticks out. it's like the panel is gone but there's a SLIGHT sliver" — dark purple on dark rail = no contrast.
- **v9 (bright solid gradient button, glowing shadow, visible rail):** finally read clearly.

**The principle:** a critical affordance (the ONLY way to recover from softlock) must be **high-contrast, solid, and obvious** — not subtle. Use bright accent gradients, white text, glowing shadows, and ensure the rail itself has visible contrast against the chat area.

**Implementation pattern (v9 mockup, validated by Ronin):**

1. **Position:** `Dock` tab sits at the **TOP** of the strip, rendered FIRST in `renderTabs()`. First thing the user sees even with zero docked panels.
2. **Bright solid button:** gradient accent background (`var(--accent)` → `var(--accent-2)`), white text, glowing shadow. NOT transparent, NOT dashed, NOT subtle.
3. **Inline label:** `+` icon + "Dock" text inline (not floating), always visible without hover.
4. **Cannot be undocked:** no `✕` close button on the `Dock` tab. It's immutable.
5. **Visible rail:** the right rail must have a distinct background (`#1e1e38` → `#1a1a2e`) with a visible border so tabs have contrast.
6. **Regular tabs visible too:** subtle purple borders + backgrounds so docked panels read as individual squares.
7. **Attention pulse:** on first load, a glow-pulse animation draws the eye to the `Dock` tab.
8. **Hint bar reinforces:** "Dock — always there, adds a panel".

**CSS pattern (from v9 — the version that worked):**
```css
/* Right rail — visible, distinct background */
.right-zone {
  background: linear-gradient(180deg, #1e1e38 0%, #1a1a2e 100%);
  border-left: 2px solid rgba(var(--accent-rgb), .25);
}
.tab-strip { min-width: 54px; padding: 12px 8px; gap: 6px; }

/* Regular tabs — subtle but visible */
.tab {
  border: 1px solid rgba(var(--accent-rgb), .15);
  background: rgba(var(--accent-rgb), .08);
}
.tab:hover { background: rgba(var(--accent-rgb), .18); border-color: rgba(var(--accent-rgb), .3); }

/* Dock tab — BRIGHT solid button, impossible to miss */
.tab.add {
  width: auto; min-width: 44px; height: 42px;
  border-radius: 10px;
  border: 1px solid rgba(var(--accent-rgb), .85);
  background: linear-gradient(135deg, var(--accent) 0%, var(--accent-2) 100%);
  color: #fff;
  display: flex; align-items: center; gap: 8px;
  padding: 0 18px 0 14px;
  font-size: 13px; font-weight: 700;
  box-shadow: 0 0 18px rgba(var(--accent-rgb), .5), 0 4px 12px rgba(0,0,0,.5);
  transition: background .12s ease, border-color .12s ease, box-shadow .12s ease, transform .12s ease;
}
.tab.add:hover {
  background: linear-gradient(135deg, var(--accent-2) 0%, var(--accent) 100%);
  border-color: rgba(var(--accent-rgb), 1);
  box-shadow: 0 0 28px rgba(var(--accent-rgb), .7), 0 4px 16px rgba(0,0,0,.6);
  transform: scale(1.04);
}
.tab.add svg { width: 20px; height: 20px; stroke-width: 2.5; }
.tab.add .dock-label { font-size: 13px; font-weight: 700; color: inherit; }

@keyframes dock-hint {
  0%   { box-shadow: 0 0 0 0 rgba(var(--accent-rgb), .8), 0 0 18px rgba(var(--accent-rgb), .5); }
  70%  { box-shadow: 0 0 0 14px rgba(var(--accent-rgb), 0), 0 0 18px rgba(var(--accent-rgb), .5); }
  100% { box-shadow: 0 0 0 0 rgba(var(--accent-rgb), 0), 0 0 18px rgba(var(--accent-rgb), .5); }
}
.tab.add { animation: dock-hint 2.4s ease-out 1; }
```

**Why this matters for the real implementation:** when `RightPanel.svelte` ships this rail, the `Dock` tab must always be the first child of the strip, always rendered, and never removable. The docked-panels array can be empty; the `Dock` tab is not part of it. Make it bright and obvious — subtle design fails for critical affordances.

## Mockup

- `/home/Ronin/wabi/docs/design/right-panel-rail-mockup.html` — self-contained HTML (no server, no CDN), built in Wabi's Nebula theme, implements all three states + a hint bar + an "open in center stage" toast. Open in Ronin's real browser (headless Chromium cannot render Wabi; use it only for non-rendering checks).

## Nebula dark theme token values (for mockups/prototypes)

- `--bg-sunken #0f0c29`, `--bg-base #1a1a2e`, `--bg-raised #24243e`
- `--text-primary #e0e0ff`, `--text-secondary #b3b3ff`, `--text-muted #9999ff`
- `--accent #a855f7`, `--accent-2 #c084fc`, `--accent-rgb 168,85,247`
- status: online `#22c55e`, away `#f59e0b`, busy `#ef4444`, offline `#708090`
