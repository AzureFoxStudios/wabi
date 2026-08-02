# Showcase Prep — Kanban Board

**Plan (source of truth):** `docs/plans/2026-08-01-showcase-prep.md` (rev 7 FINAL)
**Mastermind:** `docs/grok-mastermind-prompt.md`
**Last updated:** 2026-08-01
**Status:** Locked scope. First dispatch pending.

## Locked decisions

- **Code editor:** CodeMirror 6 (MIT, ~300KB) — desktop/Tauri only; web = previews
- **External tooling:** CLI/SDK + access token via Connect panel — no git-protocol bridge
- **Scope:** No cuts — all waves in scope. Steam + native mobile = post-polish backlog
- **Addon boundary:** Lore/code tools live in add-on system only. Non-coders never see them.
- **Lore north star:** multi-client presence, locks, live file broadcasts, shared repo

## Baseline gate (every card)

From `/var/home/Ronin/wabi`:
- `bun run check` + `bun run build` (frontend/)
- `cargo check --workspace` + `cargo test -p wabi-server`
- UI verified in **real browser** by Ronin (headless Chromium crashes on Wabi)
- Never commit `data/` runtime noise or `docs/wabi-carl-watch.md`

## Dispatch protocol

1. One bounded card → opencode/`opencode/deepseek-v4-flash-free`
2. Hermes verifies: git baseline, targeted diffs, fresh checks — never trust worker self-report
3. Scope-drift check against the card
4. Green → next. Red → re-dispatch with failure in CRITICAL INTERFACE NOTES
5. Never edit worker files mid-flight
6. Post-burn second-opinion audit mandatory (green cards ≠ ship-ready)
7. Final gate: full build → deploy → Ronin real-browser verify
8. Tick checkboxes here + progress log as cards land

---

## WAVE 0 — Addon system coherence
*Foundation. Gates W1 and W6.*

- [x] **A1** Canonical manifest — single `plugin.json` schema (id, version, description, backend{runtime:rust,path,crate,cargo_feature}, frontend contributions, permissions). Align `core/addons/lore|mesh|webhooks`. Schema: `docs/addons/plugin-schema.md`.
- [x] **A2** Server capability endpoint — `GET /api/addons` + `GET /api/addons/{id}` in `api/addons.rs`; lore nested under `/addons/lore`. Features build green; unit tests pass. Also fixed pre-existing lore.rs `Result` import that blocked `--features addons`.
- [x] **A3** Frontend capability plumbing — `addonInventory.ts` + `addonDetection.ts` call `GET /api/addons` (not `/api/plugins`); map capability → PluginApiRecord; bundled allowlist + never remote `import(manifest.frontendEntry)`. loader.ts already on `/api/addons/{id}`.
- [x] **A4** Fix Addons settings UI — list-only from `GET /api/addons`; removed install/import/`.wabip` theater + broken `./plugins/*.svelte` glob. Local controls sections kept.
- [x] **A5** Delete dead Node layer — `addons/packages` + `addons/source` archived to `archive/addons-dead-node-layer/` (git mv). README + plugin-schema updated. Live tree keeps payments/content/media sketches only.
- [x] **A6** Lore stays add-on — UI gated on `hasAddonCapability('lore')`; create sends `asset_storage`; server feature-gates Lore repo auto-provision. Asset Storage option only when lore enabled.

**Verify:** `cargo build --features addons -p wabi-server`; `GET /api/addons` returns lore; `bun run check`.

## WAVE 1 — Lore reachable end-to-end
*Add-on gated. `LoreChannel.svelte` (1737 lines) is complete but unreachable E2E.*

- [x] **L1** Channel kind — `ChannelKind::Lore = 11`; wire `channel_type:"lore"` + `asset_storage` on ChannelResponse; create maps lore/asset_storage → Lore; adapter exhaustiveness fixed. cargo+domain tests green.
- [x] **L2** Create + sidebar — Asset Storage option (A6/L1); socket `normalizeChannel` → type lore; `LoreChannelList` + sidebar section; lore excluded from text list; protocol ChannelType includes lore. Chat already branches on `currentChannelType==='lore'`.
- [x] **L3** URL prefix fix — `loreUrl` → `/api/addons/lore`; LoreChannel uses `loreFileUrl` (no bare `getServerUrl()/addons/lore`).
- [x] **L4** ID parsing — shared `parseLoreChannelId` hex (`ch_{:x}`); loreStore + LoreChannel; no decimal parse.
- [x] **L5** Auth'd media previews — blob object URLs via `downloadLoreFile` (thumbs cache + preview + lightbox); revoke on channel change/destroy; signed URL = L7.
- [x] **L6** Tokenize styles — bare hex/rgba/raw z → tokens (`--z-lightbox`, surfaces, danger/warning/success, color-mix); Notes header hook → `layoutStore.openNotes()` (not N1–N4). bare scan 0; bun pre-existing bun:test only.
- [ ] **L7** Auth'd web downloads w/ permission — cookie/signed-URL path + channel-membership gate.
- [ ] **L8** Role-based editing — Owner/Admin/Developer edit; Artist = asset-write only (W6g); Viewer read-only. Frontend gates Edit/Commit UI by role.

## WAVE 2 — Math (KaTeX in chat)

- [x] **M1** KaTeX in `markdown.ts` — add `katex` dep; extract `$…$`/`$$…$$`/`\\(…\\)`/`\\[…\\]`/`\\begin{env}` **before** `marked`; render via KaTeX; re-inject HTML **after** DOMPurify. Load KaTeX CSS beside `prism-theme.css`.

## WAVE 3 — Channels: navigation + linking

- [x] **C1** Clickable `#channel` mentions → `switchChannel` (parser + resolver in `markdown.ts` / `navigateToRef.ts`). `#channel` while code protected; MessageList routes `data-ref-kind=channel`.
- [x] **C2** Complete `navigateToRef` branches — `pendingNav` set/peek/take; Forum/Wiki/Gallery consumers open thread/page/lightbox after channel switch.
- [x] **C3** Sidebar/section navigation robustness — Forum/Wiki sections + create between Gallery and Asset Storage; text isolation; Chat already routes forum/wiki.

## WAVE 4 — Calling

- [ ] **V1** Two-client smoke test — voice channel join/listen, DM call, group call; fix what breaks. Note DM calls are P2P (STUN-only unless TURN) — verify `direct_call_turn_unconfigured` notice (`CallModal.svelte:263`).
- [ ] **V2** Screenshare across P2P + LiveKit — fix `screen-share-targets` roster if shares don't reach everyone (`callingScreenShare.ts`).
- [ ] **V3** Calling-debug showcase — promote `callingDiagnostics.ts` (`RTCPeerConnection.getStats()` → ping/jitter/loss/bitrate) into shareable debug panel (today only inline: `MainLayout.svelte:1001`, `VoiceUserCard.svelte:81-92`, `CallView.svelte:348-378`).
- [ ] **V4** Multi-call UI — extend single-call state (`callingStateStores.ts`) so DM/group call + primary voice channel can be active simultaneously; keep TeamSpeak-style listen-only. Kill `livekitSfu.ts` no-op stub (`calling.ts:113-117`).
- [ ] **V5** Backend stubs — `move-user-to-voice-channel` + breakout rooms are stubs (`breakout_ops.rs:5-24`) — implement or disable UI entry points.

## WAVE 5 — Notes 3-layer system

- [ ] **N1** Layer 1 (corner/quick) — mount dead `QuickScratchpad.svelte` (0 importers) + orphaned `notesStore.ts` scratchpad helpers; global hotkey/slash command.
- [x] **N2** Layer 2 (right panel) — `WorkspacePanelHost` notes → `KeepNotesView compact`; `openNotes()` → `openRightPanel('notes')` (clears stale NOTES_DM_ID); KeepNotes `compact` prop.
- [x] **N3** Layer 3 (center stage) — `centerPanelView: 'notes'` + MainLayout notes stage + Expand from compact KeepNotes; same storage as right panel.
- [x] **N4** Kill bottom-right fast-swap — removed dblclick `cycleActivePanel`; invalid-tab heal → `setActiveRightPanel(recent|first)` (not `openRightPanel(panels[0])`).

## WAVE 6 — Lore collaborative workspace
*Add-on; native edits / web previews. Core "work together infinitely easier" deliverable.*

- [ ] **W6a** Lore server as compose profile — sidecar co-located with wabi-server; `[addons.lore] mode="sidecar"`, `server_url` wired (`LoreAddonConfig`, `config.rs:67-100`).
- [ ] **W6b** External-tool Connect panel — per-repo server URL + repo id + access token + CLI/SDK setup snippets (C/C++/C#/Rust/Go/Python/JS).
- [ ] **W6c** CodeMirror 6 editor, desktop-only — bundled into Tauri (`scripts/build-tauri.mjs` / build split); web = preview-only Prism, no editor.
- [ ] **W6d** Native (Tauri) Rust bridge — file IO, commit/branch/lock, token minting via `core/addons/lore/backend/src/lib.rs`.
- [ ] **W6e** Multi-client presence + live broadcasts — Socket.IO "who's viewing/editing which file", Lore lock events in collaborators list, commit/update broadcasts so viewers see changes live. **Core deliverable.**
- [ ] **W6f** Working branch switcher + history — branch select is decorative today (no branch param in `api/lore.ts` or backend). Real branch switching + visual history/diff timeline (mirror `WikiChannel`/`WikiPageTree`). `lore_commits` projection exists (`projections/lore.rs`).
- [ ] **W6g** Artist track — asset upload/download/replace + lock, image/video/audio/PDF previews, grid thumbnails, folder organization — no editor, no code, no branch/commit demands. Optional 3D via model-viewer addon.

## WAVE 7 — Recording (properly coded + Lore upload)

Architecture sound: `callRecording.ts` → `uploadRecordingToLore` → `loreRecording.ts` → POST `/api/addons/lore/recordings`.

- [ ] **REC1** End-to-end verify — voice + channel call recording: mixed + stems (`AudioSettingsTab.svelte:203`), save, panel UI, recording-icon + local-hide setting (website-finish DoD 16).
- [ ] **REC2** Fix Tauri desktop save — `tauri-recording.ts:18` invokes `save_call_recording` but no Rust command exists — register in `src-tauri` or remove dead invoke.
- [ ] **REC3** Verify Lore upload path — "Recordings" channel provisioning, health guard (`loreRecording.ts`), upload, history visible in lore channel. Two-client smoke test.

## WAVE 8 — Business → proper "Planning" channel view

Full business suite exists (`PlannerWorkspace`, `KanbanBoard`, `GanttChart`, etc.); `/business` redirects to Planner. But no `planning` channel type.

- [x] **BZ1** Channel type — `planning` on `RoutedChannelType` + label/icon in `channelTypes.ts`.
- [ ] **BZ2** Backend + create — `ChannelKind` mapping; "Planning" create option in `CreateChannelForm.svelte`; sidebar section in `ChannelSidebar.svelte`.
- [ ] **BZ3** Route to surface — render `PlannerWorkspace`/`BusinessSurface` when `currentChannelType === 'planning'` (mirror forum/gallery/wiki in `Chat.svelte`/`MainLayout.svelte`); channel-scoped projects/boards.
- [ ] **BZ4** Verify views + perms — Kanban/burndown/gantt/calendar accessible from channel; permission gating.
- Ref: `docs/plans/2026-07-28-business-into-main.md`

## WAVE 9 — Profiles & banner overlays

Today: color-only banner (`--pfp-banner`), bio links, roles, status. No banner image, no overlay, no full profile surface.

- [ ] **PR1** Banner image upload + ownership registry (`/uploads`, like avatars); replaces color-only `popout-banner`/`profile-hero-banner`.
- [ ] **PR2** Transparent overlay layer above profile picture — PNG overlay (frames/banners around avatar) as positioned layer over avatars in messages, popouts, server rail, member list.
- [ ] **PR3** On/off controls — per-user toggle for own overlay + **global setting to disable all banner overlays** ("people hate banners" option).
- [ ] **PR4** Profile overhaul — full profile surface (banner + overlay + bio + roles + status/activity + joined + notes + quick actions: message/voice/video/mention/copy-id/share), richer popout, self-profile editing, close interaction gaps.

## WAVE 10R — Frontend design regressions (Ronin 2026-08-01)
*User-reported. Fix during design/polish work — do not drop. Prefer real-browser verify (Ronin), not headless.*

- [x] **R1** Bottom-right microview — notes + DM tabs (not quick-link launcher). `QuickResourcesPanel.svelte`: scratchpad auto-save + compact DM (pinned aux / active DM; NOTES_DM_ID excluded); drag-down collapse; collapsed bar caret `^`. Full Notes stays N1–N4 / openNotes.
- [x] **R2** Channel + message icons — shared `.hash` 18px box + SVG 16px; typed icons (gallery/forum/lore/wiki/voice); compact hides glyph for `::after` abbrev. `sidebar-core-part1.css` + `sidebar-channels.css`. Ronin browser verify owed.
- [x] **R3** Settings gear — 28×28 btn / 16px SVG; no `font-size:1.5rem` on gear. part1 + **part3** (loads last) + compact + profile aligned. Ronin browser verify owed.
- [x] **R4** Pinned messages — drawer beside channel list via sidebar rect + `navDock` flip; surface tokens (no white); mobile full-bleed. `PinnedMessagesModal.svelte`. Ronin browser verify owed.
- [x] **R5** Channel drag-reorder — drop CSS (info line), `is-dragging` row dim, `sameChannelFamily` cross-type refuse, before/after insert math + cross-category reindex; lists bind is-dragging; server double-patch (`update_settings`+`update`) confirmed; `channels-reordered` client already wired. Ronin browser verify owed.
- [x] **R6** Boot crash `e.subscribe is not a function` — **parked (no FE fix)**. Static: no smoking-gun non-store `.subscribe`; `layoutStore.subscribe` exists; crash in Svelte runtime chunk `DP1StNsd.js`. Needs Ronin live stack + source map after hard refresh / STATIC_BUILD. **P0 if still on Tim after deploy+refresh.**
- [x] **R7a** Client HTML/JSON guards — `parseApiJson`/`isJsonContentType` in `api/utils.ts`; `placeStore` + `addonInventory` + `addonDetection` soft-fail on SPA 200 HTML/empty and `markEndpointUnsupported`. Stops console `JSON.parse` spam. bun pre-existing bun:test only.
- [x] **R7b** Server code — `GET /api/places` stub JSON `{places:[]}` in `api/places.rs` + nest in `routes.rs`/`mod.rs` (`cargo check -p wabi-server` ok). `/api/addons` already nested in source (`addons.rs`). **Tim live still 200 text/html** until binary redeploy (R7a client guards hold). Ops: ship binary; prove `curl -sI :3001/api/places` + `/api/addons` → application/json.
- [x] **R8** Guest shows "unknown" — init synthesizes provisional guest `currentUser`; `user-joined` promotes self; ProfileCard `displayUsername`/`Guest` guards.
- [x] **R9** Chat search sticky auto-focus — `chat/ChatHeader.svelte` removed `on:mouseenter={onOpenSearch}`; click/focus only (`on:focus` + collapsed 36px input).
- [x] **R10** Settings addon search — `addonSearchQuery` stays `''`; input `name="addon-filter"` + autocomplete/lp/1p off. **Best-effort** vs browser autofill — Ronin hard-refresh confirm owed.
- [x] **R11** Status bubble size (BL user) — 18px→10px token in `status-system.css` + `sidebar-core-part3.css`; profile-card + avatar-wrap dots; glow 12→6px.
- [x] **R12** CF Insights beacon — not in app bundle (`app.html` clean). CSP correctly blocks `static.cloudflareinsights.com/beacon.min.js`. Fix: CF dashboard → Web Analytics / Insights off for wabi.chat (or stop inject). Runbook: `docs/CALLING_CSP_DEBUG_2026-07-15.md`. Console noise only unless it blocks boot.

## WAVE 10 — Visual polish (web + Tauri + mobile)

- [ ] **P1** AGENTS.md Passes 0–5 — re-home `--text-*` from dead `src/app.css` into `tokens.css`; define ~15 undefined tokens; re-tokenize DM surfaces/admin-center-stage; z-index reconciliation; a11y (aria-labels, dialog roles, `100vh→100dvh`); delete 9 dead sheets + orphaned CSS; taste pass. (`frontend/AGENTS.md` authoritative; 0 of 5 started.) **Include 10R residuals.**
- [ ] **P2** Tauri desktop — frameless + `decorations:false` has no drag region/titlebar → add titlebar + min/max/close (`lib/tauri-window.ts`); remove debug-cube window (`src-tauri/src/lib.rs:12-26` + `/tmp/viewer-debug.log`); reconcile `main.rs` vs `lib.rs` builders; register or delete 12+ dangling commands; ACL grants (`capabilities/default.json`); fill or remove empty tray "About".
- [ ] **P3** Mobile responsive polish — consolidate ~28×`768px` + scattered breakpoints; fix under-discoverable auto-hiding bottom nav (`MOBILE_NAV_IDLE_HIDE_MS`); overlay sheets; hardcoded z-indexes; `100dvh`.
- [ ] **P4** Native mobile *(deferred)* — `tauri android/ios init`. No `Android/` dir today; `frontend/src-tauri/` is stale/gitignored.

## WAVE 11 — Branding (login/launch per-community)

Launch-page branding exists (`/api/public/launch-page` → `LaunchPanel.svelte`; admin `FrontendMetadataPanel.svelte`). Richer profile system only a plan (`docs/sabi-branding-plan.md`).

- [ ] **B1** Audit brandability — everything that still says "Wabi": window title, favicon, app name, login footer, about/tray, loading strings.
- [ ] **B2** Branding-profile contract + admin UI — brand name, logo/banner, palette, headline/sub, footer, custom CSS, boot sequence.
- [ ] **B3** Strip-Wabi option — clean non-branded default so communities go fully neutral or fully custom.
- [ ] **B4** Prettier default launch/login as the showcase face.

## WAVE 12 — Post-polish backlog (deferred, not cut)

- [ ] **S1** Steam addon — rich-presence "currently playing" badge, `steam://run`/lobby join links, opt-in game status (`docs/steam-integration-proposal.md`). **After** minimum polish.
- [ ] **S2** Native mobile (tauri android/ios) — separate track.
- [ ] **S3** 3D/asset preview polish (model-viewer addon).

---

## WAVE 12 — Post-polish backlog (continued)

- [ ] **S4** Bot platform (full) — if H1a–c balloon past thin cards.
- [ ] **S5** Hermes gateway (full) — slash commands, rich interactions, multi-server bot installs.

## WAVE 13 — Stretch: Bot platform + Hermes as one bot *(after W0–W11 green)*

**Design source of truth (research + security bar):** `docs/hermes-bot-platform-design.md`

**Locked:** bot account + token + scopes; language-agnostic HTTP (not Python-only); never user-impersonation; webhooks secondary; bots call the same admin tools humans use; auto-ban requires reason + audit; no silent DMs.

**Today's reality:** no `is_bot`, webhook *delivery* is a log-only stub, no bot routes. Platform first, Hermes second.

- [x] **H0** Design lock — `docs/hermes-bot-platform-design.md` (identity, scopes, security checklist, card split).
- [ ] **H1a** Bot identity + token auth — `is_bot` on User; create/rotate/disable; `Authorization: Bot <token>`; BOT badge; no Hermes-specific code.
- [ ] **H1b** Delivery — real outbound webhook HTTP POST (kill stub); bot `messages:write` to joined channels; `message.created` outbound at minimum.
- [ ] **H1c** Hermes as one normal bot — register hermes-bot via H1a; deliver/cron as bot; @mention → Hermes receive; optional mod scopes only if owner opts in.

**Acceptance:** security checklist in the design doc must all pass before any H-card is green.  
**Defer:** balloon → S4/S5. Hermes must never get special-case core forks.

---

## Progress log

| Date | Card | Result | Notes |
|------|------|--------|-------|
| 2026-08-01 | H0 | done | bot platform design doc written |
| 2026-08-01 | A1 | done | opencode timed out zero output; Hermes in-session: schema + 3 plugin.json aligned |
| 2026-08-01 | A2 | done | GET /api/addons + /{id}; lore nested; lore Result fix; features+tests green |
| 2026-08-01 | M1 | done | KaTeX 0.18.1; extract→marked→purify→inject; CSS in +layout; SMOKE_OK; no DOMPurify style widen; bun:test errors pre-existing |
| 2026-08-01 | A3 | done | frontend inventory → /api/addons; capability map; bun errors pre-existing bun:test only |
| 2026-08-01 | A4 | done | list-only Addons settings; install/import theater removed; bun still pre-existing bun:test only |
| 2026-08-01 | A5 | done | packages+source → archive/addons-dead-node-layer; README/schema updated |
| 2026-08-01 | A6 | done | loreAvailable gate + asset_storage on create; server still feature-gated |
| 2026-08-01 | L1 | done | ChannelKind::Lore=11; wire lore+asset_storage; cargo+domain tests green |
| 2026-08-01 | L2 | done | normalizeChannel; Asset Storage sidebar; ChannelType+lore; bun pre-existing bun:test only |
| 2026-08-01 | L3 | done | loreFileUrl → /api/addons/lore; LoreChannel thumbs/preview |
| 2026-08-01 | L4 | done | parseLoreChannelId hex; store + LoreChannel |
| 2026-08-01 | L5 | done | blob thumbs+preview; revoke; bun pre-existing bun:test only |
| 2026-08-01 | L6 | done | tokenize + openNotes hook; bare scan 0; bun pre-existing bun:test only |
| 2026-08-01 | C1–C2 | done | #channel pre-restore; pendingNav peek/take; Forum/Wiki/Gallery; SMOKE_OK 18; bun pre-existing bun:test only |
| 2026-08-01 | C3 | done | Forum/Wiki sections + create; text isolation; bun pre-existing bun:test only |
| 2026-08-01 | R9 | done | removed mouseenter openSearch; focus/click kept |
| 2026-08-01 | R11 | done | 18→10px status bubble; status-system + part3; glow 6px |
| 2026-08-01 | R8 | done | init synthesize guest + user-joined self + ProfileCard Guest |
| 2026-08-01 | R4 | done | sidebar-edge reanchor + navDock flip; surface tokens; mobile full; bun pre-existing bun:test only |
| 2026-08-01 | R7a | done | parseApiJson guards place/addons; SPA HTML soft-fail; bun pre-existing bun:test only |
| 2026-08-01 | R7b | code done | places stub + routes; Tim HTML until binary deploy; R7a guards hold |
| 2026-08-01 | R6 | parked | static clean; DP1=Svelte runtime; needs live stack+sourcemap |
| 2026-08-01 | R1 | done | notes+DM microview; scratchpad+DM slot; drag-collapse; ^ caret; NOTES_DM_ID guard; bun pre-existing bun:test only |
| 2026-08-01 | R2/R3/R10 | done | hash box+typed icons; gear 28/16 part1+part3+compact+profile; addon-filter autofill guards; bun pre-existing bun:test only |
| 2026-08-01 | N4 | done | kill dblclick cycle; soften auto-heal; bun pre-existing only |
| 2026-08-01 | N2 | done | KeepNotesView compact; openNotes→notes panel; no NOTES_DM_ID fake DM |
| 2026-08-01 | N3 | done | centerPanelView notes; MainLayout stage; Expand from compact |
| 2026-08-01 | BZ1 | done | planning on RoutedChannelType + Planning/PL label/icon |
| 2026-08-01 | R5 | done | drop CSS + is-dragging + sameChannelFamily + before/after math; server double-patch confirmed; bun pre-existing only |
| 2026-08-01 | R12 | done | CF dashboard only; runbook CALLING_CSP_DEBUG; no FE chase |
| 2026-08-01 | 10R R1–R12 | listed | Ronin regressions: BR microview, icons, gear, pinned side, DnD, subscribe crash, places/addons JSON, guest name, search hover/prefill, status bubble, CF beacon |

## Card counts

| Wave | Cards | Status |
|------|-------|--------|
| W0 Addon | 6 | A1–A6 complete (gates W1/W6 open) |
| W1 Lore E2E | 8 | L1–L6 done; L7 next |
| W2 Math | 1 | M1 done |
| W3 Channels | 3 | C1–C3 done |
| W4 Calling | 5 | pending |
| W5 Notes | 4 | N2–N4 done; N1 free |
| W6 Lore collab | 7 | pending |
| W7 Recording | 3 | pending |
| W8 Planning | 4 | BZ1 done; BZ2–BZ4 free |
| W9 Profiles | 4 | pending |
| W10R Regressions | 13 | R1–R5+R7a+R7b-code+R8–R12 board-closed; R6 parked live; R7b Tim deploy owed |
| W10 Polish | 4 (1 deferred) | pending |
| W11 Branding | 4 | pending |
| W12 Backlog | 5 | deferred |
| W13 Bot platform | H0 done; H1a–c stretch | after green |
| **Active total** | **~62** | |
| **+ stretch/backlog** | **+8** | |
