# Wabi Frontend — Design Reference

Frontend for Wabi. Svelte 5 + SvelteKit + plain CSS. Ships as both a web build and a **Tauri desktop app** (repository-root `src-tauri/`, i.e. `../src-tauri/` from here). This file is the durable reference for the UI redesign: read it instead of re-deriving. The design contract is `../docs/design/DESIGN_CONTRACT.md`.

## Verification (run from `/var/home/Ronin/wabi/frontend`)

- Typecheck: `bun run check` — `svelte-kit sync && svelte-check`. The known baseline is four `xlsx` type errors in `lib/workspaces/sheets/fileAdapter*.ts`; add no new ones.
- Web build for the server: `bun run build:static` (adapter-static; required for Rust embed). The minifier is esbuild; never switch it to terser.
- Tauri build: `bun run build:tauri` — runs `scripts/build-tauri.mjs` (vite build with `TAURI_ENV_PLATFORM` set). Alias for full native bundle: `bun run tauri-build` (needs Rust + system deps, e.g. webkit2gtk on Linux; run on the target OS, not cross-compiled).
- Headless Chromium crashes on Wabi. Headful Chromium under Xvfb renders the seeded `/showcase` route (dev server with `VITE_WABI_SHOWCASE=1`, plus `WABI_WORKSPACE_ADDONS=all` for the office add-ons; scenes and capture steps in DESIGN_CONTRACT.md §12), which is the way to capture UI states in every theme. Visual, media and native behavior still needs acceptance in a real browser or Tauri window.
- Audio regression: `bun test src/lib`; `node scripts/audio-browser-smoke.mjs` launches an isolated **headful** synthetic media test under the root desktop CSP (no real microphone/speaker use). It does not substitute for two-device or native-webview verification. See `../docs/plans/2026-09-06-audio-flow-integrity.md`.
- UI/CSS changes are platform-agnostic. Typecheck + web build cover UI work; Tauri build is only needed when build config or `src-tauri/` changes. Tauri code paths are `src-tauri/` and `lib/tauri-*.ts` — they use the same role tokens, don't break them.

## Design language

Sources of truth, in order: the code on the branch you are changing, then `../docs/design/DESIGN_CONTRACT.md` (every value, component, surface and exact wording), then the one-page `../docs/design/DESIGN_LANGUAGE.md`. Reference images are in `../docs/design/reference/`. The contract is the target and is being rolled out surface by surface (contract §14). Feature maturity comes from `../docs/PROJECT_STATUS.md`, never from a mockup.

**Thesis:** Wabi reads like a well-set book that a small community writes in together. The sidebar is the table of contents, center stage is the page, the companion panel is a margin note, the workspace tabs are folio words, and the colophon under the composer says who can read this. The default theme is **Wabi Ink**: warm ink and brushed gold on near-black charcoal (`--w-bg #101315`), with a vermilion seal for privacy, security and moderation.

- **Roles** (`src/lib/theme/roles.ts`, applied by `themeManager.applyTheme`). All 17 themes resolve to `--w-*` roles:
  - `--w-bg`, `--w-bg2`, `--w-raise`, `--w-sink` and `--w-lift` for surfaces.
  - `--w-text`, `--w-mute`, `--w-faint` and `--w-deco` for ink.
  - `--w-line` and `--w-line-strong` for rules and edges.
  - `--w-sig` for where you are, `--w-accent` (+ `-soft`, `--w-on-accent`) for state, and `--w-seal` (+ `-soft`) for who can read it.
  - `--w-online`, `--w-danger`, `--w-warn`, `--w-info` and `--w-ok` for status.
  - `--w-scrim` for backdrops.

  People's colors go through `identityInk(color, theme)` (`lib/theme/identity.ts` for components).
- **Character** (`src/styles/character.css`). `data-char` (`soft`, `ink`, `pixel` or `contrast`) and `data-mode` on `<html>` set the following:
  - `--w-rs`, the radius scale.
  - `--w-bw`, `--w-pill` and `--w-avr`.
  - `--w-shadow` for overlays and `--w-shadow-1` for objects in flow. `--w-shadow-1` is always a valid shadow, never `none`.

  Radii are `--radius-sm/inner/md/lg/xl` (4/6/8/12/16 × `--w-rs`).
- **Type** (`src/styles/typography.css`, `fonts.css`). Serif (Shippori Mincho) names places, sans (Zen Kaku Gothic New) carries voices and mono (IBM Plex Mono) counts. Styles are `--w-t-display` … `--w-t-micro`, with `.w-t-*` utility classes. Every size is `calc(Npx * var(--w-fs))`.
- **Tokens** (`src/styles/tokens.css`) hold spacing (`--space-*`), shell metrics (`--w-mast` 96, `--w-foot` 80, `--w-sb-w`, `--w-panel-w`, `--w-rail-w` 44, `--w-gutter`, `--w-measure`), motion (`--w-dur-1/2/3`, `--w-ease`) and the `--z-*` scale. The file ends with the **legacy bridge**: `--surface-*`, `--text-*`, `--accent-primary-*`, `--border-*` and similar names resolve to roles so that untouched legacy rules follow every theme. Never use them in new or touched rules.
- **Kit.**
  - `src/styles/controls-kit.css` holds controls: `.w-btn`, `.w-ibtn`, `.w-field`, `.w-select`, `.w-seg`, `.w-switch`, `.w-check`/`.w-radio`, `.w-tag`, `.w-tag--mat`, `.w-role`, `.w-seal`, `.w-badge`, `.w-count`, `.w-react`, `.w-srow` and `.w-disclosure`. It imports the next two sheets.
  - `kit-overlays.css` holds overlays and states: `.w-pop`, `.w-menu`, `.w-tool`, `.w-tip`, `.w-toast`, `.w-notice`, `.w-empty`, `.w-skel`, `.w-loadline`, `.w-dialog`, `.w-sheet` and `.w-scrim`.
  - `kit-prose.css` holds reading: `.w-prose`, `.w-dayrule`, `.w-newrule`, `.w-typing`, `.w-outline` and `.w-facts`.
  - Svelte wrappers live in `src/lib/components/ui/`. Glyphs come only from the `Icon` registry (`ui/icons.ts`): a 24 grid with stroke 1.75.
- **Layers** (`src/routes/+layout.svelte`), in order: `fonts.css` → `styles.css` (base, legacy sheets) → `character.css` → `typography.css` → `stream.css` → `shell.css` → `login-skin.css` → `controls-kit.css` → `stage-skin.css` → `settings-skin.css` → `admin-skin.css` → `modal-skin.css` → `panels-skin.css` → `desktop-shell.css`. Each surface has its own skin in `src/styles/surfaces/`, imported by the skin it was carved from. A surface package empties the legacy rules it replaces instead of adding override layers.
- **Boot shell** (`src/app.html`). It paints before any role exists, so its `--boot-*` values mirror the resolved Wabi Ink roles, or Daylight's when a light theme is saved.
  - **Server markers.** Keep `content="#101315" data-wabi-theme-color`, `data-wabi-brand-title` and the `data-wabi-favicon` href exactly as they are: the Rust server rewrites them at boot.
  - **Theme-color.** The meta ships as `#101315`. At boot a saved Daylight theme switches it to `#faf9f6`, but only while it still holds that default, so a server-stamped operator accent wins. It does not yet follow a runtime theme switch, because `themeManager.applyTheme` does not write it.
  - **Mark.** The default brand shows the masked ensō. An operator logo replaces it only once the logo has loaded. A custom brand without a usable logo shows its initial, and neutral branding shows the neutral chat mark.
  - **Motion.** Nothing loops: the gate-driven rail is the only progress indicator. The mark and the name stay in place when the stall and recover rows appear.

### Golden rules (contract §2, §5, §9)

1. **Rules, not boxes.** Hairlines (`--w-line` at `--w-bw`) separate regions. A box is earned only by an object you act on as a unit (attachment, task card, call card, dialog) or by a control edge (button, field, composer). Lanes, lists, panels and settings groups never get a border box.
2. **Two running rules.** The sidebar, stage and companion share one 96px masthead (row A 56 + row B 40), whose bottom hairline runs across every column at the same y. They also share one 80px footer band.
3. **Serif names places, sans carries voices, mono counts.** Sans uses 400/500/700, serif 400/600 and mono 400/500, never mono 600. The floor is 11px, except the 10px mono maturity tag, role word and small badge numerals. Every text size respects `--w-fs`.
4. **Ink on paper for action.** The primary button is a `--w-text` fill with a `--w-bg` label, at most one per view. An accent fill means state (switch on, range fill, selection), never "primary". A danger button stays outlined until hover. "Sign out" is never danger.
5. **Color is rationed and only from roles.**
   - `--w-sig` means you are here.
   - `--w-accent` means on or focused, and also marks links and the NEW rule.
   - `--w-seal` means who can read it (privacy, permissions, moderation). It is never used for selection, danger or decoration.
   - Identity ink means this person.
   - Decoration is never colored.
   - Use no raw hex, `rgba()` or named colors, and no legacy token names in new or touched rules. Use `color-mix()` of roles instead.
   - Project and event colors appear only as 6–8px dots or as an 18% tint into `--w-raise` with `--w-text` text.
6. **One selection grammar.**
   - A selected row is a `--w-raise` fill with a `--w-text` 500 label and a `--w-sig` glyph.
   - Hover is `color-mix(in srgb, var(--w-raise) 70%, transparent)`.
   - High Contrast adds an inset 1px `--w-line-strong` ring for both selection and hover.
   - The active tab has a 2px `--w-sig` underline on the masthead rule.
   - The selected segment is a paper key.
   - A selected card or theme gets a 2px `--w-accent` outline at a 3px offset, plus a check.
   - Never use left bars.
7. **Status is a mark plus a word.** Use a 6–7px dot or a 12–14px glyph next to a word. Never use a colored frame, stripe or bar. Away is a `--w-warn` dot, offline a hollow `--w-faint` ring and busy a `--w-danger` dot.
8. **Words over glyphs.** Workspace tabs, stubs and role marks (`ADMIN`) are words. Icons replace words only for universal verbs (search, close, more, attach, send, add). Put no text glyphs (⋯ ▲ ☆ ◇ ✕ +) and no emoji in chrome.
9. **Nothing moves under the pointer.** Hover changes color or fill, never size or position. Never use `transition: all` or infinite animations in chrome. Entrances use opacity plus a translate of 8px or less. Respect reduced motion: the system setting and `data-motion='reduce'`.
10. **Elevation has three planes.** The page has no shadow. Objects in flow sit on `--w-lift` with `--w-shadow-1`. Overlays (menus, popovers, dialogs, sheets, peeks) take `--w-shadow`. Small floating tools (hover toolbar, selection bubble) take a `--w-line-strong` edge and no shadow. Use no gradients, glows or frost on surfaces.
11. **Focus** is `outline: 2px solid var(--w-accent); outline-offset: 2px`. Inside menus, segmented controls, tab strips and scrollers the offset is inset. Fields get an accent border plus `--w-ring`. Never use a box-shadow focus ring.
12. **Truth is typography.** Privacy, locality and maturity words are fixed (contract §9). Each is said once per screen at its entry point and never shrinks to a bare glyph, phones included.
    - **Privacy** comes from `privacyStateFor` and `PrivacyBadge`. The only words are "Server-readable", "Server-readable by choice", "Encryption pending" and "Experimental encryption" ("Not independently verified.").
    - **Retention** is its own chip ("Kept 24 hours", "Live only · not saved") and never a privacy claim.
    - **Maturity** words are only `PREVIEW`, `OPTIONAL ADD-ON · PREVIEW` and `EXPERIMENTAL`. Office tools always carry `PREVIEW`: they are an integration candidate, not a deployed feature.
    - Member UI never says "Secure", "End-to-end encrypted", "E2EE", "verified", "operator-blind", "private" for retention, "Beta", "New" (as a feature badge) or "Coming soon".
13. **Designed for each width.** Phone is below 600, tablet 600–1249 and desktop 1250 and up. Stage-dependent layout uses `@container stage`. Targets are at least 44px under `(pointer: coarse)` and on phones. Avoid horizontal page scroll. Put no global `button`/`input` rules in mobile CSS.
14. **Real states.** Every async surface has loading (load line plus skeleton), empty and error states with their own words, shown where the action happened. Never show a raw `Error.message`. A failed list shows the error, never an empty state.
15. **Layout contract** (root `AGENTS.md`):
    - Channels anchor.
    - Center stage owns the task.
    - Stubs are additive.
    - The companion panel is optional. It pins only while the stage keeps 600px or more, and otherwise opens as a peek.
    - Hover, focus or right-click on a stub never swaps the pinned panel.

## Audit findings (full-site audit, 2026-07) — status October 2026

Item numbers are the original audit's. Each status was re-checked against the code; re-check again before relying on it.

Resolved:

1. ~~`src/app.css` dead but the only source of `--text-*`~~ — `app.css` is gone; `--text-xs…xl` live in `tokens.css` and follow `--w-fs`.
2. ~~Two conflicting scales in `tokens.css`~~ — merged. One `--z-*` scale; legacy color names are now the bridge to roles.
6. ~~Dead sheets in `styles/components/` and served `.bak` files~~ — deleted.
11. ~~a11y gaps in CreateDM/CreateGroup close buttons, Settings, PinnedMessages, Incoming/Outgoing call overlays~~ — labelled; dialogs use `role="dialog"` + `aria-modal`.

Partly resolved:

3. **Undefined tokens.** Every name the audit listed is now defined, or, for `--modal-text-muted`, no longer referenced; it is still undefined, so don't reintroduce it. `--accent-color`, `--pinned-*` and `--modal-text-secondary` resolve to roles. These are still raw literals that do not follow the theme:
   - `--accent-blue/green/purple/red`, which are hex, and `--color-glass-black-25`, which is `rgba`. Users: `settings-appearance.css`, `notesStore.ts` and `admin/ui/StatusDot.svelte`.
   - `--color-*-hover`, which mixes toward `#ffffff` with raw hex fallbacks.

   Don't reuse these names. Move their users to roles.
7. **Duplicates.**
   - `BaseModal.svelte` now renders the kit `.w-scrim` + `.w-dialog` frame, and the ServerRail pair is gone.
   - Still open: `lib/components/StorageSettings.css` is not imported. It is dead; `styles/components/storage-settings.css` is the live copy.
10. **`100vh` stragglers.** The listed ones (`reader-tab.css`, `user-popout.css`, `call-view.css`) are fixed, and most other uses now have a `100dvh` line after them. `:fullscreen` rules use `100vh` on purpose. Still bare `100vh`, with no `100dvh`:
    - `ModeTabsDrawer.css:50`
    - `EmojiPicker.svelte:553-554`
    - `ReportMessageDialog.svelte`, at `calc(100vh - 36px)`
    - `routes/business/businessPage.css:14`
    - `routes/business/+page.svelte:31`
    - the dev review routes `__annotated_review` and `__forum_review`
- **Old indigo brand** (foundation#19). Done:
  - This file and `docs/design/` describe the role system.
  - `app.html` boots on Wabi Ink `#101315`.
  - Scrollbars use `--w-line-strong` (`base.css`).

  Still indigo:
  - `static/manifest.webmanifest`: `background_color` and `theme_color` are both `#0D1024`.
  - `static/offline.html`: theme-color `#0f0c29`, indigo and sky radial gradients, an inverted logo and `font-weight: 650`.
  - The theme-color meta does not follow a runtime theme switch (see Boot shell above).

Still open. Fold each into the surface package that owns the file:

4. **Legacy color names and raw hex** in the DM and Lore surfaces: `DMTab.svelte`, `DMMessageView.svelte`, `DmHub.svelte`, `FollowingFeed.svelte` and `LoreChannel.svelte`. The bridge keeps them themed; move them to `--w-*` roles.
5. **`admin-center-stage.css`.** The Space Grotesk/Space Mono fonts are gone, but about 80 raw hex literals remain.
8. **Off-scale radii and the `ml-core` duplicate.**
   - Four radius literals remain in `UserListTabImpl.css` (6px and 10px). Use the `--radius-*` codemod (contract §4.4).
   - `styles/components/ml-core.css` still defines `.message` twice: the base rule at line 46, then a second unscoped "Cozy default" block at line 580 that overrides it. The density blocks after it use `!important`.
9. **Raw z-index.** `ModeTabsDrawer.css` still uses 1999/2000. The other listed files use `--z-*` tokens, or small local values inside their own stacking context.
12. **Font-size drift.** Hardcoded `rem` sizes remain:
    - `FollowingFeed.svelte`: six of them, 0.7–1.2rem.
    - `DmHub.svelte:570` (`.85rem`) and `:575` (`1.25rem`).

    Use `--w-t-*` tokens.

## Plan

The redesign waves in DESIGN_CONTRACT.md §14 supersede the 2026-07 five-pass polish plan:

- **Wave 0, foundation:** roles, tokens, kit, primitives, privacy state, layout guard, docs.
- **Wave 1, surfaces:** one package per surface.
- **Wave 2:** phone and tablet, beta and dev sweep, dead-code purge, legacy retirement.

No pass of the old plan is fully closed. The open and partly resolved items above are what remains of each pass. They fold into the wave packages that own those files:

| Old pass | Remaining items |
|---|---|
| Pass 0, foundation | item 3 (raw literals) |
| Pass 1, re-tokenize surfaces | items 4, 5, 8 and 12 |
| Pass 2, z-index | item 9 |
| Pass 3, a11y and viewport | item 10 |
| Pass 4, dead CSS | item 7 |
| Pass 5, taste | continues in the wave 1 surface packages |

## Token-efficiency practices (apply every session)

- Research with explore subagents — their file reads stay in isolated context; only the summary returns.
- Use grep/glob over whole-file reads.
- One focused diff per screen; verify with `bun run check`.
- Reference this file and the design contract instead of re-deriving the audit.
