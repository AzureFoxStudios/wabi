# Wabi Handoff — Forums, Server Identity, Channel-Switch Fix

## Purpose
Hand off the in-progress Wabi UX work: **what is already implemented and verified** (do not redo), **what remains**, and the **intent behind every remaining item** so a fresh agent can execute without re-deriving context. Repo: `/var/home/Ronin/wabi`.

## How to verify work
- Frontend typecheck (from `frontend/`): `bun run check`
- Backend (from `core/`): `cargo check -p wabi-server`
- Web build: `bun run build` (from `frontend/`)
- UI changes are platform-agnostic; **do not** touch `src-tauri/` or `lib/tauri-*.ts`. The theme is dark nebula, tokens in `src/styles/tokens.css` — prefer semantic tokens over hex/raw values.
- Visual checks happen in a real browser/Tauri window (headless Chromium crashes on Wabi).

## Current state: uncommitted working tree
`git status` shows 16 modified files + untracked. **Nothing is committed yet.** If you are asked to commit, include exactly these tracked files:

**Modified (this work):**
- `core/crates/wabi-server/src/api/admin.rs` — added `tagline` field to `FrontendAppMetadataPolicy` + Default
- `core/crates/wabi-server/src/api/public.rs` — rewrote both public endpoints to serve stored policy
- `frontend/src/lib/forumStore.ts` — new store helpers + default-category change
- `frontend/src/lib/components/ForumChannel.svelte`, `ForumComposer.svelte` — category UI
- `frontend/src/styles/components/forum.css` — category-row/add/rename + composer styles
- `frontend/src/lib/components/ChannelSidebar.svelte`, `FollowingFeed.svelte`, `ModeTabsDrawer.svelte`, `modeTabsDrawerState.ts`, `routes/business/businessPageHelpers.ts` — switch/join bug
- `frontend/src/lib/components/AdminWorkspace.svelte`, `admin/AdminHeader.svelte`, `admin/FrontendMetadataPanel.svelte`, `styles/components/admin-tab.css`, `styles/components/sidebar-core-part1.css` — server identity + tagline
- `frontend/src/styles/components/admin-center-stage.css` — theme-reactive CSS pass (see Done §4)
- `frontend/src/lib/theme/themeManager.ts` — removed self-referencing RGB aliases (see Done §4)

**Untracked (context, do not delete/copy):** `data/admin_policies.json` (runtime config the new public endpoints read), `audit/*` prompt/report files, `docs/wabi-carl-watch.md`, `data/jwt_secret`. These predate this work.

## Done — implemented & verified (desktop + web)

### 1. Channel-switching bug (the original blocker)
`joinChannel()` was called where `switchChannel()` was intended, so opening a channel appended/duplicated instead of swapping the active view.
- `ChannelSidebar.svelte` `handleChannelClick` → `switchChannel(id)`; same fix in `FollowingFeed.svelte` (openChannel), `ModeTabsDrawer.svelte` (selectChannel from queue), `modeTabsDrawerState.ts`, `routes/business/businessPageHelpers.ts`. Removed now-unused `joinChannel` imports.

### 2. Server identity header (icon/banner/name/tagline)
Root cause: the public endpoints `/api/public/frontend-app-metadata` and `/api/public/launch-page` served **hardcoded** shapes instead of the stored admin policy.
- **Backend:** `admin.rs` gained `tagline`; `public.rs` now loads `data/admin_policies.json`, sets `enabled:false` + legacy fields from stored policy, returns policy data.
- **Sidebar:** `ChannelSidebar.svelte` renders `effectiveTagline` under the server name (non-compact) via `.server-tagline` in `sidebar-core-part1.css`.
- **Admin:** `AdminHeader.svelte` takes `serverName`/`serverTagline` props and renders an identity block; `AdminWorkspace.svelte` passes `$currentSavedServer?.effectiveName` / `effectiveTagline`; `FrontendMetadataPanel.svelte` added a **Tagline** input and both `frontendMetadataMatches` copies (local + AdminWorkspace) now include tagline; styled in `admin-tab.css`.

### 3. Forum category system (thread-level categories, the big one)
Problem before: the composer never sent a category, so the Bug/Feature/Discussion defaults stayed empty and every thread fell into 'General'.
- **Store** (`forumStore.ts`): added `updateForumPost()` (PUT via existing backend `update_post` which accepts `category`, `title`, `tags`, `body`) and `renameForumCategory()` (loops affected threads, PUTs new category, reloads). `createThread()` already accepted `category` — it was just never called with one.
- **Composer** (`ForumComposer.svelte`): optional category input with a `<datalist>` of existing categories when `showTitle`; `onSubmit` signature is now `(body, title?, category?)`.
- **Category pane** (`ForumChannel.svelte`): dynamic category derivation (defaults first → persisted custom → categories present on threads); `+ Tag` button + inline input to add a category (persisted per-channel in `localStorage["wabi-forum-custom-categories:<channelId>"]`); pencil rename on each category row (inline input, Enter commits back to backend); 'General' added to `getDefaultCategories()` so existing threads surface; new CSS in `forum.css`.

### 4. CSS finalization — admin center now follows the chosen theme
Problem: admin surfaces stayed pinned to nebula-gray regardless of the active theme (theme switching is via `themeManager.ts` setting `--surface-*`/`--text-*`/`--accent-*` on `:root`).
- **`admin-center-stage.css`:** raw hex hardcodes → theme tokens (`#242424`→`--surface-raised` seg segments, `#272727`→`--border-subtle` ring bg, `#1a1a1a`→`--surface-sunken` role-bar track, `#1d1d1d`→`--border-subtle` dot bg, scrollbar `#333`/`#555`→ the app-standard `color-mix(accent-primary-color 24%, border-subtle 76%)`); undefined `--accent-red` → `--color-danger` (live dot/text); `.is-dragover` raw orange → theme accent.
- **Latent gradient bug fixed:** `--accent-primary` resolves to a *gradient* (buildTokens.ts:134), invalid in `color:`/`border-color:`. Admin's active nav item, accent cards, and dropzones were rendering transparent on every theme. Switched all `color`/`border-color`/`color-mix` usages to `--accent-primary-color` (solid hex via LEGACY_COLOR_MAP). Only backgrounds keep the gradient `--accent-primary`.
- **`themeManager.ts`:** removed 7 self-referencing RGB aliases in `SEMANTIC_MAP` (no-ops that pinned `--color-danger-rgb` etc. to static values); those RGB vars are now set per-theme from `ThemeColors.*Rgb` in step 1, so soft-status tokens (`--accent-danger-soft`, `--accent-info-soft`, `--accent-warning-soft`, `rgba(var(--color-danger-rgb))` usages) follow the theme.

**Verified:** `bun run check` passes with zero errors/warnings in all touched files; `cargo check -p wabi-server` clean (pre-existing warnings only).

## Remaining work — the actual handoff list
Each item: **Intent** (why it matters) → Task → Acceptance criteria.

### A. Forum "+" placement — finish the layout intent
> **Intent:** Two symmetric `+` buttons, one in each column: Categories column's `+` adds a **category**, Threads column's `+` starts a **new thread**. Right now both `+` and `+ Tag` sit in the Categories header (button in the category column header), so the thread column feels like the dead second place.
- Move the New Thread `+` (currently in the Categories header next to `+ Tag`) into the Threads column: add a `.forum-post-list-header` (CSS class already exists at `forum.css` ~line 111) with a `Threads` label (or the active category name when one is filtered) and the `+` button → `handleNewThread`, gated on `canCurrentUserPost`.
- Restyle `+ Tag` to a bare `+` (28px circle matching `.forum-new-thread-btn`), `title="Add category"`, so the two columns read as symmetric plus buttons with tooltips.
- Acceptance: screenshot shows one round `+` in each column header; add-category inline input and rename pencil still work; `bun run check` clean.

### B. Profile access — open your own profile
> **Intent:** There is currently no visible way for a user to open their *own* profile (others' profiles work via avatar click — a prior commit noted `openProfilePopout` is dispatched on avatar click). Users can't see their own presence/member card.
- Find where own-avatar/profile entry points should live (user menu, rail avatar, DM header). Wire the same profile-popout/show self-profile as non-self profiles, or add a dedicated self entry in the user menu and/or rail avatar click.
- Acceptance: user can open own profile from at least one obvious entry point; it reuses the existing profile popout/detail component.

### C. Mention/popout UX cleanup
> **Intent:** Make the mention/user-popout surface friendlier and less noisy: mentions should be quick to copy, and the popout should carry the actions a user actually wants instead of the current experimental affordances.
- Click a mention → copy the username (with copied feedback).
- Remove the color-status decoration and the "copy user id" affordance (too dev-y).
- Add mute/deafen and settings buttons to the user popout; add a "share profile" action on the profile view.
- Acceptance: no dead affordances remain on the popout; copy feedback visible; new buttons trigger real actions (mute/deafen paths exist; settings opens existing settings modal).

### D. Admin overhaul — remainder
> **Intent:** The admin center should match the app's nebula design language (AGENTS.md audit point 5). The CSS finalization pass (Done §4) already made the admin surface theme-reactive and fixed the gradient-in-border bugs; what remains is the broader taste pass.
- Re-token any remaining surfaces/fonts drifting from `tokens.css`; keep everything on semantic tokens (no raw hex, no undefined `--accent-*` tokens).
- Acceptance: admin screens look consistent both with the rest of the app AND across all 8 themes; no regressions in admin CRUD flows; typecheck clean.

### E. New-server join scaffolding — decision pending
> **Intent:** Joining a new server is currently thin/confusing (likely just a URL/password field with no guided flow). There was a half-idea about password autofill that was considered too "SaaS-y".
- First decide the UX: dedicated join flow (server address → password → roles preview → join) vs. keeping it inline. Then implement.
- Acceptance: a new user can join a server end-to-end from an empty/list state without guessing; the flow reflects the chosen design.

### F. CF beacon error on wabi.chat — report to user
> **Intent:** A client-side error around Cloudflare Web Analytics (`static.cloudflareinsights.com` beacon; CORS/SRI-hash complaint). This is edge-injected, not app code — the app needs neither a fix nor a runtime change.
- Confirm the CSP already allows `static.cloudflareinsights.com`. If yes: tell the maintainer it's cosmetic (likely ad-blocker/browser variance on edge-inlined scripts) and offer to disable Web Analytics as the only real "fix".
- Acceptance: documented decision (keep/disable) in a code comment or issue; no app-code change unless maintainer opts to disable analytics.

## Gotchas / constraints
- **Pre-existing, not yours:** 6 `bun:test`/`bun` module-resolution errors from the frontend check, and an `AudioRecorder.svelte` esbuild transform failure. Do not "fix" these unless separately asked.
- **Production rebuild needed for #2:** the deployed wabi.chat server still serves the old hardcoded public metadata — this work only takes effect after the backend is rebuilt/redeployed.
- **Design:** single source of truth `src/styles/tokens.css`; legacy block wins for colors/z-index — preserve current resolved colors. Do not add emojis. No comments unless the task asks.
- **Git:** do not commit/amend/push unless explicitly told which files.
