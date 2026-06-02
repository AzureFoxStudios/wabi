# Wabi Frontend Next Tackle Plan

> **For Hermes:** Use this as the next implementation pass after the current visual-polish snapshot. The goal is not only to remove raw browser controls, but to recover the stronger Wabi visual identity that was diluted during refactors.

**Goal:** Re-polish the current local Wabi frontend with priority on login, DMs, button/control consistency, and restoring intentional product feel.

**Design direction:** Compact self-hosted creative workspace. Calm dark surfaces, readable controls, confident accent use, and artist-friendly polish. Avoid raw browser widgets, equal-weight auth choices, Discord clone clutter, SaaS confetti, or generic generated UI.

**Current read from Ronin:**
- Localhost updated version is the reference target.
- Login needs a major touch-up.
- Buttons were partly addressed, but the UI lost some of its old look during refactoring.
- DMs need a hard redo.
- Preferred priority order is locked as: login/auth landing, DM hard redo, button/control polish recovery, then broader Wabi-look restoration.
- Login should move away from a card/box behind the logo and fields. Favor a cleaner composition: logo as a visual anchor on left/right/center with fields adjacent or grouped beside it, rather than everything sitting inside a heavy translucent box.

**Personalization clarification:** Fonts/themes must not be collapsed into one global setting. Wabi should distinguish:
- **User identity style:** a user can choose their own visible display style, such as username font and possibly message font/style when allowed. Other users see this by default because it is part of that person's identity.
- **Viewer readability override:** a viewer can locally force readable fonts/sizes/effects if other users' styling is distracting or illegible. Current `UniformFontMode.svelte` belongs here: it is a local readability/sanity override, not the user's own identity font.
- **Server/admin policy:** owners can decide whether custom fonts, uploaded fonts, message fonts, channel themes, and theme packs are allowed server-wide or only from an approved list.

**Animated theme guidance located on Ironin:** `ironin@100.80.172.12:~/Documents/wabi-guide-animated-themes.md` is the missing Wabi theme guidance. It says Wabi already has a stronger CSS variable/theme-token architecture than Odysseus, but lacks Odysseus-style animated background life. Fold this into the personalization backlog after P0 visual polish unless Ronin explicitly prioritizes themes first.

Key takeaways from that guide:
- Add a single canvas-based background effect layer behind the UI, managed by an `EffectManager` singleton.
- Preserve Wabi's existing palette → semantic token derivation engine; animated effects extend the theme system, not replace it.
- Suggested effects: `none`, `synapse`, `petals`, `constellations`, `embers`, `rain`, `perlin-flow`, `sparkles`, `aurora`.
- Each theme can have a default effect/color mapping; users can override effect, color, intensity, size, and speed in Appearance.
- Hook into existing `animationQuality` and `prefers-reduced-motion`: disable on low/reduced motion, halve particles or use 30fps on balanced, full at 60fps.
- Background images and effects must blend: effect opacity should reduce when a custom background image is present.
- Add a global Frosted Glass toggle only with performance warnings; `backdrop-filter` is GPU-heavy and should be disabled/hidden for low-quality mode.
- Verification must include rapid theme switching, cleanup/no RAF leaks, HiDPI/Tauri resize behavior, and browser performance profiling — not only type checks.

---

## Priority order

### P0 — Login / auth landing touch-up

**Why:** It is the first impression. Current `Login.svelte` still treats Guest/Login/Register as equal tabs, which makes the product feel less deliberate. The logo/card also need hierarchy and polish.

**Files:**
- Modify: `frontend/src/lib/components/Login.svelte`
- Modify: `frontend/src/lib/components/login.css`
- Check: `frontend/src/lib/components/login/LaunchPanel.svelte`
- Check: `frontend/src/lib/components/login/LoginConnectionPrompt.svelte`
- Check i18n keys if labels change: `frontend/src/lib/i18n*` / locale files

**Implementation tasks:**

1. Replace the three equal `Guest / Login / Register` tab model.
   - No equal tabs on the main screen.
   - Default should be deliberate, not arbitrary: either registered-user login as the main flow, or a guest-first flow with a clearly labelled secondary entry such as `Have an account? Log in` / `Create owner account` depending setup state.
   - Make `Register` discoverable but secondary. A two-click registration path is acceptable because registration is rare/once-and-done, but the label must not make first-time users infer that `Login` secretly contains registration.
   - Make `Continue as guest` secondary unless the product decision is explicitly guest-first for that screen.
   - Preserve setup wizard mode: if `wizardMode`, registration remains primary.

2. Split auth mode rendering into clearer internal sections.
   - Keep state in `Login.svelte` initially; do not over-fracture until the UX settles.
   - Replace `tab` with an `authMode` model if useful: `'login' | 'register' | 'guest'`.
   - Avoid introducing routing unless needed.

3. Improve layout and hierarchy.
   - Remove the heavy card/box behind the logo and fields for the default local login.
   - Use a cleaner split or adjacent composition: logo as a visual anchor, fields beside or near it, with enough negative space that it feels intentional rather than form-in-a-box.
   - Keep mobile fallback simple: logo above, fields below, no cramped split layout.
   - Reduce logo dominance on normal login.
   - Add stronger title/subtitle copy area when no custom LaunchPanel is active.
   - Keep launch-page custom config compatible.

4. Polish controls.
   - Login submit = primary button.
   - Register/Guest/QR/Business Hub = secondary or tertiary buttons, not all equal.
   - Server target/change row becomes a small server pill/toolbar, not a plain row.
   - Language select should sit in a quiet footer/tool row, not interrupt the auth flow.

5. Mobile check.
   - On narrow screens, the auth card should fit without the logo eating the viewport.
   - Inputs remain 16px+ to avoid mobile browser zoom.

**Verification:**
- `bun run check`
- Browser-harness local visual smoke:
  - first screen has one clear primary action
  - guest/register are discoverable but secondary
  - no raw/default buttons
  - default login does not render as a heavy centered box/card behind the logo and fields
  - logo/field relationship feels intentional at desktop and mobile widths

---

### P0 — DM hard redo

**Why:** DMs are core Discord-alternative UX. Current code has both legacy wrappers and extracted frames/content; this is the right area for a focused redesign pass, not only a CSS patch.

**Files discovered:**
- `frontend/src/lib/components/DMTab.svelte`
- `frontend/src/lib/components/DMMessageView.svelte`
- `frontend/src/lib/components/dm/DMTabFrame.svelte`
- `frontend/src/lib/components/dm/DMTabContent.svelte`
- `frontend/src/lib/components/dm/DMMessageViewFrame.svelte`
- `frontend/src/lib/components/dm/DMMessageViewContent.svelte`
- `frontend/src/lib/components/CreateDMModal.svelte`
- Related audit: `audit/rightpanel-dm-audit.md`

**Implementation tasks:**

1. Re-audit DM runtime UI before editing.
   - Open DMs in local browser.
   - Capture screenshots for: empty DM list, populated DM list, active 1:1 DM, group DM, DM settings/actions, quick DM if present.
   - Record the worst visual problems: spacing, hierarchy, unread state, avatar/name duplication, header action clutter, composer mismatch.

2. Decide shell boundaries before code changes.
   - `DMTabFrame.svelte` should own layout shell: list column, active conversation region, responsive behavior.
   - `DMTabContent.svelte` should own conversation list behavior and empty states.
   - `DMMessageViewFrame.svelte` should own active conversation shell/header/composer placement.
   - `DMMessageViewContent.svelte` should own message rendering and special cards.
   - Legacy `DMTab.svelte` and `DMMessageView.svelte` should become wrappers/barrels or be retired only after references are verified.

3. Redesign DM list.
   - Use compact rows with avatar, display name, handle/status/unread snippet.
   - Clear active row state.
   - Clear unread/mention state.
   - Row hover actions should not permanently clutter the list.
   - Group DM and 1:1 DM should share a base row shell with type-specific badges.

4. Redesign active DM header.
   - Header should show avatar/group icon, name, status/privacy pill, and a small action cluster.
   - Move privacy mode into a consistent pill/dropdown rather than scattered warning/context fragments.
   - Call/video/delete/settings actions need consistent icon-button styling.

5. Redesign DM message area.
   - Align spacing with main chat message polish.
   - Special cards like directions/payment/notes should become intentional card components or at least tokenized card styles.
   - Avoid duplicating main chat styling if shared message primitives already exist.

6. Redesign DM composer.
   - Match main composer quality: readable typed text, clean placeholder, focus ring, attachment/emoji controls if present.
   - Keep Enter/Shift+Enter behavior unchanged.

7. Remove duplicate or dead styles after the UI settles.
   - Use search-based removal only.
   - Do not bulk delete by line range.
   - Run checks after pruning.

**Verification:**
- `bun run check`
- Browser-harness local smoke:
  - DM list row hierarchy readable
  - active conversation clear
  - group vs 1:1 clear
  - privacy mode understandable
  - composer readable and styled
  - no raw buttons/selects in DM area

---

### P1 — Button/control polish recovery pass

**Why:** Some raw controls were partly addressed, but the app lost visual character during refactors. This pass should restore a consistent Wabi control language.

**Known affected areas:**
- Right panel stack tabs/actions
- Quick resources panel
- Notes/DM segmented toggle
- Channel action buttons
- Search inputs/selects
- Login server/language controls
- DM header/list/composer controls

**Files likely involved:**
- `frontend/src/lib/components/RightPanel.css`
- `frontend/src/lib/components/QuickResourcesPanel.svelte`
- `frontend/src/styles/base.css`
- `frontend/src/styles/tokens.css`
- `frontend/src/styles/components/sidebar-*.css`
- `frontend/src/lib/components/login.css`
- DM component styles

**Implementation tasks:**

1. Define control tiers in CSS, using existing tokens where possible.
   - Primary button
   - Secondary button
   - Ghost icon button
   - Segmented control
   - Tiny toolbar button
   - Resize handle/grip
   - Select/input field

2. Prefer reusable class patterns, not one-off patches everywhere.
   - Do not force a global `button { ... }` reset that breaks specialized components.
   - Add scoped utility classes or component-local class groups.

3. Runtime audit for raw browser controls.
   - In browser, inspect visible buttons/selects/inputs.
   - Flag `2px outset`, `buttonface`, `rgb(239,239,239)`, default `appearance:auto` on visible controls where it causes default rendering.

4. Patch by cluster.
   - Login controls.
   - Right panel controls.
   - Quick resources controls.
   - DM controls.
   - Sidebar/channel controls.

**Verification:**
- Runtime computed-style audit shows no visible raw browser buttons in the main app shell.
- Keyboard focus states still visible.
- Mobile touch targets remain usable.

---

### P1 — Restore Wabi look after refactor dilution

**Why:** The refactor improved structure but flattened some visual identity. This pass should intentionally bring back depth and recognizability without reintroducing hardcoded color mess.

**Implementation tasks:**

1. Identify the pre-refactor visual traits worth preserving.
   - Accent glow or glass depth where it helped.
   - Distinct Wabi dark gradients.
   - Rounded/pill controls.
   - Compact creative-tool density.

2. Apply through tokens and component classes.
   - No scattered hardcoded hex unless token fallback is necessary.
   - Use `rgba(var(--accent-rgb), alpha)` and semantic surface tokens.

3. Avoid over-polishing every addon panel.
   - Focus on shell, login, DMs, chat/composer, channels first.

**Verification:**
- Visual smoke against localhost.
- Screenshots compared to the current local baseline.
- No explosion of bespoke CSS.

---

## Suggested execution sequence

1. Login touch-up first.
2. DM runtime audit and screenshot pass.
3. DM hard redo.
4. Button/control recovery pass across the shell.
5. Final focus/mobile/browser visual smoke.

This order gives a visible win first, then tackles the biggest broken core UX, then normalizes the rest.

---

## Commands

From `frontend/`:

```bash
bun run check
bun run build
```

Browser-harness verification should use localhost/current dev server, not stale remote build, unless specifically comparing deployment.

---

## Notes / constraints

- Do not delete legacy DM wrappers until all imports are verified.
- Do not use line-range bulk deletion for dead state/style cleanup.
- Runtime visual verification is required; `bun run check` is not enough for this pass.
- Preserve launch page customization compatibility while touching login.
- Preserve setup wizard behavior.
