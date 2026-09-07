# Wabi Frontend — Polish Plan & Reference

Frontend for Wabi. Svelte 5 + SvelteKit + plain CSS. Ships as both a web build and a **Tauri desktop app** (repository-root `src-tauri/`, i.e. `../src-tauri/` from here). This file is the durable reference for the full-site visual polish pass — read it instead of re-deriving.

## Verification (run from `/var/home/Ronin/wabi/frontend`)

- Typecheck: `bun run check` — `svelte-kit sync && svelte-check`
- Web build for the server: `bun run build:static` (adapter-static; required for Rust embed)
- Tauri build: `bun run build:tauri` — runs `scripts/build-tauri.mjs` (vite build with `TAURI_ENV_PLATFORM` set). Alias for full native bundle: `bun run tauri-build` (needs Rust + system deps, e.g. webkit2gtk on Linux; run on the target OS, not cross-compiled).
- Headless Chromium crashes on Wabi — visual checks happen in a real browser / Tauri window by the user.
- Audio regression: `bun test src/lib`; `node scripts/audio-browser-smoke.mjs` launches an isolated **headful** synthetic media test under the root desktop CSP (no real microphone/speaker use). It does not substitute for two-device or native-webview verification. See `../docs/plans/2026-09-06-audio-flow-integrity.md`.
- UI/CSS changes are platform-agnostic. Typecheck + web build cover UI work; Tauri build is only needed when build config or `src-tauri/` changes. Tauri code paths are `src-tauri/` and `lib/tauri-*.ts` — they use the same design tokens, don't break them.

## Design language

Dark cosmic/nebula theme. Single source of truth: `src/styles/tokens.css`.
- Surfaces: `--surface-app #1a1a2e`, `--surface-base #24243e`, `--surface-raised #302b63`, `--surface-sunken #0f0c29`
- Accent: `--accent-primary #6366f1`, `--accent-secondary #818cf8`
- Text: `--text-heading #e0e0ff`, `--text-secondary #b3b3ff`, `--text-muted #9999ff`
- `--font-sans` / `--font-mono`, `--radius-{sm,md,lg,xl,2xl,full}` (4/8/12/16/24/9999), `--space-*` (4px base), `--z-*` scale, `--duration-*`, `--ease-*`.

IMPORTANT: tokens.css defines BOTH semantic tokens and a later "Legacy" block. The legacy block WINS for colors and z-index (defined later in the same `:root`). Preserve current resolved behavior — do not let a refactor change rendered colors or stacking order.

## Audit findings (full-site audit, 2026-07)

1. `src/app.css` is DEAD — nothing imports it — but it's the ONLY source of `--text-xs/sm/base/lg/xl`, referenced by 70+ live rules. Those font-size rules are invalid at runtime. Fix: re-home the `--text-*` size tokens into `tokens.css` (or import app.css from `styles.css`).
2. tokens.css has two conflicting scales in one `:root`: semantic z-index (183–194) and colors (105–112) are overridden by the legacy block (291–309 / 268–274). Semantic block is dead weight.
3. Undefined tokens referenced at runtime (silently no-op: no hover, no shadow, transparent badges): `--accent-color`, `--color-info-hover`, `--color-success-hover`, `--color-danger-hover`, `--color-warning-hover`, `--modal-text-secondary`, `--modal-text-muted`, `--pinned-*`, `--color-glass-black-25`, `--accent-blue/green/purple/red`. Define in tokens.css or replace usages with `color-mix(in srgb, …)`.
4. Legacy color namespace still in use: `DMTab.svelte`, `DMMessageView.svelte`, `DmHub.svelte`, `FollowingFeed.svelte`, `LoreChannel.svelte` (scoped 847–1040). Migrate to semantic tokens.
5. `admin-center-stage.css` uses `Space Grotesk`/`Space Mono` fonts + raw blue/red/yellow accents that clash with the indigo theme.
6. Dead CSS in `styles/components/` (unimported): `buttons.css`, `inputs.css`, `badges.css`, `cards.css`, `content.css`, `tooltips.css`, `status-system.css`, `panels.css`, `polish.css` (the components/ copy; `styles/polish.css` is the live one). Also 4 served `.bak` files: `chat-core.css.bak-1783504337`, `ml-core.css.bak-1783504192`, `ml-core.css.bak2-1783504337`, `ml-replies.css.bak-chat-fix-1783504674`.
7. Duplicate component CSS pairs (co-located vs `styles/components/`): `lib/components/ServerRail.css` vs `server-rail.css`; `lib/components/StorageSettings.css` vs `storage-settings.css`. `BaseModal.svelte` scoped modal styles duplicate `settings-shell.css`.
8. Off-scale radii (6/10/14/22px) in chat-search, UserListTabImpl, DMTab, DMMessageView. `ml-core.css` duplicates `.message`/avatar/hover/spacer rules (density override vs base).
9. Hardcoded z-index (should be `--z-*` tokens): `ml-actions.css:18` (80), `chat-composer.css` (10/25/20), `chat-upload.css:172` (999), `ModeTabsDrawer.css` (1999/2000), `windowing.css` (1100/1099), `reader-tab.css:582` (12000), `LoreChannel.svelte` (2000/2001), `CommandPalette.svelte` (100).
10. `100vh` stragglers (use `100dvh`): `reader-tab.css:484`, `user-popout.css:4/92`, `call-view.css:6`.
11. a11y gaps: icon-only close buttons without `aria-label` in `CreateDMModal.svelte:63`, `CreateGroupModal.svelte:67`; `Settings.svelte:268/280` and `PinnedMessagesModal.svelte:72/84` use `role="button"` instead of `role="dialog"`+`aria-modal`; `IncomingCallModal`/`OutgoingCallModal` overlays missing dialog roles. `BaseModal.svelte` has the correct pattern to mirror.
12. Font-size drift: hardcoded 0.6–0.95rem in DMTab/DMMessageView/DmHub/FollowingFeed instead of `--font-size-*`.

## Polish plan (5 passes)

- **Pass 0 — Foundation:** re-home `--text-*` sizes into tokens.css; delete the dead semantic z-index/color blocks (PRESERVING current resolved colors); define the ~15 missing tokens.
- **Pass 1 — Re-tokenize surfaces:** `admin-center-stage.css` (drop Space Grotesk + raw accents), DM surfaces legacy→semantic, `LoreChannel.svelte` scoped styles, `login.css` band-aid block (937–975), sidebar-core hex, `BaseModal.svelte:93` neon border, off-scale radii, duplicate `ml-core` rules.
- **Pass 2 — z-index reconciliation:** replace raw values with `--z-*` tokens, preserving current stacking order.
- **Pass 3 — a11y + viewport:** aria-labels, dialog roles, `100vh`→`100dvh`.
- **Pass 4 — Dead CSS cleanup:** delete the 9 unimported sheets + 4 `.bak` files; dedupe the 2 co-located component CSS pairs.
- **Pass 5 — Taste pass:** per-area hover/focus, spacing, hierarchy; stop at each area's polished baseline.

## Token-efficiency practices (apply every session)

- Research with explore subagents — their file reads stay in isolated context; only the summary returns.
- Use grep/glob over whole-file reads.
- One focused diff per screen; verify with `bun run check`.
- Reference this file instead of re-deriving the audit.
