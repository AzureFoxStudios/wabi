# Website Finish — Definition of Done + Grok Loop Plan
Date: 2026-07-23
Owner: Ronin (product) / Hermes (captain + verification) / Grok via opencode (bulk implementation)
Battery: SuperGrok paid subscription, ~0% weekly use at start.

## Definition of Done (Ronin's words, 2026-07-23, lightly organized)

1. **Auth**: login works.
2. **Guest mode** works.
3. **Clean look sitewide**; all settings menus proper, following grid structures.
4. **Right panel** proper design — unstyled "start a conversation" / notes buttons need real work.
5. **Bottom-right** bizarre fast-swap over notes/DM — fix it.
6. **Right-click context menus** everywhere they logically should be, filled out properly; folder-based submenuing where the menu depth calls for it.
7. **Cybersecurity tightened.**
8. **Addons proper** — nothing from addons slaughtered into core (clean addon boundary, no leakage).
9. **Voice calls / voice channels** properly set up, UX solid.
10. **Screenshare** works; **spatial audio**.
11. **Whiteboard revived** and drawable. (A fully working mock exists somewhere on this computer — recon before build.)
12. **Admin dashboard** proper, PLUS a **mini admin panel** that hangs out on the right panel for serious servers with serious admins who need the info.
13. **Retention sliding scale**: perfectly ephemeral → lots of logging for legal reasons. Sane pro-consumer, NOT Discord-level logging. (Builds on the 24h-ephemeral default / keep-forever opt-in / Live rooms design already in flight.)
14. **Maps**: a map you can put pins in and move around; the 3js/rust versions show a 3D map that's pretty to look at.
15. **Reader mode** clean; supports horizontal read (classic magazines/books) AND vertical read (webtoons).
16. **Call recording**: voice/channel calls actually record; a recording icon appears while recording; users can hide the icon on their LOCAL CLIENT ONLY via settings (professional recording feel).

Scope is "everything for now" — additions go in the Additions section below and get carded the same way.

---

## Wave structure (dependency-ordered)

### WAVE 0 — FOUNDATION (gates everything)
- **F1. Site up**: diagnose the 502 (hop-by-hop: tunnel → caddy → origin → WabiDB locks), fix-forward or clean redeploy via `STATIC_BUILD=1 bun run build` → `cargo build --release -p wabi-server`. Gate: `/`, `/health`, `/login` all 200; auth POST 200; WS 101-or-polling; Ronin confirms in real browser.
- **F2. Auth login** works end-to-end (register, login, session persistence, logout).
- **F3. Guest mode** works end-to-end (join, view, permitted actions, upgrade path to account).

### WAVE 1 — CORE CHROME (needs F1–F3)
- **D1. Settings grid pass**: every settings menu across the site audited + rebuilt on a consistent grid structure.
- **D2. Right panel redesign**: style the unstyled (start-a-conversation, notes), proper component treatment.
- **D3. Bottom-right notes/DM swap fix**: kill the fast-swap behavior, restore sane layout.
- **D4. Context menu system**: right-click everywhere it logically belongs; full menu contents per surface; folder/submenu component for deep menus. Design contract first (tokens, item anatomy, submenu behavior), then rollout per surface.

### WAVE 2 — SECURITY & BOUNDARIES (needs F1; independent of Wave 1)
- **S1. Security tightening**: headers/CSP, auth/session hardening, rate limiting, input validation audit, WS auth. Audit-first, then fixes as cards.
- **S2. Addon boundary audit**: verify addon isolation — no addon code/styles slaughtered into core, clean API surface, addons load/unload cleanly.

### WAVE 3 — VOICE & CALLS (needs F2; D4 for call context menus)
- **V1. Voice calls + voice channels**: setup correct, join/leave UX solid. (Ref: wabi-calling skill + CALLING_AUDIT_FIXES.md.)
- **V2. Screenshare** works.
- **V3. Spatial audio**.
- **V4. Call recording**: recording actually captures, recording icon visible while recording, per-user setting to hide the icon locally only.

### WAVE 4 — SURFACES (needs F1–F3; each independent)
- **W1. Whiteboard revived + drawable**. Recon first: find the fully-working mock on this computer, port/integrate rather than reinvent.
- **M1. Maps 2D**: pins, pan/zoom, move around.
- **M2. Maps 3D**: 3js/rust 3D map, pretty. (Depends on M1 data model.)
- **R1. Reader mode**: horizontal read (magazine/book) + vertical read (webtoon), clean typography.

### WAVE 5 — ADMIN & RETENTION (needs F2; A2 depends on A1)
- **A1. Admin dashboard** full. (Ref: docs/plans/2026-07-15-admin-hard-design-pass.md.)
- **A2. Mini admin panel** for the right panel — serious-server admin info at a glance. Reuses A1 data/components. (Depends on A1 + D2.)
- **L1. Retention slider**: ephemeral → legal logging. Wires the existing 24h-default/live-rooms/keep-forever design into a coherent server-facing control. Sane pro-consumer ceiling.

---

## Loop protocol (per card)
1. Dispatch ONE bounded card to `opencode/grok-4.5` (probe `grok-build-0.1` early as an alternative).
2. Worker exits → Hermes verifies independently: git status vs pre-dispatch baseline, targeted diffs, `npx svelte-check --output machine` (fresh, not cached), cargo tests where touched.
3. Scope-drift check against baseline snapshot, not filename grep.
4. Green → card done, next. Red → re-dispatch with the failure written into the prompt's CRITICAL INTERFACE NOTES.
5. Never edit worker files mid-flight. Never trust worker self-report.
6. Workers cannot write /tmp or ~/.hermes, cannot scp/ssh to Tim — deploys are Hermes/Ronin only.

## Post-burn audit (mandatory)
All cards done + tests green ≠ ship-ready. Dispatch a second-opinion model audit to read code paths end-to-end; verify every claim against source before acting. (The 517-passing-tests lesson.)

## Final gate
Full build → deploy to Tim → Ronin verifies in a real browser (headless cannot render Wabi — Skia font crash).

## Additions (new scope lands here)
- (empty)

## PROGRESS LOG

### 2026-07-23 — Wave 0 F1 site-up FIXED
- **Symptom:** public https://wabi.chat → Cloudflare 502 on all routes.
- **Hop chain:**
  1. wabi-server container Up 3d healthy; host `:3001/health` → 200. Host `:3000` empty (mapped 3001→3000).
  2. wabi-tunnel-caddy `:8088/health` → 200; DNS `wabi-server` resolves inside docker; origin path green.
  3. Host caddy `:80/` → 200 (unrelated static path); `:80/health` → 404.
  4. cloudflared-named was Up but on `--protocol quic`. Historical ERR: QUIC "timeout: no recent network activity". Fresh public probes produced ZERO cloudflared log lines → edge never reached connector.
- **Root cause:** dead/stale QUIC tunnel edge connections. Origin was never down.
- **Fix on Tim (`/home/tim/Desktop/Wabi`):**
  - `docker-compose.yml`: `--protocol quic` → `--protocol http2` on cloudflared-named{,-2,-3} (backup written).
  - `docker compose --profile tunnel --profile tunnel-named up -d --force-recreate caddy-tunnel cloudflared-named cloudflared-named-2 cloudflared-named-3`
  - 3 connectors registered http2 at bkk/sin.
- **Verify:** `/` `/health` `/login` → 200; health JSON ok; polling socket.io returns sid; login bad-creds → 401 (auth API live); setupRequired=false; WS via CF still 200-not-101 (polling fallback OK). No data wipe. No owner re-register.
- **Open for Ronin browser:** confirm real login with real password + UI boot (not just API).

### 2026-07-23 — Wave 0 F2 login bounce FIXED (live) + code hardening (source)
- **Symptom:** login succeeds for a flash then bounces straight back to login.
- **API chain:** POST `/api/auth/login` → 200 + JWT; GET `/api/user/me` with Bearer → **401 `token revoked`**.
- **Root cause:** `data/wabi-server/revocations.json` had `"users": [1]`. `revoke_user` permanently blacklisted user id 1 (owner). Login still minted JWTs, but every `AuthUser` extractor rejected them → client dropped session and returned to login.
- **Likely how it got there:** change-password / admin force-logout / operator transfer all call `revoke_user`, which inserted into a permanent set with no unrevoke-on-login.
- **Live fix on Tim (no rebuild required):**
  - Cleared `users: []` in `revocations.json` (backup written).
  - `docker compose restart wabi-server`.
  - Verify: login → `/api/user/me` 200 `{userId:1, username:wabi, isOwner:true}` via origin and https://wabi.chat.
- **Source hardening (local repo, deploy next rebuild):**
  - `RevocationStore.user_epochs` per-user iat floor.
  - `revoke_user` writes floor + clears legacy `users` entry (no permanent ban).
  - `is_token_revoked` honors `user_epochs` then legacy `users`.
  - Successful password login calls `clear_legacy_user_revocation`.
- **Ronin:** hard-refresh https://wabi.chat and log in as `wabi`. Should stay in.

### 2026-07-23 — Messages/channels UI broken while APIs work; socket null-join fix DEPLOYED
- **Symptoms (user):** logged in but messages go poof; can't make channels; only 2 channels in UI; console `e.subscribe is not a function`; Join as null after force-reset; theme/addons/places JSON parse fails.
- **API truth:**
  - Login + `/api/user/me` 200.
  - POST `/api/channels` works (owner is admin). Forum `community-forum` + wiki `server-wiki` created as `ch_c` / `ch_f`.
  - Messages persist: REST list on `ch_3` shows user's "We're so back" / "uh oh" + probes. Not a DB wipe.
  - Theme/addons/places routes **do not exist** on server → SPA HTML fallback → JSON parse errors (cosmetic until Wave 2/4 cards).
- **UI root causes:**
  1. Socket `connect()` force-reset when already connected, then second connect with empty/null username → "Join as: null" → broken session / crash path.
  2. `createChannel` REST success did not update local `channels` store (no socket fanout), so sidebar looked dead.
  3. `userLookupStore` imported `users` via `socket-manager` re-export (cycle risk) → switched to `presenceStore` direct.
- **Fixes deployed (frontend rebuild + wabi-server binary to Tim, 2026-07-23):**
  - `socketConnectionCore.ts`: refuse empty-username connect; preserve live session; safe username trim on init; prefer channel **named** general; `channel-created` listener.
  - `channelStore.ts`: optimistic upsert after REST create.
  - `userLookupStore.ts`: import `users` from `presenceStore`.
- **Verify public:** `/` health me all 200 after deploy.
- **Ronin:** hard-refresh, login, try send message + create channel. Forum/wiki already exist server-side (community-forum, server-wiki) — should appear after fresh socket init.

### 2026-07-23 — Gallery surface fix DEPLOYED
- **Disappear on reload:** backend `ChannelKind` had no `Gallery`; create mapped `gallery` → `Text`. Sidebar filters `type === 'gallery'`, so after reload galleries vanished into text. Added `ChannelKind::Gallery = 9`, create mapping, socket/list mapping.
- **Double nest Gallery>Gallery>name:** `ChannelSidebar` section heading + `GalleryChannelList` heading. Removed inner heading.
- **No upload/interaction:** gallery view was browse-only. Added drag-drop + Upload button via channel media-album (`uploadToGallery`), snake_case API normalize, empty-state CTA. Gallery section always visible with +.
- **Verify:** POST create `showreel` → `channel_type: gallery` persists in list.
- **Note:** recreate any pre-fix "gallery" channels that were stored as text (they will not auto-migrate).
- **Next:** start Grok website-finish loop (Wave 1 chrome + remaining DoD).

### 2026-07-23 — Loop note: OpenCode Zen Grok blocked; in-session SuperGrok captain
- `opencode/grok-4.5` and `grok-build-0.1` both return Zen billing "No payment method". SuperGrok is Hermes xai-oauth (this session), not OpenCode Zen.
- Loop runs **in-session** on SuperGrok until OpenCode has a paid Zen method or a direct xAI provider config.
- Card D2+D3 shipped in-session: right panel notes/DM thrash + empty CTA polish. See `docs/plans/2026-07-23-card-d2-d3-right-panel.md`.

### 2026-07-23 — Card CH-NAV shipped (cannot go to channels)
- Sidebar called `joinChannel` only (socket room join) and never set `currentChannel`.
- `switchChannel` was gated on registry presence → silent no-op.
- Forum/wiki types not listed in any sidebar section.
- Fix deployed: robust `switchChannel`, all click paths use it, init normalizes type/id, forum/wiki listed under text.
- Doc: `docs/plans/2026-07-23-card-ch-nav.md`
- Guest API OK (`POST /api/auth/guest` 200).

### 2026-07-23 — Loop model correction
- User directive: OpenCode worker model is **`opencode/laguna-s-2.1-free`**, NOT OpenCode Grok.
- SuperGrok remains Hermes captain (this session) for diagnosis/verify/deploy only.
- Zen Grok billing block is irrelevant for the worker path going forward.

### 2026-07-23 — Batch deploy: CH-NAV + D4 + API JSON
- Channel nav switchChannel fix live
- Gallery/notes context menus live
- SPA no longer HTML-falls-back `/api/*` (JSON 404)
- Stubs: `/api/user/theme`, `/api/places`, `/api/plugins` return JSON 200
- Laguna: V1 calling UX labels shipped; S1 security headers + Caddy camera/mic CSP fixed for calling
- Loop model locked: `opencode/laguna-s-2.1-free`

