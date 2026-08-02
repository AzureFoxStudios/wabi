# Wabi Showcase Prep — Master Plan (rev. 7, FINAL)

**Date:** 2026-08-01
**Owner:** Ronin (product) / Hermes (Grok 4.5 MOA captain + verification) / opencode workers (implementation)
**Status:** Locked scope. Dispatch-ready wave/card list for the showcase push.
**Living kanban:** `docs/showcase-prep-kanban.md` (checkboxes + progress log — tick there as cards land)

## Locked decisions

- **Code editor:** CodeMirror 6 (MIT, community, ~300KB) for the in-app Lore editor — desktop build only; the web gets previews only.
- **External tooling:** People connect their own editors/tools to the Lore repo via CLI/SDK + access token (Connect panel). No git-protocol bridge.
- **Scope:** No cuts — all waves are in scope. Steam addon and native mobile are post-polish backlog.
- **Lore north star:** "allowing people to work together infinitely easier" — multi-client presence, locks, live file broadcasts, shared repo.
- **Addon boundary:** Lore and code tools live in the add-on system only. Non-coders must never be forced into coding tools.

## Baseline gate (every worker, before and after work)

- Run from `/var/home/Ronin/wabi`:
  - `bun run dev:local` (local stack: frontend `:5173`, backend `:3001`)
- From `frontend/`:
  - `bun run check` (svelte-kit sync && svelte-check)
  - `bun run build` (vite build)
- From repo root:
  - `cargo check --workspace`
  - `cargo test -p wabi-server`
- UI/CSS changes are platform-agnostic; Tauri build only needed when `src-tauri/` or build config changes.
- **Headless Chromium crashes on Wabi** — UI must be verified in a real browser/Tauri window by Ronin. Do not claim UI success on headless checks alone.
- Never commit `data/` runtime noise (`data/jwt_secret`, admin branding changes) or `docs/wabi-carl-watch.md`.

---

## WAVE 0 — Addon system coherence (foundation; gates W1 and W6)

The addon system is currently incoherent: only backend Rust addons (`core/addons/{lore,mesh,webhooks,persistence-disk}`, compile-time Cargo features) actually work. The Node-runtime source addons (`.wabip`/`.wabi-plugin` packages under `addons/packages/`), the frontend Svelte addon runtime, and the runtime `plugins/` install path are divergent/dead. The server has NO `/api/addons` or `/api/plugins` route at all (only `/addons/lore`), so frontend capability detection silently 404s.

- **A1 — One canonical manifest.** Backend addon = Rust crate behind a Cargo feature, with a single unified `plugin.json` schema (id, version, description, backend{runtime:rust, path}, frontend contributions, permissions). Align `core/addons/lore|mesh|webhooks` to it.
- **A2 — Server capability endpoint.** Add `GET /api/addons` returning enabled addons + their frontend extension manifest. Single source of truth. Kill the `/api/plugins` (`frontend/src/lib/addonInventory.ts:48`) vs `/api/addons/{id}` (`frontend/src/lib/addons/loader.ts:248`) divergence — unify on one endpoint.
- **A3 — Frontend capability plumbing.** Wire `hasAddonCapability()` (`addonInventory.ts:70`) to the new endpoint + the static bundled allowlist (`BUNDLED_ADDON_LOADERS`, `loader.ts:21`). Addon frontend contribution (channel types, settings pages, workspace panels) only via **static bundled import maps** — never remote `import(manifest.frontendEntry)`.
- **A4 — Fix the Addons settings UI.** `AddonSettingsTab.svelte` globs nonexistent `./plugins/*.svelte` and POSTs to a nonexistent install route. Replace with a real "Addons" page listing backend-enabled addons + status. Remove runtime-install UI or wire it properly.
- **A5 — Delete the dead Node layer.** Remove/archive `.wabip`/`.wabi-plugin` packages + the Node-backend addon story (`addons/source/`). Reconcile manifest-schema divergence.
- **A6 — Lore stays an add-on.** Keep `wabi-lore` feature-gated. Server auto-provisions a Lore repo only when the addon is on; frontend shows Asset Storage create option / channel type **only when `hasAddonCapability('lore')`** → non-coders never see any of it.

**Verify:** `cargo build --features addons -p wabi-server`; `GET /api/addons` returns lore; `bun run check`.

## WAVE 1 — Lore reachable end-to-end (add-on gated)

`LoreChannel.svelte` (1737 lines) is complete but unreachable end-to-end. Card list:

- **L1 — Channel kind.** `core/crates/wabidb/src/domain/mod.rs` has no `Lore` `ChannelKind`; `asset_storage` isn't serialized into `ChannelResponse` (`core/crates/wabi-server/src/api/channels.rs:28,52-62`). Add `Lore` kind (or serialize `asset_storage` as `channel_type:"lore"`) + create/list mapping.
- **L2 — Create + sidebar.** "Asset Storage" create option in `frontend/src/lib/components/sidebar/CreateChannelForm.svelte`; `asset_storage` in `frontend/src/lib/api/channels.ts` + `channelStore.createChannel`; "Asset Storage" section in `frontend/src/lib/components/ChannelSidebar.svelte`; ensure `Chat.svelte:449` `currentChannelType==='lore'` branch fires.
- **L3 — URL prefix fix.** `frontend/src/lib/api/lore.ts` + `LoreChannel.svelte` build `${getApiBase()}/addons/lore…` — server serves `/api/addons/lore/…` → 404. Add `/api` prefix.
- **L4 — ID parsing.** `loreStore.ts:43` / `LoreChannel.svelte:187` parse `ch_(\d+)` (decimal); server parses hex. Align.
- **L5 — Auth'd media previews.** `download_file` requires bearer header; raw `<img>/<video>` in `LoreChannel` can't send it → 401. Add authenticated preview (short-lived signed URL or cookie/session).
- **L6 — Tokenize styles.** `LoreChannel.svelte` scoped styles (881–1737) use legacy hex + raw z-index 2000/2001 → semantic tokens (satisfies polish Pass 1).
- **L7 — Auth'd web downloads w/ permission.** Uploads already download via capability URLs (`/uploads/*`). Lore downloads need cookie/signed-URL path + channel-membership gate so authorized users can download from the web.
- **L8 — Role-based editing.** All lore routes already use `AuthUser`. Add Wabi-role gates on **write** ops (upload, commit, branch create/merge, lock/unlock, snapshot, delete): Owner/Admin/Developer edit; **Artist = asset-write only (see W6g)**; Viewer read-only. Frontend gates the Edit/Commit UI by role.

## WAVE 2 — Math (KaTeX in chat)

No math rendering exists anywhere. `parseMessage()` in `frontend/src/lib/markdown.ts` is the single funnel (used by chat, DMs, notes, wiki, reader).

- **M1** Add `katex` dependency. In `markdown.ts`, extract `$…$`/`$$…$$`/`\(…\)`/`\[…\]`/`\begin{env}` **before** `marked`, render each via KaTeX, and re-inject the KaTeX HTML **after** DOMPurify sanitization (so the sanitizer allowlist doesn't strip it). Load KaTeX CSS beside `frontend/src/lib/prism-theme.css`. Keep the strict DOMPurify config for everything else.

## WAVE 3 — Channels: navigation + linking

- **C1 — Clickable `#channel` mentions** in chat → `switchChannel` (parser + resolver in `markdown.ts` / `navigateToRef.ts`).
- **C2 — Complete `navigateToRef` branches.** `frontend/src/lib/navigateToRef.ts` has "surface UI pending" for forum post / wiki page / gallery work — wire them to open the actual surfaces.
- **C3 — Sidebar/section navigation robustness** across text/voice/gallery/forum/wiki/asset-storage grouping + switching.

## WAVE 4 — Calling

Voice channels (join/leave/listen/transmit), DM/group call signaling, and screenshare are mostly wired. Remaining:

- **V1 — Two-client smoke test** of voice channel join/listen, DM call, group call; fix what breaks. Note direct DM calls are P2P (STUN-only unless TURN) — verify `direct_call_turn_unconfigured` notice path (`CallModal.svelte:263`).
- **V2 — Screenshare** across P2P + LiveKit; fix `screen-share-targets` roster population if shares don't reach everyone (`callingScreenShare.ts`).
- **V3 — Calling-debug showcase.** Promote `frontend/src/lib/callingDiagnostics.ts` (`RTCPeerConnection.getStats()` → ping/jitter/loss/bitrate) into a proper shareable debug panel (today only inline: `MainLayout.svelte:1001`, `VoiceUserCard.svelte:81-92`, `CallView.svelte:348-378`).
- **V4 — Multi-call UI.** State is single-call (`callingStateStores.ts`: one `callMode`, one `activeVoiceChannel`). Extend so a DM/group call + a primary voice channel can be active simultaneously; keep TeamSpeak-style listen-only channels. Also remove the `livekitSfu.ts` no-op stub re-exported via `calling.ts:113-117`.
- **V5 — Backend stubs.** `move-user-to-voice-channel` + breakout rooms are stubs (`core/crates/wabi-server/src/socketio/breakout_ops.rs:5-24`) — implement or disable the UI entry points so they don't silently fail.

## WAVE 5 — Notes 3-layer system

- **N1 — Layer 1 (corner/quick).** `QuickScratchpad.svelte` is dead code (0 importers); `notesStore.ts` scratchpad helpers are orphaned. Mount it (corner/bottom-right mini pad) + global hotkey/slash command.
- **N2 — Layer 2 (right panel).** `WorkspacePanelHost.svelte:27-28` renders `DMTab` for the `notes` panel (shows DM list, not notes). Render real notes (`KeepNotesView`/`NotesWorkspace compact`); fix the compact grid overflow bug (`NotesWorkspace.svelte` ~393-397/705-730); drop the fake-`NOTES_DM_ID` hack (`layoutStore.ts:193-198`).
- **N3 — Layer 3 (center stage).** No notes branch in `MainLayout.svelte:894-931`. Add a notes addon-tab + `NotesCenterView` (markdown toolbar, live preview, note-list sidebar, tags/organize — per `frontend/src/PLAN_wabi_frontend_fixes.md:105-131`).
- **N4 — Kill the bottom-right fast-swap.** `RightPanel.svelte:124` dblclick cycle + auto-heal at `:41` still thrash notes↔dms↔users (claimed fixed in D2/D3, still in source).

## WAVE 6 — Lore collaborative workspace (add-on; native edits / web previews)

- **W6a — Lore server as compose profile.** Ship the Lore server (sidecar) co-located with wabi-server, exposed on a reachable port; `[addons.lore] mode="sidecar"`, `server_url` wired. (`LoreAddonConfig`, `core/crates/wabi-server/src/config.rs:67-100`.)
- **W6b — External-tool Connect panel.** Per-repo server URL + repo id + access token + CLI/SDK setup snippets (Lore ships C/C++/C#/Rust/Go/Python/JS APIs). People use their own editors if they need.
- **W6c — CodeMirror 6 editor, desktop-only.** Bundled into the Tauri build (via `scripts/build-tauri.mjs` / build split); web build gets preview-only file view (existing Prism highlighting), no editor.
- **W6d — Native (Tauri) Rust bridge.** File IO, commit/branch/lock, token minting via `core/addons/lore/backend/src/lib.rs`.
- **W6e — Multi-client presence + live broadcasts.** Socket.IO "who's viewing/editing which file", Lore lock events surfaced in a collaborators list, commit/update broadcasts so viewers see file changes live. **This is the core "work together infinitely easier" deliverable.**
- **W6f — Working branch switcher + history.** Branch select is decorative today (no branch param in `api/lore.ts` or backend). Add real branch switching + a visual history/diff timeline (mirror `WikiChannel`/`WikiPageTree`). `lore_commits` projection exists (`core/crates/wabidb/src/projections/lore.rs`).
- **W6g — Artist track.** Asset upload/download/replace + lock, image/video/audio/PDF previews, grid thumbnails, folder organization — no editor, no code, no branch/commit demands. Optional 3D-model preview via the model-viewer addon.

## WAVE 7 — Recording (properly coded + Lore upload)

Architecture is sound: `callRecording.ts` is Lore-agnostic → `uploadRecordingToLore` → `loreRecording.ts` → POST `/api/addons/lore/recordings` (backend `upload_recording` resolves the "Recordings" channel, requires asset-storage + repo, writes to `recordings/{filename}`, records a `lore_commit`). `CallRecordingPanel.svelte` renders `loreUploadStatus` states.

- **REC1 — End-to-end verify.** Voice + channel call recording: mixed + stems (`AudioSettingsTab.svelte:203` stem modes), save, panel UI, recording-icon + local-hide setting (website-finish DoD 16).
- **REC2 — Fix Tauri desktop save.** `frontend/src/lib/tauri-recording.ts:18` invokes `save_call_recording` but no Rust command exists — register it in `src-tauri` or remove the dead invoke.
- **REC3 — Verify Lore upload path.** "Recordings" channel provisioning, health guard (`loreRecording.ts`), upload, and resulting history visible in the lore channel. Two-client smoke test.

## WAVE 8 — Business → proper "Planning" channel view

Full business suite exists (`PlannerWorkspace.svelte`, `KanbanBoard`, `GanttChart`, `CalendarImpl`, `DiaryView`, `ProjectsView`, `ProjectDetail`, `SprintModal`, `TodoTaskModal`, `TaskPanel`); `/business` route redirects to the Planner. But `channelTypes.ts` `RoutedChannelType` has no planning type — business is a page, not a channel view.

- **BZ1 — Channel type.** Add `planning` to `RoutedChannelType` (`frontend/src/lib/channelTypes.ts:3`) + label/icon (`getChannelTypeLabel`/`getChannelTypeIcon`).
- **BZ2 — Backend + create.** Backend `ChannelKind` mapping; "Planning" create option in `CreateChannelForm.svelte`; sidebar section in `ChannelSidebar.svelte`.
- **BZ3 — Route to surface.** Render `PlannerWorkspace`/`BusinessSurface` when `currentChannelType === 'planning'` (mirror forum/gallery/wiki routing in `Chat.svelte`/`MainLayout.svelte`); channel-scoped projects/boards.
- **BZ4 — Verify views + perms.** Kanban/burndown/gantt/calendar accessible from the channel; permission gating.
- Reference: `docs/plans/2026-07-28-business-into-main.md`.

## WAVE 9 — Profiles & banner overlays

Today: `UserPopoutImpl.svelte` has a color-only "banner" (`--pfp-banner`), bio links, roles, status, message/voice/video actions, local notes. `ProfileSettingsTab.svelte` has avatar upload + username + status. No banner image, no overlay, no full profile surface.

- **PR1 — Banner image upload** + ownership registry (`/uploads`, like avatars); replaces the color-only `popout-banner`/`profile-hero-banner`.
- **PR2 — Transparent overlay layer above the profile picture.** Users set a PNG overlay (frames/banners around the avatar) rendered as a positioned layer over avatars in messages, popouts, server rail, member list.
- **PR3 — On/off controls.** Per-user toggle for their own overlay + a **global setting to disable all banner overlays** (the "people hate banners" option).
- **PR4 — Profile overhaul.** Full profile surface (banner + overlay + bio + roles + status/activity + joined + notes + quick actions: message/voice/video/mention/copy-id/share), richer popout, self-profile editing, and close the interaction gaps Ronin flagged ("lack of profile interaction").

## WAVE 10 — Visual polish (web + Tauri + mobile)

- **P1 — AGENTS.md Passes 0–5.** `frontend/AGENTS.md` is the authoritative reference (0 of 5 passes started): re-home `--text-*` from dead `src/app.css` into `tokens.css`; define ~15 undefined tokens; re-tokenize DM surfaces/admin-center-stage; z-index reconciliation; a11y (aria-labels, dialog roles, `100vh→100dvh` at `reader-tab.css:484`, `user-popout.css:4/92`, `call-view.css:6`); delete 9 dead sheets + orphaned `ServerRail.css`/`StorageSettings.css`; taste pass.
- **P2 — Tauri desktop.** Frameless + `decorations:false` window has no drag region/titlebar → add titlebar + min/max/close (via `lib/tauri-window.ts`); remove the debug-cube window (`src-tauri/src/lib.rs:12-26` + `/tmp/viewer-debug.log`); reconcile `main.rs` vs `lib.rs` builders; register or delete the 12+ dangling commands (`tauri-storage.ts`, `tauri-media.ts`, `tauri-recording.ts`); add ACL grants (`src-tauri/capabilities/default.json` — notification/dialog/shell/fs); fill or remove empty tray "About".
- **P3 — Mobile responsive polish.** Consolidate ~28×`768px` + scattered breakpoints; fix under-discoverable auto-hiding bottom nav (`MOBILE_NAV_IDLE_HIDE_MS`); overlay sheets; hardcoded z-indexes; `100dvh`.
- **P4 — Native mobile (deferred).** `tauri android/ios init` — separate track, needs toolchains/emulators. No `Android/` dir today; `frontend/src-tauri/` is stale/gitignored.

## WAVE 11 — Branding (login/launch per-community)

Launch-page branding exists (`/api/public/launch-page` from `admin_policies.json` → `LaunchPanel.svelte`; admin panel `FrontendMetadataPanel.svelte`). Richer profile system is only a plan (`docs/sabi-branding-plan.md`).

- **B1 — Audit brandability.** Everything that still says "Wabi": window title, favicon, app name in UI, login footer, about/tray, loading strings.
- **B2 — Branding-profile contract + admin UI.** brand name, logo/banner, palette, headline/sub, footer, custom CSS, boot sequence.
- **B3 — Strip-Wabi option.** Clean, non-branded default so communities go fully neutral or fully custom.
- **B4 — Prettier default launch/login** as the showcase face.

## WAVE 12 — Post-polish backlog (deferred, not cut)

- **Steam addon** — rich-presence "currently playing" badge, `steam://run`/lobby join links, opt-in game status (see `docs/steam-integration-proposal.md`; note: Valve exposes no overlay APIs). **After** minimum polish.
- **Native mobile** (tauri android/ios) — separate track.
- **3D/asset preview polish** (model-viewer addon).

## WAVE 13 — Stretch: Bot platform + Hermes as one bot (after W0–W11 green)

**Design:** `docs/hermes-bot-platform-design.md`. **Kanban:** H0 done; H1a identity+token, H1b delivery, H1c Hermes-as-normal-bot.

Locked: bot account + token + scopes; language-agnostic HTTP (not Python-only); never user-impersonation; bots call the same admin tools humans use; auto-ban requires reason + audit; no silent DMs. Today: no `is_bot`, webhook delivery is log-only stub. Balloon → W12 S4/S5. Not a showcase blocker.

---

## Dispatch protocol (per card)

1. One bounded card per dispatch to an opencode worker (model: `opencode/deepseek-v4-flash-free`, or per current worker model policy).
2. Worker exits → Hermes verifies independently: git status vs pre-dispatch baseline, targeted diffs, `bun run check` (fresh), cargo tests where touched.
3. Scope-drift check against the card, not filename grep.
4. Green → next card. Red → re-dispatch with the failure written into the prompt's CRITICAL INTERFACE NOTES.
5. Never edit worker files mid-flight. Never trust worker self-report.
6. **Post-burn audit (mandatory):** all cards green ≠ ship-ready. Second-opinion model audit reads paths end-to-end; verify every claim against source.
7. **Final gate:** full build → deploy → Ronin verifies in a real browser (headless cannot render Wabi).
8. Update `docs/showcase-prep-kanban.md` checkboxes + progress log as cards land (this plan stays the design source of truth; the kanban is the living board).

## Progress log

- Living log: `docs/showcase-prep-kanban.md` (empty — first dispatch pending)
