# Wabi Frontend Cleanup Plan

> Created: 2026-06-08
> Source: Reasoning from `opencode` session + `.hermes/plans/2026-06-07_165842-main-website-mobile-desktop-polish.md`

---

## Table of Contents

1. [Phase 0: CSS Quick Wins](#phase-0-css-quick-wins)
2. [Phase 1: Status System Refinements](#phase-1-status-system-refinements)
3. [Phase 2: Composer Styling Fixes](#phase-2-composer-styling-fixes)
4. [Phase 3: Desktop Header & Toolbar](#phase-3-desktop-header--toolbar)
5. [Phase 4: Mobile Polish](#phase-4-mobile-polish)
6. [Phase 5: Message Layout & Actions](#phase-5-message-layout--actions)
7. [Phase 6: Right Panel & User Panel](#phase-6-right-panel--user-panel)
8. [Phase 7: Validation & QA](#phase-7-validation--qa)
9. [File Reference Index](#file-reference-index)

---

## Phase 0: CSS Quick Wins

### 0.1 Status dot fallback: Make `.status-dot` work with `--status-color`

**File:** `frontend/src/styles/components/status-system.css`

**Problem:** The `.status-dot` base class (line 7) has no `background` property. It relies entirely on state classes (`.online`, `.away`, `.busy`, `.offline`) to set background color. If a component uses `.status-dot` with an inline `--status-color` variable but no state class, the dot renders with no background (transparent/grey fallback only via the `.offline` selector at line 44-49, which requires the element to *not* have `.online`, `.away`, or `.busy`).

**Fix:** Add `background: var(--status-color, transparent)` to the base `.status-dot` declaration so that:
- Components that set `--status-color` directly get the correct color without needing a state class
- Components without `--status-color` or state classes fall through to transparent (which existing state classes then override)

**Change:**

```css
/* Line 7-18, add background to base */
.status-dot,
.presence-dot,
.dm-conv-status-dot,
.status-indicator {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2.5px solid var(--surface-base, #1a1a2e);
    box-sizing: border-box;
    flex-shrink: 0;
    transition: transform 0.15s ease, box-shadow 0.3s ease;
    background: var(--status-color, transparent);  /* ADD THIS */
}
```

Also consider adding `background: var(--status-color, var(--status-offline))` to `.user-avatar-wrap .presence-dot` for cases where presence dots appear without explicit classes.

### 0.2 Chat composer: Base border on input container

**File:** `frontend/src/styles/components/chat-composer.css`

**Problem:** The `.input-container` at line 71 has `border: 1px solid transparent`. On hover/focus, it transitions to colored borders. This creates a jarring shift where the composer appears borderless until interacted with. The composer's visual boundary should be softly visible at rest.

**Fix:**
1. Change base border to a low-contrast token: `border: 1px solid color-mix(in srgb, var(--border-subtle) 42%, transparent)`
2. Keep the hover border slightly stronger: `border-color: color-mix(in srgb, var(--border-subtle) 55%, transparent)`
3. Keep the focus border as-is: `border-color: color-mix(in srgb, var(--accent-primary) 34%, transparent)`

This gives a subtle resting boundary that doesn't pop in unexpectedly on interaction.

**Change:**

```css
/* Line 71 */
border: 1px solid color-mix(in srgb, var(--border-subtle) 42%, transparent);

/* Line 81 */
border-color: color-mix(in srgb, var(--border-subtle) 55%, transparent);

/* Line 88 — keep as-is */
border-color: color-mix(in srgb, var(--accent-primary) 34%, transparent);
```

Also apply the same pattern to the mobile overrides in `chat-mobile.css:148`.

### 0.3 Chat header: Hover effects for workspace view buttons

**File:** `frontend/src/styles/components/chat-header.css`

**Problem:** The desktop hover compaction at lines 91-125 collapses non-active workspace buttons to zero width/opacity until the row is hovered. While functional, the transition lacks a transform animation and the buttons feel more like they're appearing/disappearing rather than compacting smoothly.

**Fix:**
1. Add a `transform` transition to the existing transition list for `.view-open-btn`
2. On hover/active state, add a subtle `scale(1.05)` transform
3. Consider adding a `translateY(-1px)` for a lift effect

**Change:**

```css
/* Add to line 102 transition block or add to .view-open-btn rule */
transition: width 0.22s cubic-bezier(0.34, 1.56, 0.64, 1),
            opacity 0.18s ease,
            transform 0.22s ease,
            border-width 0.18s ease;

/* Add hover transform */
.workspace-view-actions.compactable:hover .view-open-btn:hover {
    transform: scale(1.08);
}
```

---

## Phase 1: Status System Refinements

### 1.1 Verify presence-dot in user rows

**File:** `frontend/src/lib/components/UserListTabImpl.svelte` (line 299, 335) + `UserListTabImpl.css`

**Check:** The `.user-avatar-wrap .presence-dot` at line 299 already uses correct state classes (`active`, `away`, `busy`). The offline variant at line 335 has no class, relying on the fallback `.presence-dot:not(.active):not(.away):not(.busy)` from `status-system.css:46`. Verify this fallback works correctly (it should match `var(--status-offline, #6b7280)`).

### 1.2 Profile hero status animation

**File:** `status-system.css:79-96`

**Check:** The `.profile-hero-status` uses a different pattern from status-dot — it defaults to offline and transitions to online via `:not(.away):not(.busy):not(.offline)`. The online state gets a pulse animation. Verify this works as expected in the settings page hero.

### 1.3 Status badge `::before` pseudo-element

**File:** `status-system.css:108-114`

**Check:** `.status-badge::before` uses `background: var(--status-color, var(--status-offline))`. This is the *only* place in the system that already uses the `--status-color` variable as a fallback pattern. Confirm that components using `.status-badge` do set `--status-color` inline.

---

## Phase 2: Composer Styling Fixes

### 2.1 Textarea border visibility

**File:** `chat-composer.css` + `chat-mobile.css:161-165`

**Check:** The `textarea` inside `.input-container` inherits no direct border styling from chat-composer.css. Mobile overrides at line 161-165 set `font-size`, `padding`, and `min-height` but no border. If the textarea has a native border, it may conflict with the `.input-container` border. Audit whether the textarea needs `border: none; background: transparent;` to avoid double-border.

### 2.2 Composer icon button sizing

**File:** `chat-composer.css:209-224`

**Check:** `.input-icon-button` has `width: 38px; height: 38px;`. On mobile (`chat-mobile.css:167-171`), it's `34px`. Verify touch targets are at least 44x44 on mobile for accessibility (consider using padding to extend hit area without increasing visual size).

### 2.3 Add/send button mobile states

**File:** `chat-composer.css:337-363`

**Check:** The `data-clickable-send` attribute toggles send-button visibility. When `clickable-send` is off (line 361-363), the send button is completely hidden. On mobile, this means a user with keyboard submit enabled has no visible send action. Consider showing a minimal send button on mobile even when `clickable-send` is false.

---

## Phase 3: Desktop Header & Toolbar

### 3.1 Move hover-compaction out of chat-mobile.css

**File:** `chat-mobile.css:8-43`

**Problem:** The hover-compaction rules for desktop `.workspace-view-actions.compactable` (width collapse/expand on hover) are currently in `chat-mobile.css`, which is semantically wrong. They are desktop-only behaviors using `@media (hover: hover)`.

**Fix:** Move lines 91-126 from `chat-header.css` — wait, they're already in `chat-header.css` correctly. But `chat-mobile.css` also has `.workspace-view-actions` rules at lines 56-60 that apply to mobile. The issue is just organizational: the mobile file should not contain desktop-specific logic.

**Action:** Remove the hover-compaction comment from `chat-mobile.css:8-10` ("Other existing styles...") since it's misleading. Verify no rules in `chat-mobile.css` accidentally affect desktop hover-compaction.

### 3.2 Search input animation and theming

**File:** `chat-search.css:41-69`

**Check:** The search input expands with a spring animation (`cubic-bezier(0.34, 1.56, 0.64, 1)`). At rest, it's a 36px circle. The placeholder is transparent until expanded. Verify:
- The spring animation doesn't cause layout overflow on narrow desktop widths
- The placeholder transition is smooth
- The focus border color (`var(--accent-primary)` at line 84) matches the token system

### 3.3 Header action grouping

**File:** `chat-header.css:84-88` + `ChatHeader.svelte`

**Check:** `.header-actions` has `gap: 0.75rem` with `display: flex`. The workspace view buttons (compactable) are mixed with search and other actions. Consider adding visual separators or grouping to distinguish:
- Workspace view buttons
- Search
- Call/video actions (DM only)
- Other header controls

---

## Phase 4: Mobile Polish

### 4.1 Consolidate ml-mobile.css overrides

**File:** `frontend/src/styles/components/ml-mobile.css`

**Problem:** The file has 3 distinct mobile rule blocks:
1. Lines 8-16: `@media (max-width: 640px)` — album message card layout
2. Lines 20-389: `@media (max-width: 768px)` — main mobile styles (messages, avatars, media, reactions, markdown, lightbox, load-more)
3. Lines 393-431: `@media (max-width: 400px)` — extra-small screen overrides (tiny avatars, tighter padding)

These blocks potentially conflict with the density mode overrides in `ml-core.css` (lines 515-668). The density modes use `!important` and apply across all breakpoints.

**Fix approach:**
1. Keep the 3 breakpoints but audit for conflicting properties
2. Between lines 20-389, remove any block that duplicates what `ml-core.css` already handles via density modes
3. Remove `!important` from user-agent styles in the mobile block where possible
4. Consolidate the `.message` base padding declarations (currently at line 21-27 in mobile, and lines 524-530 in cozy mode)

**Specific conflicts found:**
- `.message` base styles: `ml-core.css:524-530` (cozy) vs `ml-mobile.css:21-27` (mobile) — both set padding, gap, border-radius. Mobile uses `padding: 0.2rem 0.78rem`, cozy uses `padding: 0.12rem 0.64rem`. The mobile block should explicitly override cozy for small screens.
- `.message + .message:not(.continuation)` spacing: 0.72rem in mobile vs 0.56rem in cozy. This is intentional (more breathing room on mobile), but verify the selector specificity order.

### 4.2 Mobile composer bottom spacing

**File:** `chat-mobile.css:128-135`

**Check:** The `.input-wrapper` on mobile has `padding-bottom: calc(0.38rem + env(safe-area-inset-bottom))`. Verify this works correctly on:
- iOS Safari (notch + home indicator)
- Android Chrome (navigation bar)
- Desktop with mobile devtools (no safe-area, should use the 0.38rem fallback)

### 4.3 Mobile header layout

**File:** `chat-mobile.css:17-25`

**Check:** The mobile `.chat-header` uses `display: grid; grid-template-columns: minmax(0, 1fr) auto;`. Verify that when search is expanded, the header doesn't break (search should occupy the full row or overlay). The `.search-container` at line 62-69 has `width: 100%` and `flex-direction: row`, which should work within the grid.

### 4.4 Mobile empty channel state

**File:** `ChatMessagesPane.svelte` (search for empty state)

**Check:** On mobile, when a channel has no messages, the empty state should be compact and fit within the viewport without scrolling. Consider adding mobile-specific empty state styles.

---

## Phase 5: Message Layout & Actions

### 5.1 Message action bar positioning

**Files:**
- `frontend/src/styles/components/ml-actions.css` (lines 8-24)
- `frontend/src/styles/components/ml-core.css` (line 242)
- `frontend/src/styles/components/ml-mobile.css` (lines 70-84)

**Problem:** The `.message-actions` bar appears at `top: -10px; right: 0px` relative to `.message-body` (which has `position: relative` at ml-core.css:242). On hover, it fades in with a translateY animation. However:

**Issues to check:**
- Long messages: The action bar may overlap with message content when the message is tall
- Continuation messages: The `top: -10px` positions the bar above the message body, but continuation messages have reduced padding — verify it doesn't overlap with the *previous* message
- Mobile: Actions are hidden by default (ml-mobile.css:70-72) and shown via `.mobile-visible` class. The mobile positioning uses `top: -8px; height: 44px`. Verify this doesn't overflow the message container
- Quick reactions strip: On mobile, `.quick-reactions-strip` is hidden by default and shown only when `.mobile-visible` is applied (ml-mobile.css:90-96). The `max-width: 170px` may clip on very narrow screens (<360px)

### 5.2 Continuation message spacing

**File:** `ml-core.css:61-64, 104-118, 122-133`

**Problem:** The `.message.has-continuation` and `.message.continuation` classes use `!important` at lines 122-133 to force zero margin/padding. This creates tightly stacked chat lines but breaks the `.message:hover` background — the hover background has no vertical space to render between continuation messages.

**Check:**
- `.message:hover` at line 67 has `background: rgba(var(--surface-base-rgb), var(--opacity-medium))` but no `padding` adjustment on hover
- Because continuation messages have `padding-bottom: 0 !important`, the hover background is effectively zero-height between messages
- Consider adding `padding-top: 0.12rem; padding-bottom: 0.12rem;` on hover for continuation messages

### 5.3 Own-messages-right mode

**File:** `ml-core.css:147-164`

**Check:** The `data-own-messages-right="true"` mode flips message direction with `flex-direction: row-reverse`. Verify this doesn't break the message action bar positioning (which uses `right: 0` and would need to become `left: 0` in reverse mode).

### 5.4 Message highlight animation

**File:** `ml-core.css:167-188`

**Check:** The `.message.highlighted` uses negative margins (`margin-right: -9999px`) and oversized padding to create a full-width highlight that extends beyond the message container. This is a hack that can cause horizontal scrollbars. Verify it still works in:
- Desktop with sidebar
- Desktop without sidebar (detached mode?)
- Mobile narrow viewport

### 5.5 Pinned message styles

**File:** `ml-core.css:191-199`

**Check:** `.message.pinned` uses `var(--bg-warning-light)` which is not a token in the current system. Verify this resolves to a valid color, or replace with `color-mix(in srgb, var(--color-warning) 12%, transparent)`. Also verify `.personal-pinned` (line 197) contrast against dark surfaces.

---

## Phase 6: Right Panel & User Panel

### 6.1 User list tab styling

**File:** `frontend/src/lib/components/UserListTabImpl.css` + `UserListTabImpl.svelte`

**Check:**
- `.user-row` at line 86 has hover state at line 105, plus an `.offline` variant at line 110
- The avatar wrap (`.user-avatar-wrap`) at line 291-299 of the svelte file wraps the avatar image + `.presence-dot` with `position: relative`
- Verify the presence dot positioning (`bottom: -2px; right: -2px` from `status-system.css:56-58`) doesn't clip outside the avatar wrap
- The `.user-avatar-placeholder` at line 295 uses `--avatar-color: {user.color}` — verify this CSS variable is consumed correctly

**Context menu:**
- At line 355, a `ContextMenu` component is rendered conditionally
- The context menu at `userListHelpers.ts` should be checked for:
  - Payment options (request-payment, record-cash) — only visible for users with dbUserId
  - Voice/video call — only when socket is available
  - Admin/mod role assignment — only for users with appropriate permissions

### 6.2 RightPanel component stack

**File:** `frontend/src/lib/components/RightPanel.svelte` + `RightPanel.css`

**Check:**
- The panel stack system at lines 56-66 builds `RenderStack[]` from the layout store
- Panel tabs at line 37 show `activePanel.shortLabel || activePanel.label` — verify labels don't overflow at narrow widths
- The stack header buttons (split, collapse, pin) at lines 144-148 use inline SVG icons — verify these meet accessibility requirements (already have `aria-label`)
- The panel drawer at lines 128-141 has a search input that appears when panels exceed 10 — verify this filter works correctly

### 6.3 Quick resources panel

**File:** `RightPanel.svelte:166` — `<QuickResourcesPanel parentHeight={rightPanelHeight} />`

**Check:** The QuickResourcesPanel receives `parentHeight` — verify it doesn't overflow when the right panel has multiple stacks (split mode).

### 6.4 Split mode orientation

**File:** `RightPanel.svelte:38` — `$: splitOrientation = $layoutStore.rightPanelDock.orientation === 'horizontal' ? 'horizontal' : 'vertical';`

**Check:** The split resize handle at lines 139-159 has different styling for horizontal vs vertical orientation. Verify the resize works correctly:
- `cursor: ns-resize` for vertical split (top/bottom)
- `cursor: ew-resize` for horizontal split (left/right)
- The resize calculation at lines 105-112 uses `clientX` for horizontal and `clientY` for vertical

---

## Phase 7: Validation & QA

### 7.1 Static checks

```bash
cd frontend
bun run check
```

Expected: Clean type-check with no new errors. If existing errors exist, document and decide whether to fix.

### 7.2 Runtime screenshots

Required viewports:
- Desktop: 1536x864, 1280x720
- Mobile: 393x873, 360x800

States to capture:
1. Empty channel (no messages)
2. Normal channel with long text messages
3. Channel with image/media message
4. DM header with call/video actions
5. Search expanded with results
6. Search expanded with 0 results
7. Right panel members tab
8. Right panel notes tab empty
9. Mobile channel drawer open
10. Mobile user panel open
11. Composer focused (with keyboard emulation)
12. Debug/dev mode footer visibility

### 7.3 Manual QA checklist

- [ ] No horizontal scrollbars on any viewport
- [ ] Touch targets are at least 44x44 on mobile
- [ ] Focus states visible on keyboard navigation
- [ ] No `!important` added unless absolutely necessary
- [ ] No CSS variable fallthrough errors in console
- [ ] Message hover background visible between continuation messages
- [ ] Status dots render correct colors for all states
- [ ] Composer border doesn't jump on focus
- [ ] Header actions don't overflow on narrow desktop widths
- [ ] Right panel tabs don't overflow at 320px width
- [ ] Mobile composer doesn't overlap with safe-area
- [ ] Search input animation doesn't cause layout shift

---

## File Reference Index

| File | Purpose | Phases |
|------|---------|--------|
| `frontend/src/styles/components/status-system.css` | Status/presence dot styles | 0, 1 |
| `frontend/src/styles/components/chat-composer.css` | Composer textarea, buttons, menus | 0, 2 |
| `frontend/src/styles/components/chat-header.css` | Channel/DM header, workspace view buttons | 0, 3 |
| `frontend/src/styles/components/chat-search.css` | Search input, results toolbar | 3 |
| `frontend/src/styles/components/chat-mobile.css` | Mobile-specific chat overrides | 3, 4 |
| `frontend/src/styles/components/ml-core.css` | Message layout, density modes, highlight | 5 |
| `frontend/src/styles/components/ml-actions.css` | Message hover action bar | 5 |
| `frontend/src/styles/components/ml-mobile.css` | Mobile message overrides | 4, 5 |
| `frontend/src/styles/components/ml-media.css` | Media card styles | 4 |
| `frontend/src/lib/components/RightPanel.svelte` | Right panel tab/dock system | 6 |
| `frontend/src/lib/components/RightPanel.css` | Right panel styles | 6 |
| `frontend/src/lib/components/UserListTabImpl.svelte` | User list with presence dots | 1, 6 |
| `frontend/src/lib/components/UserListTabImpl.css` | User list styles | 6 |
| `frontend/src/lib/components/chat/ChatHeader.svelte` | Header component markup | 3 |
| `frontend/src/lib/components/chat/ChatComposer.svelte` | Composer component logic | 2 |
| `frontend/src/lib/components/chat/ChatMessagesPane.svelte` | Messages container with empty state | 4 |

---

## Suggested Implementation Order

1. **Phase 0** — CSS quick wins (status dot fallback, composer border, header hover effects)
2. **Phase 5** — Message action bar positioning fix (continuation hover)
3. **Phase 3** — Desktop header cleanup (move styles, verify search animation)
4. **Phase 4** — Mobile polish (consolidate ml-mobile.css, verify composer spacing)
5. **Phase 6** — Right panel & user panel review (verify styling, ensure no overflow)
6. **Phase 1** — Status system refinements (verify all presence-dot usage)
7. **Phase 2** — Composer refinements (textarea border, accessibility)
8. **Phase 7** — Validation (static check + runtime screenshots + manual QA)
