# Wabi Main Website Mobile/Desktop Polish Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task if we decide to execute it. For now this is planning only.

**Goal:** Fix the main Wabi chat website so the mobile view feels like a first-class chat app and the desktop/web view feels intentional instead of debug/TUI/empty-shell.

**Architecture:** Keep the existing Svelte component structure and CSS token system. Do not rewrite the app shell. Make targeted changes to chat shell composition, mobile header/composer/message rhythm, desktop empty state, right panel hierarchy, and debug/TUI mode separation. Preserve Wabi's self-hosted/debuggable nature, but stop letting debug affordances dominate normal users.

**Tech Stack:** SvelteKit, TypeScript, Bun, existing Wabi CSS token system under `frontend/src/styles/`, responsive CSS, browser runtime visual verification.

---

## Current context from screenshots

Screenshots inspected:

- `/home/Ronin/Desktop/Screenshot_20260502-131716.png`
- `/home/Ronin/Desktop/Screenshot_20260502-113209.png`
- `/home/Ronin/Desktop/image (1).png`
- `/home/Ronin/Desktop/image (2).png`

Relevant source inspected:

- `frontend/src/lib/components/MainLayout.svelte`
- `frontend/src/lib/components/Chat.svelte`
- `frontend/src/lib/components/chat/ChatHeader.svelte`
- `frontend/src/styles/components/main-layout-part1.css`
- `frontend/src/styles/components/main-layout-part2.css`
- `frontend/src/styles/components/chat-header.css`
- `frontend/src/styles/components/chat-mobile.css`
- `frontend/src/styles/components/ml-mobile.css`

Observed problems:

1. Mobile screenshots currently look closer to Discord than Wabi. That is not automatically bad, but Wabi's identity is not visible beyond colors/avatars.
2. Mobile top header is too heavy and system-app-like: giant back arrow, large icon buttons, lots of chrome before content.
3. Mobile message rhythm is inconsistent: screenshots show very large text/spacing in places, while CSS has multiple competing mobile overrides in `ml-mobile.css`.
4. Mobile composer takes a lot of bottom space and has too many equally weighted circular actions. It looks usable, but visually busy and not very Wabi-specific.
5. Mobile media attachments can dominate the viewport; screenshot cards/images are wide and rounded but not integrated into the message rhythm.
6. Desktop empty chat/search state in `image (2).png` is a big blank center with a right panel and a tiny search strip. It feels unfinished even though the shell is functional.
7. Desktop `image (1).png` shows a TUI/debug overlay style on top of the normal website. This is cool as a power/debug mode, but it should not be the normal website surface.
8. Desktop right panel has useful pieces (members, notes/DM), but hierarchy is weak: notes area consumes persistent space even when empty; filters/search feel generic; top icon strip feels like raw toolbar buttons.
9. The version/debug footer (`Version dev - for debugging reasons only`) is visible in normal app chrome from `Chat.svelte:516-518`; this should be gated to dev/debug mode.
10. Mobile navigation exists in `MainLayout.svelte:688-733` as a hidden grabber + bottom nav, but the screenshots suggest the actual normal mobile experience is still using Discord-like header/back mechanics. Need runtime verification of which mobile chrome is live today.

Design direction:

- Wabi should feel like a self-hosted community cockpit: dark, calm, expressive, practical.
- Mobile should prioritize reading and replying, with side panels as gestures/drawers, not heavy persistent chrome.
- Desktop should prioritize a useful center canvas: channel welcome/empty state, conversation/search context, and optional side panels.
- Debug/TUI/power features should remain available, but opt-in and visually distinct from normal mode.

---

## Phase 0: Runtime audit before changing visuals

### Task 1: Confirm the served route and active worktree

**Objective:** Make sure the screenshots map to the current `~/wabi` frontend and not an older deployed/stale build.

**Files:**
- Inspect only: `frontend/package.json`
- Inspect only: `frontend/src/routes/+page.svelte`
- Inspect only: `frontend/src/lib/components/MainLayout.svelte`

**Steps:**

1. From `/home/Ronin/wabi/frontend`, run:
   ```bash
   bun install
   bun run check
   ```
2. Start the frontend in dev mode using the project’s existing command from `package.json`.
3. Open the local site in browser automation at desktop width and mobile width.
4. Confirm whether the visible mobile header/composer matches the screenshots.
5. Confirm whether the TUI/debug overlay from `image (1).png` is a current mode, stale screenshot, feature flag, or route.

**Verification:**

- Capture desktop screenshot at about `1536x864`.
- Capture mobile screenshot at about `390x844` or Redmi-like viewport.
- Record exact URL, worktree path, and dev server command in the implementation notes.

**Do not proceed to visual edits until this is known.**

---

## Phase 1: Mobile app-shell cleanup

### Task 2: Make mobile header compact and Wabi-specific

**Objective:** Reduce header chrome and improve channel/DM identity on mobile.

**Files:**
- Modify: `frontend/src/lib/components/chat/ChatHeader.svelte`
- Modify: `frontend/src/styles/components/chat-header.css`
- Modify: `frontend/src/styles/components/chat-mobile.css`

**Plan:**

1. Keep `ChatHeader.svelte` as the logical header component.
2. Add mobile-only structure/classes rather than a separate header component unless runtime audit proves current markup cannot support it.
3. Mobile header should show:
   - channel/DM name as the primary text
   - small status/subtitle line only when useful
   - search as a compact icon/action unless actively searching
   - DM call/video actions only for DMs, but smaller and less dominant than screenshots
4. Avoid absolute-centered title fighting with left/right action groups. Current CSS in `chat-mobile.css:63-72` centers `h2` absolutely; replace with a grid/flex layout that reserves action slots.

**Implementation shape:**

- Add a class on `chat-header` for mobile-friendly title/action zones if needed.
- CSS target:
  ```css
  @media (max-width: 768px) {
    .chat-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      min-height: 48px;
      height: auto;
      padding: max(0.5rem, env(safe-area-inset-top)) 0.75rem 0.5rem;
    }

    .chat-header h2 {
      position: static;
      transform: none;
      width: auto;
      justify-content: flex-start;
    }
  }
  ```
- Exact values can be adjusted after screenshot verification.

**Verification:**

- Mobile title never overlaps search/call buttons.
- Long channel names ellipsize cleanly.
- DM call/video buttons remain tappable but not visually giant.
- No raw/default button styling appears.

---

### Task 3: Fix mobile message density by removing conflicting overrides

**Objective:** Make mobile message reading comfortable without the weird “giant Discord screenshot” feeling or cramped continuation hacks.

**Files:**
- Modify: `frontend/src/styles/components/ml-mobile.css`
- Inspect: `frontend/src/styles/components/ml-core.css`
- Inspect: `frontend/src/lib/components/message/*.svelte`

**Problem:**

`ml-mobile.css` currently has multiple mobile blocks that fight each other:

- early block at `@media (max-width: 768px)` sets compact avatars/messages
- later block at lines around `419-472` changes readability and continuation rhythm
- final block around `475-523` applies more `!important` overrides

This makes future tuning unpredictable.

**Plan:**

1. Consolidate mobile message overrides into one final mobile section.
2. Keep 36px avatars on normal mobile; do not shrink to 24px except very narrow screens.
3. Use a stable rhythm:
   - first message in group: enough top margin
   - continuation messages: compact but readable
   - markdown/body line-height around `1.38-1.45`, not overly huge
4. Avoid `!important` except where overriding density modes is intentional and documented.
5. Keep username/timestamp hierarchy clear but not enormous.

**Verification:**

- Screenshot a long text message like `Screenshot_20260502-113209.png`.
- Screenshot a media-heavy message like `Screenshot_20260502-131716.png`.
- Check text wrapping on Redmi-width viewport.
- Ensure no horizontal scroll.

---

### Task 4: Redesign mobile composer as a practical Wabi composer

**Objective:** Keep all current actions, but make the bottom composer calmer and less crowded.

**Files:**
- Modify: `frontend/src/lib/components/chat/ChatComposer.svelte`
- Modify: `frontend/src/styles/components/chat-composer.css`
- Modify: `frontend/src/styles/components/chat-mobile.css`

**Plan:**

1. Audit `ChatComposer.svelte` to identify attach/media/gift/payment/emoji/mic/send controls.
2. On mobile, expose only the most common controls directly:
   - attach / plus
   - message textarea
   - emoji
   - mic or send depending on typing state
3. Move secondary actions (gift/payment/extra tools) into a compact “more” sheet/menu if the component already supports that pattern; otherwise hide only visually behind a single plus action with CSS/markup ready for later behavior.
4. Keep `font-size: 16px` on textarea to avoid mobile browser zoom.
5. Make composer background intentionally layered, not transparent-floating noise.

**Verification:**

- With keyboard closed, composer fits safe-area bottom.
- With keyboard open, textarea remains usable.
- Placeholder is readable.
- Long input grows predictably and does not cover the last message.

---

### Task 5: Mobile media/card presentation pass

**Objective:** Make screenshots/images/video attachments feel like Wabi message cards, not random pasted rectangles.

**Files:**
- Modify: `frontend/src/styles/components/ml-media.css`
- Modify: `frontend/src/styles/components/ml-mobile.css`
- Inspect: `frontend/src/lib/components/message/MessageFileContent.svelte`

**Plan:**

1. Add mobile max width rules for media blocks so they do not visually smash into viewport edges.
2. Preserve tap targets for opening media.
3. Use consistent card radius/border/shadow from tokens.
4. Add caption/text spacing after media to match screenshot case: image then “latest wabi screenshot”.

**Verification:**

- Media card has breathing room on both sides.
- Captions below media align with message text, not card edge confusion.
- No media overflows the viewport.

---

## Phase 2: Desktop/web main surface cleanup

### Task 6: Add an intentional empty-channel / search-empty state

**Objective:** Replace the huge blank center in `image (2).png` with a useful, branded empty state.

**Files:**
- Modify: `frontend/src/lib/components/chat/ChatMessagesPane.svelte`
- Modify: `frontend/src/styles/components/chat-workspace.css`
- Modify: `frontend/src/styles/components/chat-search.css`

**Plan:**

When there are no messages or when search returns 0 results, show a centered-but-not-huge panel:

- channel name: `# general`
- short copy: “This is the start of your self-hosted space.”
- quick actions as small cards/buttons:
  - “Send first message” focuses composer
  - “Open channels” / “Invite people” if those actions exist
  - “Search web” only if the enhanced search feature is enabled
- For search empty state, show query and clear/search-web actions.

**Verification:**

- Empty channel no longer looks broken.
- Search with no results no longer leaves a tiny row at top and blank center.
- Composer focus action works if implemented.

---

### Task 7: Gate debug footer and TUI/debug visual mode

**Objective:** Keep debug power-user information without making the normal website look unfinished.

**Files:**
- Modify: `frontend/src/lib/components/Chat.svelte:516-518`
- Search/inspect: any files mentioning `for debugging reasons only`, `TUI`, `terminal`, `debug-version-footer`
- Modify: CSS file containing `.debug-version-footer` rules, likely `frontend/src/styles/components/chat-core.css` or `chat-workspace.css`

**Plan:**

1. Find `debug-version-footer` styling and all references.
2. Gate footer behind a dev/debug condition:
   - `import.meta.env.DEV`, or
   - existing debug setting if one exists, or
   - `?debug=1` local flag if project already uses URL flags.
3. If `image (1).png` TUI overlay is a deliberate feature, move it into a named mode/route/panel with an obvious toggle label like “Terminal mode”, not the default chat website.
4. If it is stale/debug-only, prevent it from appearing in normal runtime.

**Verification:**

- Normal desktop and mobile screenshots do not show “Version dev - for debugging reasons only”.
- Dev/debug mode still can show the version somewhere low-impact.
- No production user sees terminal/TUI chrome by default.

---

### Task 8: Desktop header and toolbar hierarchy pass

**Objective:** Make the desktop top bar feel less like a raw collection of icons/search/filters.

**Files:**
- Modify: `frontend/src/lib/components/chat/ChatHeader.svelte`
- Modify: `frontend/src/styles/components/chat-header.css`
- Modify: `frontend/src/styles/components/chat-search.css`
- Inspect/modify: `frontend/src/lib/components/RightPanel.svelte`

**Plan:**

1. Keep channel title left; keep search/action zone right.
2. Group workspace buttons visually as a segmented icon cluster.
3. Do not show all workspace icons at full visual weight all the time; current hover-compaction in `chat-mobile.css:8-43` is oddly located in mobile file despite being desktop hover behavior. Move desktop compaction styles into a desktop/header CSS section.
4. Search should not use a pale yellow default-looking input unless that is intentional theme. Use tokenized dark input with accent focus.
5. Make active view/action state clearer.

**Verification:**

- Desktop header has clear title, then action cluster, then search.
- Icons are discoverable but not visually noisy.
- Header looks coherent with sidebars/right panel.

---

### Task 9: Right panel hierarchy and empty notes cleanup

**Objective:** Make the right panel useful without wasting huge space when notes/DM are empty.

**Files:**
- Inspect/modify: `frontend/src/lib/components/RightPanel.svelte`
- Inspect/modify: right panel CSS under `frontend/src/styles/components/` (find actual file via search)

**Plan:**

1. Identify current right panel tabs: members, notes, DM, media, etc.
2. Make members the obvious default when on server/channel.
3. Collapse notes editor to a smaller card when empty, or make it a tab that does not reserve persistent vertical bulk unless active.
4. Improve filters/search styling:
   - tighter labels
   - stronger selected state
   - readable empty/member states
5. Use cards/sections instead of flat blank panes.

**Verification:**

- Right panel at desktop width still fits useful content.
- Empty notes does not dominate the bottom right.
- Member list and filters are readable at current panel width.

---

## Phase 3: Mobile navigation and side panels

### Task 10: Verify and simplify mobile navigation behavior

**Objective:** Make channel/member navigation obvious on mobile without a hidden mystery grabber.

**Files:**
- Modify: `frontend/src/lib/components/MainLayout.svelte:688-733`
- Modify: `frontend/src/styles/components/main-layout-part2.css:98-164`
- Modify: `frontend/src/styles/components/sidebar-mobile.css`

**Plan:**

1. Runtime-audit whether `mobile-nav-grabber` is actually visible/usable.
2. Decide one primary mobile navigation model:
   - A: always-visible compact bottom nav, or
   - B: header buttons + swipe drawers, with grabber only as hint.
3. Recommendation: for Wabi mobile web, use always-visible compact bottom nav unless keyboard is open or in-call. Hidden nav hurts discoverability.
4. Restyle bottom nav to Wabi tokens:
   - less generic rounded bar
   - clear active state
   - labels readable at Redmi width
5. Ensure side panels use full-height drawer with safe-area padding and close affordance.

**Verification:**

- New user can discover channels/users without knowing gestures.
- Swipe still works.
- Backdrop closes panels.
- Keyboard/composer does not fight bottom nav.

---

### Task 11: Mobile DM header/call actions pass

**Objective:** Fix DM screenshot style where call/video icons dominate the top row.

**Files:**
- Modify: `frontend/src/lib/components/chat/ChatHeader.svelte`
- Modify: `frontend/src/styles/components/chat-mobile.css`

**Plan:**

1. For DM mobile header, show avatar/name/status as identity.
2. Move call/video buttons into compact icon buttons aligned right.
3. If both call buttons do not fit, use one primary call button plus overflow for video.
4. Preserve accessibility labels and disabled states.

**Verification:**

- DM header fits at 360px width.
- Call actions are tappable and do not crowd title.
- Long usernames do not overlap buttons.

---

## Phase 4: Visual identity pass

### Task 12: Establish one small Wabi visual language for chat shell

**Objective:** Make the main website feel like Wabi, not Discord clone + debug panels.

**Files:**
- Modify: `frontend/src/app.css` token defaults if needed
- Modify: `frontend/src/styles/components/buttons.css`
- Modify: `frontend/src/styles/components/inputs.css`
- Modify: `frontend/src/styles/components/panels.css`
- Modify component CSS files touched above

**Plan:**

Use existing tokens first. Do not add a new theme engine.

Visual language:

- Background: deep layered dark surfaces, subtle gradient only where it helps depth.
- Accent: existing Wabi green/blue/purple tokens, but use them intentionally for active/online/focus, not random large fills.
- Borders: low-contrast but visible enough to separate panels.
- Cards: soft border, subtle shadow, consistent radius.
- Buttons: clear variants — icon, ghost, secondary, primary, danger.
- Inputs: explicit background, caret, placeholder, focus ring.

**Verification:**

- Controls across header/composer/right panel share the same visual vocabulary.
- No raw browser default controls in inspected screens.
- Focus states are visible on keyboard navigation.

---

## Phase 5: Validation matrix

### Task 13: Static checks

**Objective:** Ensure visual changes do not break Svelte/TypeScript.

**Command:**

```bash
cd /home/Ronin/wabi/frontend
bun run check
```

**Expected:** Existing baseline or better. If unrelated existing errors appear, record them and decide whether to fix before continuing, per Wabi clean-build preference.

---

### Task 14: Runtime screenshots and manual QA

**Objective:** Prove the actual rendered app matches the plan.

**Viewports:**

- Desktop: `1536x864`
- Desktop narrower: `1280x720`
- Mobile Redmi-ish: `393x873`
- Very narrow mobile: `360x800`

**States to verify:**

1. Empty channel / no messages.
2. Normal channel with long text messages.
3. Channel with image/media message.
4. DM header with call/video actions.
5. Search expanded with results.
6. Search expanded with 0 results.
7. Right panel members tab.
8. Right panel notes tab empty.
9. Mobile channel drawer open/close.
10. Mobile user/right panel open/close.
11. Composer focused with keyboard emulation if browser tooling supports it.
12. Debug/dev mode footer visibility.

**Required evidence:**

- Save screenshots under a temporary path or report browser screenshot paths.
- Report exact command results.
- Do not claim visual verification for states not rendered.

---

## Likely files to change

Primary:

- `frontend/src/lib/components/chat/ChatHeader.svelte`
- `frontend/src/lib/components/chat/ChatComposer.svelte`
- `frontend/src/lib/components/chat/ChatMessagesPane.svelte`
- `frontend/src/lib/components/Chat.svelte`
- `frontend/src/lib/components/MainLayout.svelte`
- `frontend/src/lib/components/RightPanel.svelte`
- `frontend/src/styles/components/chat-header.css`
- `frontend/src/styles/components/chat-mobile.css`
- `frontend/src/styles/components/chat-composer.css`
- `frontend/src/styles/components/chat-search.css`
- `frontend/src/styles/components/chat-workspace.css`
- `frontend/src/styles/components/ml-mobile.css`
- `frontend/src/styles/components/ml-media.css`
- `frontend/src/styles/components/main-layout-part2.css`
- `frontend/src/styles/components/sidebar-mobile.css`

Secondary / only if needed:

- `frontend/src/app.css`
- `frontend/src/styles/components/buttons.css`
- `frontend/src/styles/components/inputs.css`
- `frontend/src/styles/components/panels.css`
- right-panel CSS file discovered by search

---

## Risks and guardrails

1. Do not start a broad CSS token refactor. This should be targeted polish.
2. Do not remove debug/TUI features outright; gate or isolate them.
3. Do not rely on `bun run check` alone. Visual runtime verification is mandatory.
4. Be careful with mobile CSS because current files already contain overlapping overrides. Consolidate rather than pile on more `!important`.
5. Preserve Wabi's self-hosted/debuggable product truth. We are making it polished, not hiding useful self-hosting details.
6. If screenshots are from stale deployed state, update the plan with the actual live/local state before editing.

---

## Suggested implementation order

1. Runtime audit and screenshots.
2. Debug footer/TUI gating, because it removes obvious unfinished chrome with low risk.
3. Mobile header cleanup.
4. Mobile message density consolidation.
5. Mobile composer cleanup.
6. Desktop empty/search state.
7. Desktop header toolbar cleanup.
8. Right panel hierarchy cleanup.
9. Final visual identity pass.
10. Full static + runtime verification matrix.

This order fixes the most visible “this looks unfinished” issues before deeper design polish.
