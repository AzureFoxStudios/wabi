# Boot Optimization — Execution Report

- **Date:** 2026-08-26
- **Executor:** ox-alpha
- **Work order:** [`docs/plans/2026-08-26-boot-optimization.md`](./2026-08-26-boot-optimization.md) (reviewed, amended, then executed in full)
- **Status:** ✅ All six phases implemented, tested, committed. Nothing pushed or deployed (push/deploy gates not invoked).
- **Commits (in order):**
  - `da317fb` perf(boot): phase 1 — server-injected brand + sw/manifest cache fixes
  - `97e51a0` perf(boot): phase 2 — dedupe public-config fetches, skip launch-page when injected brand says none
  - `62a0572` perf(boot): phase 3 — lazy LayoutRouter; login path no longer downloads the app bundle
  - `d4d7081` perf(boot): phase 4 — lazy non-first-paint surfaces + katex/prism CSS off the boot path
  - `f2e9df7` perf(boot): phase 5 — build init roster concurrently
  - `08cf03c` perf(boot): phase 6 — static loginHelpers import, immediate reconnect probe
  - `9d364c2` docs(boot): implementation log

---

## 0. Headline result

| Metric | Before | After | Δ |
|---|---|---|---|
| Eager payload, anonymous login page (`entry` + modulepreloads + `nodes/2.*` closure + eager CSS) | **4,887,066 B** (26 files) | **1,706,776 B** | **−65.1%** |
| Largest eager chunk | 2,410,616 B shared app chunk | 87,931 B (socket.io, still eager — see §4.3) | −96% |
| Page node `nodes/2.*` | 825,750 B | 37,593 B | −95% |
| Eager CSS | 540,118 B (incl. katex + prism) | 510,679 B (katex/prism moved to dynamic app chunk) | −5%, and the heavy sheets now load with the app |
| Server `init` roster build | N serial awaited store reads per user | single concurrent `join_all` pass, identical wire bytes | ~1 RTT |
| Rebrand propagation | up to 1 year (immutable-cached manifest) / SW stale up to 24 h | next request (mtime-keyed recomposition; `no-cache` on sw/manifest) | immediate |

Every phase is one revertible commit; no persistence-format change, no protocol regen, no minifier change.

---

## 1. Plan review → amendments folded before execution

Seven findings from the review were folded into the plan doc before any code was written:

1. **SPA-fallback injection gap (high)** — `serve_static` returns index.html through two paths (direct hit + SPA fallback for deep links). Phase 1 now composes both.
2. **Phase 3 reconnect-path gap (high)** — offline-returning users regain a session without touching LayoutRouter; both reconnect success paths now kick the import.
3. **AppState gotcha corrected** — no test constructs `AppState {` literals; everything goes through `AppState::new`. Field init went there only.
4. **Static `<title>` tradeoff documented** — injected title wins over `business/+page.svelte`'s "Planner · …" (first `<title>` in head wins); accepted, do not "fix" by moving the tag.
5. **§7.1 snippet mislabeled** — plan showed target code as "before"; fixed to show the real serial loop.
6. **Router extraction scope honesty** — layers (`rate_limit`, sio, cors, compression, timeout) move with the router, noted in §3.6.
7. **Phase 2 seeding shape** — snapshot must be mapped into a full `LaunchPageConfig` (palette.accent etc.), not seeded bare.

---

## 2. What changed, phase by phase

### Phase 1 — server-injected brand + cache-header fixes (`da317fb`)

**Mechanism:** the server stamps its identity into index.html at request time so first paint is branded with zero requests and no Wabi→custom flicker.

Files:

- `frontend/src/app.html`
  - Markers added: `data-wabi-brand-title` on a new static `<title>Wabi</title>`, `data-wabi-favicon` on the icon link, `data-wabi-theme-color` on the theme-color meta.
  - Injection slot at top of head brand script: `window.__WABI_SERVER_BRAND__ = /*__WABI_SERVER_BRAND__*/null;`
  - Head-script precedence rewritten: neutral always from localStorage entry's `useNeutralBranding`; name/logo/accent from injected brand (server is source of truth for its own identity); legacy saved-entry resolution kept for un-injected hosts; launch-page fetch fallback only when neither exists. Body script's `applyBootBrand` lock untouched.
- `core/crates/wabi-server/src/api/public.rs`
  - `load_frontend_metadata_policy` → `pub(crate)`.
  - New `pub fn build_boot_brand_json(&Value) -> Option<String>` mirroring `get_launch_page`'s extraction exactly (same launch-story boolean), returning `None` for stock Wabi.
- `core/crates/wabi-server/src/state.rs`
  - New `ComposedIndexCache { policy_mtime, has_custom_brand, body }` + `AppState.composed_index: tokio::sync::RwLock<Option<_>>`, initialized in `AppState::new`.
- `core/crates/wabi-server/src/app_router.rs` (**new lib module**)
  - Router assembly extracted out of `main()` into `pub fn build_app_router(Arc<AppState>)`. The plan said "in main.rs", but integration tests link the *lib* target, not the bin — same construction, new home. Moved verbatim: `serve_upload`, `StaticAssets`, `build_cors_layer` (+ tests), health/liveness/readiness/metrics handlers, metrics middleware. `main()` now calls the builder.
  - `serve_static`: new `State` extractor; composition helper `composed_index_html` applied to **both** index paths (direct hit AND SPA fallback — deep links get the branded shell too); fail-open to raw shell if the token is missing (warn-once).
  - Injection: token replace, title/favicon replace with HTML-escaped values, theme-color replace gated by strict hex regex `^#[0-9a-fA-F]{3,8}$`.
  - Cache fixes: `sw.js`, `manifest.webmanifest`, `manifest.json` join the `no-cache` branch.
- `frontend/src/lib/branding.ts` — `BootBrandSnapshot` extended with `launchEnabled?`/`bannerUrl?`; global `__WABI_SERVER_BRAND__` declared.
- `core/crates/wabi-server/tests/boot_brand_injection.rs` (**new**) — 6 tests:
  1. branded `/` **and** `/channels/abc` carry `"brandName":"Fort Night"`, replaced title/favicon/theme-color, `no-cache`;
  2. stock server serves the untouched shell (token + default title intact);
  3. `/sw.js` + `/manifest.webmanifest` revalidate;
  4. non-hex accent rejected at the attribute level;
  5. mtime-keyed recomposition after policy rewrite;
  6. `</script>` breakout via admin strings is neutralized (see §3).

Verification: full `cargo test -p wabi-server` green (131×2 unit targets + all integration suites); release build OK; live-server curls confirmed stock token survival, branded injection, deep-link parity, mtime rebrand without restart.

### Phase 2 — dedupe public-config fetches (`97e51a0`)

- `frontend/src/lib/api/config.ts` — module-level `sharedRequest(key, ttl, run)` wrapper: in-flight or fresh (< TTL) shares one promise; rejections evict so failures are never cached. Only the local variants route through it (`setup-status` 10 s, `launch-page` 15 s); `getLaunchPageConfigFrom(baseUrl)` stays unwrapped — cross-server probes must never be deduped against the local server.
- `frontend/src/lib/components/Login.svelte` — when the injected brand says `launchEnabled === false`, seeds a complete `LaunchPageConfig`-shaped object synchronously (`enabled:false`, palette.accent populated) and skips the fetch entirely; otherwise fetches (now deduped).

### Phase 3 — split login path from app bundle (`62a0572`)

- `frontend/src/routes/+page.svelte`:
  - Static `import LayoutRouter` removed; module-scope `ensureLayoutRouter()` machinery (plain lets — legacy-syntax file).
  - Import kicked: returning-session path (before `initSocket`, overlapping socket connect), `handleLogin` first statement, **and both reconnect success paths** (poll success + `wabi:work-offline`) — the latter two were the review finding; without them a reconnected user would sit on Login forever.
  - End-of-bootstrap `Promise.race(ensureLayoutRouter(), 10 s timeout)` holds the boot shell until the app can render — **only when a session exists**. Deviation from the literal snippet, required by the phase's own goal: unconditional execution would have started the import for anonymous visitors too.
  - Render gate: `{#if !loggedIn || !LayoutRouterCmp}` → Login (covers the logged-in-but-module-loading window) `{:else}` → `<svelte:component this={LayoutRouterCmp}>` preserving `isInitialLoad`/fade structure. ConfirmDialogs moved to a `{#if loggedIn}` block so prompts render regardless of module state. `on:logout` forwarding through `<svelte:component>` verified working in legacy mode — no wrapper needed.

Result: eager union 4.89 MB → 1.75 MB; page node 825 KB → 37 KB; the 2.41 MB chunk left the login path entirely.

**§5.2 stretch (socket.io off login path) SKIPPED per its own criteria:** `currentUser` is defined in `presenceStore.ts`, which statically imports from `socketConnection.ts` → `SocketManager` in `socketConnectionCore.ts` → socket.io-client. `dmPanelSignal` sits in `socket.ts` behind the same manager. Both stores drag the 850 KB chunk regardless of call-site conversion, so the stretch would gain nothing. Documented, nothing reverted (nothing had been written).

### Phase 4 — trim logged-in first paint (`d4d7081`)

CSS moves:

- `+layout.svelte` no longer imports katex/prism CSS; `src/lib/markdown.ts` (which imports both JS deps) carries both stylesheets — they now load inside the dynamic app chunk. AdminCenterStage's CSS moved from MainLayout into the component itself.

Lazy surfaces in `MainLayout.svelte` (per-component pattern: null-typed `let XCmp`, `$:` trigger on activation flag, `{#if}` gate + shimmer placeholder):

- Converted: `ModelViewportTab`, `Settings` (`bind:isOpen` via `<svelte:component>` works), `AdminCenterStage`, `VoiceView`, `CallModal` (trigger = incoming/outgoing/in-call/group-ring/active-calls union), `PlannerWorkspace`, `MapWorkspace`, `MediaAlbumsTab`, `ReaderTab`, `GalleryChannel`, `CallDebugPanel`, `KeepNotesView`.
- Kept eager per plan: `Chat`, `ChannelSidebar`, `ServerRail`, `RightPanel`, `VoiceLiveStrip`, `FloatingPanelHost`, `WorkspaceViewBar`, `QuickScratchpad`; utility-module imports (stores, addon IDs, `openWhiteboardSurface`) stay static.
- Build output confirms real split points (separate chunks + per-component CSS assets).

Honest limits (logged, conversions kept): two components remain pinned into the ~2.05 MB shared app-world chunk by static edges outside this phase's scope:
- `PlannerWorkspace` ← also statically imported by `Chat.svelte`;
- `ModelViewportTab` ← also statically imported by `WorkspacePanelHost.svelte` (→ RightPanel) and `WhiteboardTab.svelte`.
Follow-up: apply the same lazy pattern at those three importers.

Eager CSS 540,209 → 510,679 B; final eager union 1,706,776 B.

### Phase 5 — parallelize server `init` roster (`f2e9df7`)

- `core/crates/wabi-server/src/socketio/presence.rs` — the serial `for u in users { build_user_view(...).await }` loop became `futures::future::join_all(users.map(...))`. `join_all` preserves input order ⇒ roster bytes identical on the wire. The `online_users` loop was left serial per plan ("convert only if trivial") — it iterates connected sockets only. Full suite green.

### Phase 6 — nits (`08cf03c`)

- `+layout.svelte` — mid-boot `await import('$lib/components/loginHelpers')` deleted; `injectNeutralBranding` joined the existing static import.
- `+page.svelte` — reconnect poll probe extracted to `probeReconnect()`, fired immediately once, then every 3 s as before (offline-returning users no longer wait 3 s for the first check).

---

## 3. Security hardening found during execution

While writing the injection tests I found that `serde_json::to_string` does **not** escape `</script>`. An admin-entered displayName like `</script><img src=x onerror=alert(1)>` would have terminated the inline boot script tag early — XSS via the brand JSON despite correct HTML escaping of title/icon attributes. Fix (Phase 1, tested by `brand_json_cannot_break_out_of_script`): the composed JSON is post-escaped `\u003c \u003e \u0026` for `< > &` — valid JSON *and* JS, invisible for well-formed values, breakout-proof otherwise. Combined guards: HTML-escape for attribute contexts, strict hex-only accent, JSON script-context escaping.

---

## 4. Test & verification evidence

- `bun run check` — 0 errors at every step (warnings 181 baseline → 179 after Phase 4).
- `STATIC_BUILD=1 bun run build` — clean after each frontend phase; token grep verified in `build/index.html` (exactly one replaceable token; markers survive).
- `cargo test -p wabi-server` — green throughout (unit ×2 targets, `boot_brand_injection` 6/6, `first_boot_onboarding`, `live_session_room_contract`, payments contracts).
- `cargo build --release -p wabi-server` — OK; embeds final frontend.
- Live runtime (release binary, temp data dir, port 3007):
  - Stock: un-replaced token + default markers served; `GET /sw.js` and `GET /manifest.webmanifest` → `Cache-Control: no-cache`.
  - Branded: `<title>Fort Night</title>`, favicon href, `#ff0055` theme-color, brand JSON present on `/` **and** `/channels/deep-link-test`.
  - Rewrite of `admin_policies.json` reflected on the next request (mtime keying) — no restart.
  - Accent-injection guard held at runtime. Server shut down afterwards; temp data dir outside the repo.

---

## 5. Left for William (rule 7 — headless can't render Wabi)

1. First-visit branding visual: fresh profile shows server brand at first paint — no Wabi flash, no logo swap; tab title/favicon/theme-color branded pre-JS.
2. DevTools request counts: one `setup-status`, zero `launch-page` when no launch story, one when there is; returning-session boots unchanged.
3. StartupProfile console tables (`localStorage.wabi_startup_profiler = 'true'`) — capture before/after numbers for the record.
4. Functional smoke of every converted surface: Settings (open/close/bind), admin stage, voice view, a call (incoming + outgoing modal), planner, map, media albums, reader, gallery, model viewport, notes, call-debug overlay (dev).
5. Logged-in reload feel: boot shell holds until renderable, ≤10 s escape hatch never visibly trips.

## 6. Follow-ups (out of scope here, logged in the plan)

- Apply the MainLayout lazy pattern at `Chat.svelte` (PlannerWorkspace), `WorkspacePanelHost.svelte` + `WhiteboardTab.svelte` (ModelViewportTab) to actually evict those weights from the app-world chunk (~2.05 MB dynamic chunk today).
- Optional later: revisit §5.2 if `currentUser`/`dmPanelSignal` ever move to leaf store modules free of `socketConnectionCore`.

## 7. Rollback

Each phase is a single revertible commit (hashes at top). No data migration, no persistence change, no protocol regen. Phase 1 additionally fails open at runtime: missing token or unreadable policy ⇒ raw embedded shell, behavior = pre-change.
