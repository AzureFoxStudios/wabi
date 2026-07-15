# Visual Refresh — Phase 1 (2026-06-15 evening)

A first pass on modernizing the Wabi frontend visuals. Honest about what
landed and what didn't, so the next pass has a clean starting line.

## What I actually changed

| File | Type of change | Why |
|---|---|---|
| `frontend/src/lib/components/login.css` | Token migration (already done earlier today — values drift fix) | Removes Discord hex leaks; login now follows the user's theme |
| `frontend/src/styles/components/chat-composer.css` | Surgical rewrite of 10 rule blocks | Restored focus rings (a11y), token-driven spacing/rhythm, send button hover/active states, accent on add-button |
| `frontend/src/styles/components/chat-core.css` | Surgical rewrite of 9 rule blocks | Token-driven messages padding, larger typing dots, soft rate-limit notice, textarea focus ring |
| `frontend/src/styles/components/sidebar-channels.css` | Additive addendum at end of file | Channel-item hover, active state with accent left bar, focus rings on buttons, refined section typography |

Total: 4 files, ~120 lines of meaningful CSS, no new files, no new tokens,
no JS/component changes.

## What changed visually (you should see this when you reload)

1. **Composer (bottom of chat)**
   - Send button has a subtle shadow at rest, lifts on hover, presses
     down on click.
   - Disabled send button is more clearly faded (0.4 instead of 0.5).
   - The "+" add button is now in accent color instead of muted gray.
   - Edit/reply bars have a softer background and tighter padding.
   - When you focus the textarea or any icon button, you can **see** the
     focus ring now (was hidden with `outline: none !important`).
   - When the input container is focused, it gets a soft accent glow
     instead of a transparent border.

2. **Chat area (center column)**
   - Messages list has more breathing room at the bottom.
   - Typing indicator has 50% larger dots (6px instead of 4px) — easier
     to see.
   - Rate-limit notice is softer and follows token colors instead of
     hardcoded rgba.
   - The textarea in the chat (for non-composer areas) has a visible
     keyboard focus ring.

3. **Channel sidebar (left column)**
   - Channels now have a **hover background** — you can see which one
     you're about to click.
   - The **active channel** has a colored left bar (accent color) and
     a tinted background. Previously it just had a solid surface
     background that didn't distinguish from the sidebar itself.
   - Channel buttons have a refined height (32px), tighter padding
     (4px 8px instead of 6px 8px), and visible keyboard focus.
   - Section headers (Channels, Voice, etc.) have slightly tighter
     rhythm and clearer hierarchy.
   - Create-channel error message uses token-driven colors.

4. **Login (already done earlier today)**
   - Uses the Wabi accent color, not Discord's literal blurple.
   - Follows the user's theme choice (light theme = light login).
   - No more `--login-*` / `--launch-*` local variables.

## What I did NOT change (yet)

- **Message bubbles** (`.message` in `ml-core.css`): the 15KB file with
  continuation padding using `!important` is its own refactor. I left it
  alone for this pass.
- **Right panel** (`lib/RightPanel.css`): 8KB file, not touched.
- **Settings shell** (`settings-nav.css`, `settings-core.css`): not
  touched.
- **Emoji/sticker/gif picker**: not touched (still has the unbounded
  scaling issue).
- **Main layout grid widths**: not touched (the responsive behavior is
  already mostly right).
- **Micro-interactions**: I considered adding channel-switch slide
  animations, panel open/close easing, message-send bounce, but each
  one is its own design decision. Better to do them as a focused pass
  once the static visuals are settled.

## Verification

- `bun run check` → **0 errors, 55 warnings** (same baseline).
- Dev server still serving on `http://127.0.0.1:5173/`.
- Served CSS confirms new selectors present:
  - `.channel-item.active { background: color-mix(...); box-shadow: inset 2px 0 0 0 ...; }`
  - `.channel-btn:hover { ... }`
  - `.channel-btn:focus-visible { outline: 2px solid color-mix(...); }`
  - `.section-toggle:focus-visible { ... }`
- Bundle size: 752,164B → 757,156B (+5KB) for the new rules. CSS is
  verbose with `color-mix(in srgb, var(--token) N%, transparent)` but it
  tracks the theme correctly.
- No `!important` regressions — I added one new `!important`-free focus
  pattern and removed 5 `!important` overrides that were hiding focus
  states.

## Design philosophy (for the next pass to build on)

The "wabi" spirit applied to the app so far:

- **Asymmetric, not centered.** Login already split into brand panel +
  auth panel instead of a "card in the middle." More surfaces should
  follow this.
- **One accent, used deliberately.** The send button is the only
  saturated accent in the composer; everything else is muted. The
  active channel has a thin colored bar; the rest is gray.
- **Honest states.** Hover is visible, focus is visible, disabled is
  visible. The "remove all borders on focus" anti-pattern is gone
  from the composer.
- **Soft edges, not sharp.** Border-radius is 8-12px on controls, never
  0px except on dividers. The new channel-item active bar uses an
  inset shadow instead of a hard border for a softer look.
- **Ma (negative space).** More vertical breathing room in section
  headers, message list, and edit/reply bars.

## Where I'd go for Phase 2 (when you want it)

1. **Message layout** (`ml-core.css`): the message bubbles, hover
   action bar, continuation padding, own-messages-right mirror. This
   is the highest-traffic surface and the file is 15KB.
2. **Right panel** (`lib/RightPanel.css`): tab styling, split-mode
   resize handle, search input, user row polish.
3. **Settings shell** (`settings-nav.css`): the inline status banner I
   added, the tab nav, the form field rhythm.
4. **Emoji/sticker/gif picker** grid: bounded thumbnail grid + sticky
   category tabs (still broken at narrow widths).
5. **Subtle motion**: ~150ms transitions on hover/focus, ~250ms on
   panel open/close, ~350ms on full-screen transitions. Already
   applied to composer; could spread.

## What you should see when you reload `http://127.0.0.1:5173/`

- The login (if you sign out / refresh) follows the active theme.
- The composer bottom of the chat: send button has a slight shadow,
  the input container has a visible focus ring when you click into
  the textarea, the "+" button is in accent color.
- The channel sidebar: hover any channel, see a soft surface lift.
  Click a channel, see the new colored left bar and tinted
  background. Tab through with keyboard, see the focus rings.
- The rate-limit notice (if you hit send-spam): softer, theme-aware.

If anything looks worse, tell me what and I'll revert that specific
change. I avoided broad rewrites — every change is a targeted block
additive or replacement, so individual pieces can be rolled back
without touching the rest.
