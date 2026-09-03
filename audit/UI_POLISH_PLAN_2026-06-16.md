# Wabi Frontend Polish — 2026-06-16 (Sleeping Pass)

A "comb the website from all sides" visual/UX polish pass. The user is
sleeping. Goal: clean, modern, opinionated design pass on the top
user-facing surfaces without touching backend, infra, or breaking
the work in flight from prior regression sessions.

## Hard scope

**Allowed files** (frontend only):
- `frontend/src/routes/+layout.svelte`, `+page.svelte`,
  `business/+page.svelte`, `detached/+page.svelte`
- `frontend/src/lib/components/*.svelte` and the chat/media-albums/
  business/sidebar subfolders
- `frontend/src/lib/components/login.css`, `userPanel.css`,
  `RightPanel.css` and similar top-level component CSS files
- `frontend/src/styles/**` (tokens.css, base.css, polish.css,
  styles.css, animations.css, accessibility.css, mobile.css,
  components/*.css)

**Forbidden files** (do NOT touch):
- Anything under `core/`, `wabi-server`, `wabi-deploy/`,
  `packages/`, `scripts/`, `addons/`, `PROJECT_DOCS/`
- `Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`,
  `bun.lockb`, `vite.config.ts` (unless a CSS-only theme token
  addition is required)
- `frontend/src/lib/socket*.ts`, `socketConnectionCore.ts`,
  `localMockSocket.ts`, `localMockApi.ts`, `storage*`, `tauri-*`,
  `*Store.ts` (state stores, not visual surface)
- `frontend/src/lib/emoji-store.ts`, `calling*.ts`,
  `calling_impl_*.ts`, `p2pFileTransfer.ts`, `placeStore.ts`,
  `presenceStore.ts`, `workspacePanels.ts`
- `frontend/src/lib/components/CallView.svelte`,
  `CallModal.svelte`, `IncomingCallModal.svelte` (calling is
  unstable; do not touch)
- `frontend/src/lib/components/TransferCard.svelte`,
  `TransferCenter.svelte` (P2P UI is a different workstream)
- `BACKEND_AUDIT.md`, `BACKEND_FEATURE_INVENTORY_AUDIT.md`,
  `CLEANUP_PLAN.md`, `CONFIG_IN_DB_DESIGN.md` and other audit docs
- `frontend/static/openmoji/**` (binary assets)
- Do NOT commit, do NOT rebase, do NOT switch branches.

## What "great UX + modern design practice" means in Wabi

1. **Token discipline.** Use the global design tokens
   (`--surface-*`, `--text-*`, `--border-*`, `--accent-*`,
   `--color-*`, `--space-*`, `--radius-*`, `--font-size-*`,
   `--shadow-*`). No hard-coded hex. No `rgba(123, 45, 67, X)`
   literals — use `color-mix(in srgb, var(--accent-primary) N%,
   transparent)`. No local `var(--my-color)` declarations inside
   components. The tokens live in
   `frontend/src/styles/tokens.css` and are layered on top of
   `themeManager.ts`. Refer to the existing `polish.css` and
   `accessibility.css` for correct patterns.

2. **Modern visual hierarchy.** Generous spacing, consistent
   radii (8–12px for cards, 6–8px for inputs, 999px for chips),
   clear weight contrast (semibold for headings, medium for
   interactive labels, regular for body), and color used
   semantically (accent for primary CTAs and focus, neutral
   for text, danger for destructive). Avoid the "everything
   is a button" trap — quiet surfaces should stay quiet.

3. **Sensible motion.** Transitions in the 120–200ms range
   with `ease` or `ease-out`. No springs, no bouncing, no
   fancy cubic-beziers. Hover states should change one or
   two properties (background, border, translate) — not
   re-flow the layout. `polish.css` already has the right
   tone; match it.

4. **Clear focus rings.** Every interactive element must have
   a visible focus state. Use `:focus-visible` (not `:focus`)
   to avoid mouse-click outline noise. Pattern:
   `outline: 2px solid var(--accent-primary); outline-offset: 2px;`
   plus a subtle box-shadow for soft keyboards. See
   `accessibility.css` for the current pattern.

5. **Honest empty states.** Empty channels, empty DMs, empty
   search results, no notifications, no transfers — each
   should have a real empty state with an icon, a one-line
   description, and a primary action. The
   `.empty-state` / `.empty-state-icon` /
   `.empty-state-title` / `.empty-state-subtitle` /
   `.empty-state-actions` classes from `polish.css` are
   the right primitives — use them.

6. **Quiet, readable chat.** Message bubbles should breathe.
   Comfortable line-height (1.5–1.6 for body), 0.875–1rem
   message text, username + timestamp on the same row with
   appropriate weight contrast, hover-revealed actions with
   sufficient tap target (≥ 32×32 px on touch, ≥ 28×28 on
   desktop). No `0.0625rem` 1px micro-borders that look like
   rendering bugs. Pinned messages, mentions, links, code
   blocks each get a distinct, semantic treatment — not just
   a different background tint.

7. **Mobile-first breakpoints.** Existing breakpoints in
   `ml-mobile.css`, `chat-mobile.css`, `mobile.css` cover
   the basics. Verify touch targets are ≥ 44 px, that
   no horizontal scroll appears, that the composer
   doesn't get covered by mobile keyboards, that the
   sidebar collapses correctly.

8. **No new dependencies.** No new icon libraries, no
   Tailwind, no new CSS-in-JS. Use the existing tokens,
   existing components, existing patterns.

## Priority order

### P0 — Visible everywhere, low risk, high impact

1. **Login (`Login.svelte` + `login.css`)**
   - Already tokenized per 2026-06-15 audit. Verify the
     login experience reads as calm and modern: spacing,
     button weight, password-input visibility toggle,
     "forgot password" / "create account" link hierarchy,
     error/success inline banners, focus order.
   - Make sure submit button has clear loading state and
     disabled state.
   - Mobile: at < 480px the panel should fill the screen
     and the brand mark should stay visible.

2. **App shell — `MainLayout.svelte` (1009 lines)**
   - Server rail, sidebar, main, right panel — verify
     the 4-column layout works at 1440 / 1280 / 1024 / 768.
   - On < 768 the right panel should become a sheet, not
     a flex column that squeezes the chat.
   - Empty right panel area should not be a dead black box.
   - The server rail server-icon buttons should have
     tooltip on hover and clear focus state.

3. **Channel sidebar — `ChannelSidebar.svelte` (336 lines)**
   - Voice channel labels should be readable; the
     `VoiceChannelList.svelte` and the member list should
     have clear active/connected states.
   - Channel sections (text/voice) should be visually grouped.
   - The "create channel" affordance should be discoverable
     but not noisy.
   - Unread badges and mentions should pop without being garish.

4. **Chat surface — `Chat.svelte` (506 lines) + chat/**
   - Welcome / empty state when no channel is selected.
   - Message grouping: consecutive same-author messages
     should be visually grouped (smaller avatar, tighter
     spacing) — modern chat apps do this.
   - Date separators should be styled as quiet, centered
     dividers, not loud banners.
   - Reply/thread affordance should be obvious and accessible.
   - Link previews and embeds should respect the surface tokens
     and not introduce new colors.

### P1 — Polish that takes longer but matters

5. **Settings — `Settings.svelte` (441 lines) + settings-*.css**
   - The settings nav should look like a real settings nav,
     not a vertical list of buttons.
   - The active nav item should have a clear indicator
     (background tint + left border accent).
   - The "Update" status banner (`settings-nav.css` already
     has `.settings-inline-status`) should be used everywhere
     instead of `alert()` — grep the file.
   - Form inputs should be visually consistent with the chat
     composer inputs (same border, same radius, same focus).

6. **User list / popout / right panel**
   - User list rows should have comfortable spacing.
   - User popout should have a real header with avatar,
     name, status, and a clear role/handle line.
   - Notes input shouldn't have a blue browser glow
     (per 2026-06-14 fix, verify it's still applied).

7. **Empty / loading / error states (cross-cutting)**
   - Add `.empty-state` instances where they're missing:
     empty channel list, empty DM list, empty search,
     empty media albums, empty transfer list, empty
     notifications.
   - Loading skeletons (not spinners) for chat message list,
     channel list, user list. Subtle pulse, no layout shift.
   - Error banner (`polish.css` already has
     `.error-banner`) — grep for `alert(` in components and
     replace with the banner pattern.

8. **Mobile pass — `ml-mobile.css`, `chat-mobile.css`,
   `mobile.css`, `ml-actions.css`**
   - Verify touch targets ≥ 44 px.
   - Verify safe-area insets for notched phones
     (env(safe-area-inset-*)).
   - Composer + send button accessible above the keyboard.
   - No horizontal scroll at 360 px width.

### P2 — Defer or note only

- Theme switcher UI polish (defer; current works).
- Per-user accent color customization (not in scope).
- Re-evaluating the whole icon set (defer; out of scope).
- Animation refinement beyond what `polish.css` already has.

## Verification gate

Before declaring done, OpenCode MUST run all of these and
paste the results into the report:

1. `cd frontend && bun run check` (or `npm run check` if
   bun not available) — must show 0 errors, same or
   fewer warnings than baseline (currently 55).
2. `cd frontend && bun run build` — must succeed.
3. `git status --short` — must show changes ONLY in the
   allowed-files list. Anything in the forbidden list
   must be reverted before reporting done.
4. `git diff --stat` — should be reasonable in scope
   (target < 2500 lines changed across < 60 files; if
   larger, the worker has overreached).
5. `grep -rE "#[0-9a-fA-F]{3,8}" frontend/src/lib/components/`
   should return 0 new hex literals in CSS (existing
   unchanged files are fine).
6. `grep -rE "rgba\([0-9]+, ?[0-9]+, ?[0-9]+" frontend/src/lib/components/`
   should return only pre-existing results; no new
   raw rgba() color literals.

## Reporting

OpenCode must produce a `UI_POLISH_PASS_2026-06-16.md` at the
repo root with:
- Concrete before/after for each P0 fix
- A list of every file changed with one-line summary
- Verification command output (paste, don't summarize)
- An honest "what I did not do and why" section
- A "what I'd do next pass" section with 3–5 ideas

Be honest about what is build-verified vs visually verified.
OpenCode cannot run a browser; flag visual review as
"needs human eyes" explicitly. Do not claim "production-ready"
or "fully polished" — claim what is actually true: "passed
build, type-check, and grep audits; visual review pending."
