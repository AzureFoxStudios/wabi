# Wabi Visual Realignment / Scaling Repair Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task if delegating. This plan is intentionally visual-first: patch small CSS/component regressions, recapture screenshots after each phase, and do not broaden into backend refactors.

**Goal:** Restore the current Wabi desktop UI closer to the earlier Discord-like/reference look while fixing the specific scaling regressions Ronin called out: composer double borders, misaligned header grid, broken voice channel controls, clipped logo, undersized profile controls/status dot, visible dev footer, and missing dev profile-pic test path.

**Architecture:** Prefer targeted CSS/component repairs over broad redesign. Keep the existing dark theme and current panel layout, but re-establish stable sizing tokens and row grids so controls cannot stretch, collapse, or overlap as widths change. Treat visual screenshot inspection as required validation, not optional.

**Tech Stack:** Svelte/SvelteKit, Bun, Vite dev server, CSS component files under `frontend/src/styles/components`, local mock mode via `VITE_WABI_LOCAL_MOCK=1`.

---

## Current Visual Findings From Live Screenshot

Current inspected screenshot: `/tmp/wabi-ui-smoke/verify-desktop.png`
Reference screenshots inspected:
- `/home/Ronin/Desktop/Screenshot_20260502-131716.png`
- `/home/Ronin/Desktop/Screenshot_20260502-113209.png`
- `/home/Ronin/Desktop/image (2).png`

Observed current regressions:

1. **Composer double-border / focus glow drift**
   - Center composer shows an outer rounded field border plus an inner focused textarea/container border.
   - Reference direction is closer to one clean Discord-like field: either one soft container shape or focus-only outline, not nested borders.
   - Current `chat-composer.css` and `chat-mobile.css` both contribute input-container border/focus rules.

2. **Header grid is visually misaligned**
   - Center chat header sits on a different vertical/spacing rhythm than the left server top block and right panel mode button.
   - Left top server info area, center header, and right panel header should read as one app chrome row.
   - Right panel top People button is visually heavier/taller than the center header pills.

3. **Right panel Notes/DM behavior fixed mechanically, but visual semantics need review**
   - Current Notes/DM pill now toggles when clicking active tab, but that also removed the obvious idea of a drawer from the user’s perspective.
   - Need preserve one-click toggle while ensuring any drawer affordance belongs only to stack tabs, not the QuickResources Notes/DM pill.

4. **Voice channel row is broken by scaling/collapse**
   - Voice channel name is omitted/collapsed in current sidebar screenshot.
   - A participant/timer row shows `Mira 0:00`, and above it a no-name/self entry appears as only `M`; need determine if this is self voice row or malformed member data.
   - `Follow voice channel` star differs from text channel star style and should be identical: transparent, no pill/circle background.
   - `Open voice whiteboard` control looks stretched/collapsed from original circle intent.
   - `voice-channel-actions`, `.voice-follow-btn`, `.voice-whiteboard-btn`, and `.voice-action-count` are the likely source.

5. **Server logo / top-left is clipped upward**
   - Current top-left wabi-logo/server identity is too high and cut by the top edge.
   - Reference desktop screenshot shows Wabi/server identity comfortably centered in the header strip with padding, not clipped.
   - Likely files: `sidebar-core-part1.css` top-section/server identity rules and possibly `server-rail.css` for alternate rail mode.

6. **Bottom-left profile controls are too tiny / cramped**
   - Current status dot is a speck next to profile avatar instead of a readable online presence dot.
   - Mute, deafen, settings controls are oversized circles in one screenshot but can still feel mis-scaled relative to the profile block. Need restore comfortable Discord-ish 32px controls with 18-20px icons, stable spacing, and a 10-12px status dot.
   - Likely files: `sidebar/ProfileCard.svelte`, `sidebar-profile.css`, `status-system.css`, `userPanel.css`.

7. **Dev footer is visible and should be removed**
   - Current screenshot shows `Version dev - for debugging reasons only` at bottom center.
   - User explicitly requested removal.
   - Likely change: remove or hide block in `Chat.svelte` lines 517-521 and optionally delete `.debug-version-footer` CSS from `chat-core.css`.

8. **Profile picture upload cannot be tested in dev mock**
   - Local mock currently has guest users, but not a clear seeded test account/profile upload flow.
   - This is not part of the immediate visual fix, but should be added as a follow-up dev harness task.

---

## Implementation Plan

### Phase 0: Preserve and baseline

**Objective:** Make the visual pass safe and comparable.

**Files:**
- No edits yet.

**Steps:**
1. Save a pre-pass patch/status backup under `/home/Ronin/wabi-backups/`.
2. Verify dev server is serving `/home/Ronin/wabi/frontend` and HTTP 200.
3. Capture baseline desktop screenshot at 1440x1000.
4. Capture baseline mobile screenshot at 390x1200.
5. Keep screenshots named with `before-visual-realign` so final comparison is clear.

**Commands:**
```bash
cd /home/Ronin/wabi
git diff > /home/Ronin/wabi-backups/pre-visual-realign-$(date +%Y%m%d-%H%M%S).patch
git status --short > /home/Ronin/wabi-backups/pre-visual-realign-status-$(date +%Y%m%d-%H%M%S).txt
cd frontend
curl -sS -o /tmp/wabi-health.html -w 'http_code=%{http_code} size=%{size_download} time=%{time_total}\n' --max-time 5 http://127.0.0.1:5173/
```

**Validation:**
- HTTP 200.
- Baseline screenshots visually inspected before patching.

---

### Phase 1: Kill composer double borders and restore one-field feel

**Objective:** Remove nested border/focus treatment so the center composer has one clean field, with no second visible border on click.

**Files:**
- Modify: `frontend/src/styles/components/chat-composer.css`
- Modify: `frontend/src/styles/components/chat-mobile.css`

**Specific changes:**
1. In `chat-composer.css`, choose exactly one field boundary:
   - Preferred: no outer `.input-wrapper` visual border except top separator if needed.
   - `.input-container` default should be `border: 1px solid transparent` or very low opacity only if it does not read as a second border.
   - `.input-container:focus-within` should not add a new thick border. If any focus styling remains, use subtle background or `box-shadow: none`.
2. In `chat-mobile.css`, remove duplicate `.input-container` border/focus overrides that reintroduce the second border on mobile.
3. Ensure `textarea` remains borderless and transparent.

**Target CSS shape:**
```css
.input-wrapper {
  border-top: 1px solid color-mix(in srgb, var(--border-subtle) 55%, transparent);
}

.input-container {
  border: 1px solid transparent;
  background: color-mix(in srgb, var(--surface-raised) 18%, transparent);
  box-shadow: none;
}

.input-container:hover,
.input-container:focus-within {
  border-color: transparent;
  background: color-mix(in srgb, var(--surface-raised) 30%, transparent);
  box-shadow: none;
}

.input-container textarea {
  border: none;
  outline: none;
  background: transparent;
}
```

**Verification:**
- Focus composer in Chromium/CDP.
- Compare computed rect before/after focus: width/height must not change.
- Screenshot must show no nested cyan/double outline.

---

### Phase 2: Re-align app chrome/header grid

**Objective:** Make left server header, center chat header, and right panel header visually sit on one horizontal rhythm.

**Files:**
- Modify: `frontend/src/styles/components/chat-header.css`
- Modify: `frontend/src/styles/components/sidebar-core-part1.css`
- Modify: `frontend/src/lib/components/RightPanel.css`
- Possibly modify: `frontend/src/styles/components/chat-search.css`

**Specific changes:**
1. Establish a consistent header height target, likely 54px or current `--app-header-height` if available.
2. Set `.top-section`, `.chat-header`, and `.panel-stack .stack-header` / right panel header to the same min-height and align-items center.
3. Reduce right panel People/mode button height if it visually dominates center header; keep touch targets only in mobile.
4. Keep search from overflowing by retaining existing max-width/narrow safeguards.

**Verification:**
- Desktop screenshot: top left server name, center channel title/actions, and right People button align by eye.
- DOM check: no horizontal scrollbar on 1440 desktop and narrow desktop width.

---

### Phase 3: Fix top-left server logo clipping

**Objective:** Restore comfortable vertical padding around the Wabi/server logo and prevent top-edge clipping.

**Files:**
- Modify: `frontend/src/styles/components/sidebar-core-part1.css`
- Possibly modify: `frontend/src/styles/components/server-rail.css`

**Specific changes:**
1. Inspect `.top-section`, `.server-identity`, `.logo`, `.logo-img`, `.brand-logo-img`, `.server-logo-img`.
2. Ensure `.top-section` has enough top padding and no negative/overflow clipping.
3. Set `.logo` and `.logo-img` to fixed, centered dimensions and `overflow: visible` unless avatar image requires clipping.
4. Avoid solving by shrinking the logo too much; the issue is vertical positioning/clipping, not logo identity.

**Verification:**
- Desktop screenshot: Wabi logo/server identity is fully visible, centered vertically, not touching top screen edge.

---

### Phase 4: Repair voice channel row grid and controls

**Objective:** Restore voice channel row to a stable text-channel-like layout: icon + visible channel name + right-side transparent actions.

**Files:**
- Modify: `frontend/src/lib/components/sidebar/VoiceChannelList.svelte`
- Modify: `frontend/src/styles/components/sidebar-core-part2.css`
- Possibly modify: `frontend/src/styles/components/sidebar-channels.css`

**Specific changes:**
1. Make `.voice-channel-main` a grid:
   - column 1: channel button `minmax(0, 1fr)`
   - column 2: action cluster `auto`
2. Ensure `.channel-btn` has `min-width: 0`, and `.voice-channel-name` has ellipsis only after it has real space.
3. Make `.voice-follow-btn` inherit text follow style:
   - no background
   - no border
   - no circle/pill
   - same star size/color/hover as text `.follow-btn`
4. Make `.voice-whiteboard-btn` a fixed square/circle, not flex-stretched:
   - `width: 24px; height: 24px; flex: 0 0 24px; border-radius: 999px or 6px`
   - no `flex: 1`
   - no full-width pill
5. Keep occupancy/count hidden or compact, but never before channel name.
6. Re-check whether `voice-action-count` should show on hover only or stay hidden in current compact width.

**Verification:**
- Desktop screenshot: voice row displays `voice` or channel name visibly.
- Follow star matches text channel star style.
- Whiteboard icon is compact fixed-size, not stretched.
- No action overlays channel name.

---

### Phase 5: Audit voice member/timer data rendering

**Objective:** Determine whether the no-name user and timer next to Mira are UI rendering bugs or mock/DB state artifacts.

**Files:**
- Inspect/possibly modify: `frontend/src/lib/components/sidebar/VoiceChannelList.svelte`
- Inspect: `frontend/src/lib/socket.ts` and local mock voice member seed code if needed.
- Inspect: `frontend/src/lib/components/sidebar/channelSidebarHelpers.ts` for `formatVoiceDuration`.

**Specific checks:**
1. Log/inspect `$voiceChannelMembers` in local mock.
2. Verify `visibleVoiceMembers(channel.id)` filters current user correctly for both `$currentUser.id` and `user-${dbUserId}`.
3. Verify the self voice row is only rendered when `channelIsConnected && $currentUser`.
4. Ensure no blank username is rendered:
   - if no username, display stable fallback like `Unknown` only in debugging, or filter invalid member records.
5. Decide duration display default:
   - If `voiceDurationMode` is `others`, Mira gets timer and self does not. That may be expected.
   - If the timer is unwanted visually, set local default to `off` or hide duration unless explicitly enabled.

**Verification:**
- Capture sidebar with voice section open.
- No blank/no-name row.
- If timer remains, it is intentional and controlled by `voiceDurationMode`.

---

### Phase 6: Restore bottom-left profile/status/control sizing

**Objective:** Make profile card feel like the reference: readable avatar/status dot, compact username role, comfortable mute/deafen/settings icons.

**Files:**
- Modify: `frontend/src/lib/components/sidebar/ProfileCard.svelte` only if structure is needed.
- Modify: `frontend/src/styles/components/sidebar-profile.css`
- Modify: `frontend/src/styles/components/status-system.css` if global dot cascade fights local styles.

**Specific changes:**
1. Set avatar button/container to stable 32-36px.
2. Set profile status dot to 10-12px with 2px dark ring, not a tiny speck.
3. Set `.profile-controls .control-btn` to 32px or 34px square, not huge 44px circles on desktop.
4. Set control SVG to 18px or 19px.
5. Use media query for mobile if touch target needs 44px there; do not let mobile sizes leak into desktop.

**Verification:**
- Desktop screenshot: status dot readable on avatar; mute/deafen/settings same visual weight as reference and not cramped.
- Mobile screenshot: no touch target regression.

---

### Phase 7: Remove dev version footer

**Objective:** Remove `Version dev - for debugging reasons only` from the visible chat UI.

**Files:**
- Modify: `frontend/src/lib/components/Chat.svelte`
- Optionally modify: `frontend/src/styles/components/chat-core.css`

**Specific changes:**
1. Remove or hard-disable the block:
```svelte
{#if import.meta.env.DEV}
  <div class="debug-version-footer" aria-hidden="true">
    Version {runtimeVersionLabel} - for debugging reasons only
  </div>
{/if}
```
2. Optionally delete `.debug-version-footer` CSS if no longer used.

**Verification:**
- Screenshot bottom center has no dev footer text.

---

### Phase 8: Restore center message look only after chrome/sidebar are stable

**Objective:** Stop UI drift from original Discord-ish look: avatar/name/timestamp alignment, comfortable mode spacing, hover bar/hover background.

**Files:**
- Modify: `frontend/src/styles/components/ml-core.css`
- Modify: `frontend/src/styles/components/ml-mobile.css`
- Inspect: `frontend/src/lib/components/MessageList.svelte` / `MessageItem` files if structure changed.

**Specific changes:**
1. Use reference mobile screenshots for target message rhythm:
   - avatar left column stable
   - username and timestamp on same baseline
   - timestamp smaller/lower contrast than current oversized past state
   - message groups should not have huge vertical gaps
2. Restore hover affordance on desktop:
   - message hover background or action bar should be visibly present when hovering.
3. Keep mobile density overrides isolated to mobile media queries.

**Verification:**
- Add CDP hover test for a message row and screenshot it.
- Confirm hover background/action bar appears.
- Confirm no mobile density regression.

---

### Phase 9: Add local dev profile-picture test path (follow-up, after visual pass)

**Objective:** Make profile picture upload/import testable in local mock/dev without needing real accounts.

**Files to inspect/change:**
- `frontend/src/routes/+page.svelte`
- `frontend/src/lib/socket.ts`
- `frontend/src/lib/mock*` files if present
- `frontend/src/lib/components/Login.svelte`
- profile/settings components that own upload UI

**Possible approach:**
1. Seed local mock with two named users that include profile pictures and statuses.
2. Add a dev-only fixture image URL or generated data URL.
3. Add a dev-only profile upload/import test path if backend upload is absent.
4. Keep this behind `VITE_WABI_LOCAL_MOCK=1` or `import.meta.env.DEV` so production behavior is untouched.

**Verification:**
- Guest/dev account can show avatar.
- Profile picture can be changed or imported in local mock and persists in localStorage for the session.

---

## Validation Checklist

Run after each implementation phase, not just at the end:

```bash
cd /home/Ronin/wabi/frontend
bun run check
bun run build:only
curl -sS -o /tmp/wabi-health.html -w 'http_code=%{http_code} size=%{size_download} time=%{time_total}\n' --max-time 5 http://127.0.0.1:5173/
```

Visual verification:
- Desktop: 1440x1000 screenshot.
- Mobile: 390x1200 screenshot.
- A focused-composer screenshot.
- A hovered-message screenshot.
- A sidebar voice-row screenshot with the voice channel visible.

Acceptance criteria:
- No double composer border/focus outline.
- Top chrome visually aligned left/center/right.
- Wabi/server logo not clipped.
- Voice channel name visible.
- Voice follow star matches text follow star style.
- Whiteboard/open voice control fixed-size, not stretched.
- No blank/no-name voice member row.
- Bottom-left profile status dot readable.
- Mute/deafen/settings comfortable desktop size.
- Dev footer removed.
- No horizontal scrollbars desktop or mobile.
- `bun run check` returns 0 errors.
- `bun run build:only` succeeds.

---

## Risks / Notes

- Some current dirty files are unrelated Login/backend/config work. Do not touch them during this visual pass unless explicitly requested.
- The current mock voice state may contain seeded users that make voice member rows look odd; verify data before assuming CSS.
- Avoid fixing desktop by applying global 44px touch-target styles. Desktop and mobile need separate sizing.
- Avoid letting OpenCode broad-edit the whole frontend here. If using a coding agent, give it one phase at a time and verify screenshots after each phase.
