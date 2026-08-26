# Boot Optimization — Implementation Plan

- **Date:** 2026-08-26
- **Status:** Approved scope — full pass (William: "super yes, very very optimized")
- **Executor:** ox-alpha
- **Reviewer:** William
- **Investigation:** ZCode session 2026-08-26 (all file:line references below were verified against the tree on that date; lines drift — always re-locate by the quoted anchor text, never blind-edit by line number)

---

## 0. How to read this document

This is a work order, not a discussion. Six phases, ordered safest-first. **Every phase is independently shippable** — if you must stop, stop at a phase boundary. Commit once per phase with the message given at the end of each phase. Do not push or deploy; push/deploy gates are explicit in this repo.

Baseline measurements to take **before touching anything** are in §8. You will re-take them after Phases 3 and 4 for the final report.

### What this work is fixing (one paragraph)

Every boot of Wabi — including an anonymous visitor who only ever sees the login page — downloads, decompresses, parses and executes **~4.3 MB of JS and ~690 KB of CSS** before any Svelte component can mount. The pre-app boot shell in `app.html` exists almost entirely to mask that download. On top of that, branding resolves through a chain of HTTP fetches (with a Wabi→custom flicker on first visit), the login page re-fetches two endpoints the page already fetched, two cache headers actively block rebranding (`/manifest.webmanifest` is immutable-cached for a year), and the server builds the socket `init` roster with two serial store reads per user. This plan fixes all five.

---

## 1. Current state — measured (2026-08-26 build, `frontend/build` of Aug 24)

### 1.1 Boot timeline trace (what actually happens, in order)

1. Browser `GET /` → `serve_static` (`core/crates/wabi-server/src/main.rs:1088`) serves rust_embed'ed `index.html` with `Cache-Control: no-cache`. Inline boot shell paints (dark gradient + spinner ring + "Starting" title). Boot logo `<img>` is `visibility:hidden` until brand resolves (`data-boot-ready='1'`).
2. Head inline script (`frontend/src/app.html:321-412`) resolves brand: localStorage `wabi.savedServers.v1` entry for this origin (repeat visits — fast) **or** falls back to `fetch('/api/public/launch-page')` (first visit: default Wabi logo paints, then swaps when the fetch lands — visible flicker).
3. SvelteKit boots: `entry/start.js` + `entry/app.js` + 17 `<link rel="modulepreload">` chunks, then the statically-imported graph. Measured eager payload:

   | File (build output) | Size | Why it's eager |
   |---|---|---|
   | `chunks/DoO4lUKe.js` | **2.39 MB** | Shared chunk: MainLayout's whole world — three.js ModelViewport, video calling, whiteboard, planner, admin stage, gallery, settings, emoji picker |
   | `chunks/DRSMR6E-.js` | **850 KB** | socket.io client + connection stack |
   | `nodes/2.DR-bjngT.js` | **804 KB** | `+page.svelte` node (statically imports `Login` **and** `LayoutRouter`) |
   | ~15 small preloaded chunks | ~150 KB | entry deps |
   | `assets/0.WagZmgbg.css` | **528 KB** | layout CSS (incl. 20 KaTeX `@font-face` blocks, prism theme) |
   | `assets/2.BHwXH05S.css` + modal CSS | 158 KB | page CSS + `BlendImportSettingsModal` CSS (eager by graph accident) |

   Root cause chain: `routes/+page.svelte:7` does `import LayoutRouter from '$lib/components/LayoutRouter.svelte'` → `LayoutRouter.svelte:3` imports `MainLayout.svelte` → `MainLayout.svelte` statically imports ~50 components covering essentially the entire app. **The login path never needs any of it.**
4. `+page.svelte` bootstrap IIFE (`routes/+page.svelte:145-330`): fires `getSetupStatus()` (void), `initSocket()` (sync — connect happens in background), `initializeTheme()` (void), then hides the boot shell (`dismissDocumentBootShell()`, line 328) and flips `isBootstrapping = false` — the Login page renders. On this path nothing is awaited, so once JS is loaded the shell drops fast. The spinner duration ≈ JS download/parse time.
5. Meanwhile `+layout.svelte:onMount` (`routes/+layout.svelte:68-198`): `await import('$lib/components/loginHelpers')` (an unnecessary dynamic import mid-boot — the module is already statically imported on line 14), service-worker register, `await openWabiDB()`.
6. Socket path (logged-in): connect → `emit('join')` → server join handler (`socketio/presence.rs:60-173`) builds `init` payload: **for every user, serially**: `list_users` → per-user `build_user_view` → per-user `profile_media_for` + `badges_json_for` (2 store reads per user, awaited one at a time). Then `init` emits (channels + all users + voice state), client joins the saved channel, server sends 50-message history (`presence.rs:838-878`), UI paints.

### 1.2 HTTP fetch inventory on a fresh (no-localStorage) visit to the login page

| Request | Issued from | Duplicated? |
|---|---|---|
| `GET /api/public/launch-page` | `app.html:382` head script | **yes — Login.svelte:200 fetches it again** |
| `GET /api/public/setup-status` | `+page.svelte:220` | **yes — Login.svelte:205 fetches it again** |
| `GET /api/public/auth-policy` | `Login.svelte:201` | no |
| `GET /sw.js?v=10` + preloads | layout onMount | no |

### 1.3 Cache headers as served today (`serve_static`, main.rs:1096-1103)

| Path | Header today | Verdict |
|---|---|---|
| `index.html` | `no-cache` | correct |
| `_app/immutable/*` | `public, max-age=31536000, immutable` | correct |
| `sw.js` | **`immutable, 1yr`** | **bug** — only saved by the `?v=` query trick; update checks can serve stale SW for up to 24h |
| `manifest.webmanifest` | **`immutable, 1yr`** | **bug** — installed PWAs won't see a rebrand (name/icons) for up to a year |
| `/uploads/*` | long cache, UUID names | correct (see main.rs:123-131 comment) |

---

## 2. Constraints — read before touching anything

1. **Golden rule 1: never switch the minifier to terser.** vite.config stays esbuild. Do not touch `minify`.
2. **Golden rule 2: Svelte 5 runes only in new code.** (`+page.svelte` itself is legacy-syntax; match the file's existing style — you're adding plain `let` state and function calls, no new reactive statements needed.)
3. **Golden rule 4: `packages/wabi-protocol` is generated.** This plan never regenerates it. Don't run `cargo test -p wabi-core --features ts`.
4. **Golden rule 5: no postcard record changes.** This plan adds no fields to `Channel`/`UserRecord`/`MessageRecord`. The one AppState field added (Phase 1) is in-memory Rust state only, no persistence.
5. **Frontend must be rebuilt before backend build** — rust_embed embeds `frontend/build`. After **every** frontend change: `cd frontend && STATIC_BUILD=1 bun run build`, then `cargo build`. A stale build is the #1 way to fool yourself in Phase 1/3.
6. **Golden rule 9 (testing restarts):** both `data/wabi-server/.lock` AND `data/wabi-server/wabidb/.lock` must be removed when swapping server binaries mid-test.
7. **Golden rule 7:** headless Chromium cannot render Wabi (Skia crash). Use curl/HTTP for checks; visual verification is William's.
8. **No parallel subagents** if you spawn helpers (repo concurrency limit).
9. **Socket init lives ONLY in `+page.svelte`** (comment at `+layout.svelte:132`). Do not reintroduce it in the layout while refactoring Phase 3.
10. Vite does **not** transform inline `<script>` in `app.html` — it passes through verbatim except `%sveltekit.*%` placeholders. This is why the Phase 1 token approach works. Verify after build by grepping `frontend/build/index.html` for your token.

---

## 3. Phase 1 — Server-injected brand (zero-RTT branding, rebrand-correct tab)

**Goal:** the server stamps its brand (name, icon, accent, launch-enabled flag) directly into the served `index.html`. First visit gets correct branding at first paint with **zero extra requests**; the tab title/favicon/theme-color are branded before any JS runs. Also fix the two cache-header bugs.

### 3.1 Frontend: `frontend/src/app.html`

**(a) Add injection hooks to `<head>`:**

- After the description meta (~line 12), add:
  ```html
  <title data-wabi-brand-title>Wabi</title>
  ```
- Change the favicon link (line 5) to carry a stable marker attribute:
  ```html
  <link rel="icon" href="%sveltekit.assets%/favicon.png" data-wabi-favicon />
  ```
- Change the theme-color meta (line 11) to:
  ```html
  <meta name="theme-color" content="#0f0c29" data-wabi-theme-color />
  ```
   Note: `%sveltekit.assets%` rewrites to `/favicon.png` at build time; the marker attribute survives. The server will string-replace on the **built** forms: `href="/favicon.png" data-wabi-favicon` and `content="#0f0c29" data-wabi-theme-color`.

   Title tradeoff (accepted): browsers honor the **first** `<title>` in `<head>`, and this tag sits before `%sveltekit.head%` (app.html ~413) — so `business/+page.svelte`'s own `<title>Planner · …</title>` stops displaying once this exists. Do not "fix" that by moving the tag below `%sveltekit.head%`; that reintroduces an unbranded title flash on every page.

**(b) Add the server-brand slot at the very top of the head brand script (before the IIFE, ~line 322):**

```js
window.__WABI_SERVER_BRAND__ = /*__WABI_SERVER_BRAND__*/null;
```

The server replaces `/*__WABI_SERVER_BRAND__*/null` with a compact JSON object literal. When un-replaced (raw file hosts, Tauri, dev-vite) the value stays `null` and everything falls back to today's behavior.

**(c) Rewire brand precedence inside the IIFE.** Current logic (lines 332-410): read localStorage entry → set `__WABI_BOOT_BRAND__` → if nothing, fetch launch-page. New precedence:

1. **neutral** always comes from the localStorage entry's `useNeutralBranding` (it's the operator's per-server opt-in and must beat the injected brand);
2. brandName / logoUrl / accent come from `window.__WABI_SERVER_BRAND__` when it is an object — the server is the source of truth for its own identity — otherwise from the localStorage entry as today;
3. if **no localStorage entry at all** but the injected brand exists → use it directly (this is the first-visit fix: no fetch, no Wabi→custom swap);
4. only if the injected brand is `null` **and** no localStorage entry → keep the existing `fetch('/api/public/launch-page')` fallback exactly as-is (it remains the path for hosts serving the raw file).

Keep writing the resolved snapshot to `window.__WABI_BOOT_BRAND__` — the body script's `applyBootBrand` and its lock logic (lines 469-561) stay untouched. The lock semantics already prevent late default-Wabi snapshots from clobbering a committed custom brand.

### 3.2 Backend: brand JSON builder — `core/crates/wabi-server/src/api/public.rs`

- Make `load_frontend_metadata_policy` (line 37) `pub(crate)`.
- Add a public helper that reuses the **same field extraction** as `get_launch_page` (lines 80-165) so the two can never drift:

  ```rust
  pub fn build_boot_brand_json(policy: &Value) -> Option<String> {
      // name: policy.displayName (non-empty), icon: policy.iconUrl (non-empty),
      // accent: policy.accentColor (non-empty), launch_enabled: same boolean
      // expression as get_launch_page (launchPageEnabled || heroTitle || headline
      // || heroPrimaryCtaLabel || highlights || customCss).
      // Returns None when name AND icon AND accent are all unset (i.e. stock
      // Wabi) — caller then serves the embedded file untouched.
      // Serialize with serde_json::to_string, keys: brandName, logoUrl, accent, launchEnabled.
  }
  ```

### 3.3 Backend: injection + cache — `core/crates/wabi-server/src/main.rs` `serve_static`

- Change signature to take state: `async fn serve_static(State(state): State<Arc<AppState>>, uri: OriginalUri)`.
  The router already ends `.fallback(serve_static) ... .with_state(state)` (lines 966-979), so the extractor wires itself.
- Add a tiny HTML-escape helper (`&`, `<`, `>`, `"`, `'`) for the name/icon values — they are admin-entered strings going into HTML.
- Add to `AppState` (`state.rs`) and initialize it inside `AppState::new(...)` (`composed_index: tokio::sync::RwLock::new(None)`). Note: **no test constructs `AppState {` as a struct literal** — integration tests go through `AppState::new` (e.g. `tests/first_boot_onboarding.rs:52`; the line-46 literal there is `ServerConfig`). If a literal construction site exists by execution time, update it mechanically, but expect none.
  ```rust
  /// Composed (brand-injected) index.html, cached against admin_policies.json mtime.
  pub composed_index: tokio::sync::RwLock<Option<ComposedIndexCache>>,
  ```
  with
  ```rust
  pub struct ComposedIndexCache {
      pub policy_mtime: Option<std::time::SystemTime>,
      pub body: Vec<u8>,
  }
  ```
- Serving logic for **both paths that return index.html** — the direct hit (`path == "index.html"`) **and** the SPA-fallback branch (`StaticAssets::get("index.html")` at the bottom of `serve_static`, currently main.rs:1132-1137) used for deep links like `/channels/x`. Factor a small compose helper (e.g. `async fn composed_index_html(state) -> Vec<u8>`) and call it from both branches, keeping their headers consistent. If only the direct path is composed, deep links serve un-branded HTML and the first-visit flicker survives on every non-root navigation.
  1. `StaticAssets::get("index.html")` → `String::from_utf8` (it is our own app.html; lossy-verify with an error fallback to raw bytes).
  2. `policy = load_frontend_metadata_policy(&state.config.data_dir)`; `mtime = fs::metadata(<data_dir>/admin_policies.json).modified().ok()`.
  3. Fast path: if cache matches `(mtime, has_custom_brand)` → return cached body.
  4. Compose:
     - `brand_json = build_boot_brand_json(&policy)`; if `Some`, replace the exact token `/*__WABI_SERVER_BRAND__*/null` with ` ` + json. If the token is **missing** (stale embedded build), log a warn once and serve raw — never panic.
     - If name set: replace `<title data-wabi-brand-title>Wabi</title>` with `<title>{escaped}</title>`.
     - If iconUrl set: replace `href="/favicon.png" data-wabi-favicon` with `href="{escaped}" data-wabi-favicon`.
     - If accentColor set **and** matches `^#[0-9a-fA-F]{3,8}$`: replace `content="#0f0c29" data-wabi-theme-color` with `content="{accent}" data-wabi-theme-color`. Reject anything else (CSS injection guard).
  5. Store in cache; return with today's headers (`no-cache`, referrer-policy — keep the index-only branch at lines 1110-1114).
- **Cache-header fixes** in the same function (lines 1099-1103): the no-cache branch becomes `index.html`, `sw.js`, or `ends_with("service-worker.js")`; add a `manifest.webmanifest` / `manifest.json` branch → also `no-cache` (tiny file; rebrand-critical).
- The admin "branding updated" path: no explicit invalidation needed — mtime keying picks up changes on the next request. Note this in a comment.

### 3.4 Frontend companion: expose the flag

- In `frontend/src/lib/branding.ts`, extend `BootBrandSnapshot` (line 91) with optional `launchEnabled?: boolean` and (optional) `bannerUrl?: string` so Phase 2 can read them. No other change here.

### 3.5 Gotchas

- **Build order:** frontend build must run before `cargo build`, or the token won't exist (constraint 5). After building, sanity-grep `frontend/build/index.html` for `__WABI_SERVER_BRAND__` and `data-wabi-favicon`.
- Body script's `DEFAULT_WABI_LOGO` fallback regex (app.html ~501/539) — untouched; the injected path resolves before it matters.
- Don't add `ETag` — `no-cache` already forces revalidation; keep the header surface unchanged otherwise.
- rust_embed caches at compile time — injection is runtime string ops only. Never try to "pre-compose" at build time; the brand can change per running server without a rebuild.

### 3.6 Test

New integration test `core/crates/wabi-server/tests/boot_brand_injection.rs`, following the `first_boot_onboarding.rs` harness pattern (`test_config` + `fresh_server` with `create_api_router` + `tower::ServiceExt::oneshot`). **Problem:** `serve_static` is the fallback on the *main* router in main.rs, not in `create_api_router`. Fix properly: extract the router-with-fallback construction from `main()` into `pub fn build_app_router(state: Arc<AppState>) -> axum::Router` in main.rs (near-pure move — the layers it consumes (`rate_limit_state`, `sio_layer`, `cors`, `CompressionLayer`, timeout/metrics) are built inline across ~lines 900-979 of `main()`; move their construction into the function or pass them in — no behavior change), have `main()` use it, and have the test call it. Assert:

1. `GET /` with a temp `data_dir` whose `admin_policies.json` contains `frontend_app_metadata: {displayName: "Fort Night", iconUrl: "/uploads/x.png", accentColor: "#ff0055"}` → 200, body contains `"brandName":"Fort Night"`, `<title>Fort Night</title>`, `href="/uploads/x.png"`, `content="#ff0055"`, and `Cache-Control: no-cache`.
2. `GET /` with empty data_dir → body contains the un-replaced `/*__WABI_SERVER_BRAND__*/null` token and `<title data-wabi-brand-title>Wabi</title>`.
3. `GET /sw.js` → `Cache-Control: no-cache`. `GET /manifest.webmanifest` → `Cache-Control: no-cache`.
4. Accent injection guard: `accentColor: "red; url(javascript:1)"` → theme-color NOT replaced.
5. Cache refresh: rewrite admin_policies.json with a different displayName (mtime changes) → next `GET /` reflects it.

### 3.7 Verification

```bash
cd frontend && bun run check && STATIC_BUILD=1 bun run build
grep -c '__WABI_SERVER_BRAND__' frontend/build/index.html   # expect 1
cargo build --release -p wabi-server && cargo test -p wabi-server
# runtime: clear BOTH locks (rule 9), run the binary, then:
curl -s localhost:3001/ | grep -o '<title>[^<]*</title>'
curl -I localhost:3001/sw.js | grep -i cache-control
curl -I localhost:3001/manifest.webmanifest | grep -i cache-control
```

Visual (William): first-visit boot (fresh profile / cleared localStorage) shows the server's brand immediately — no Wabi flash, no logo swap.

**Commit:** `perf(boot): phase 1 — server-injected brand + sw/manifest cache fixes`

---

## 4. Phase 2 — Deduplicate the login-page fetch storm

**Goal:** one HTTP request per endpoint per page-load, and zero launch-page requests when the server already told us there's no launch panel.

### 4.1 Shared-request wrapper — `frontend/src/lib/api/config.ts`

Add a small module-level helper (this file already holds `getLaunchPageConfig` line 30 and `getSetupStatus` line 95):

```ts
type SharedEntry = { expiresAt: number; promise: Promise<unknown> };
const sharedCache = new Map<string, SharedEntry>();

function sharedRequest<T>(key: string, ttlMs: number, run: () => Promise<T>): Promise<T> {
	// In-flight OR fresh (< ttlMs) → return the same promise.
	// On rejection: evict the entry so a failure isn't cached.
	// Called with no args only — this is for same-origin, same-page-load dedupe.
}
```

- Route **only the local (no-baseUrl) variants** through it: `getSetupStatus()` (key `"setup-status"`, TTL 10s) and `getLaunchPageConfig()` (key `"launch-page"`, TTL 15s).
- Do **NOT** wrap `getLaunchPageConfigFrom(baseUrl)` — `savedServerActions.ts` uses it to probe *other* servers; those must never be deduped against the local one.

### 4.2 Login skip-fetch — `frontend/src/lib/components/Login.svelte`

In `onMount` (line 170):

- Read `window.__WABI_SERVER_BRAND__` (typed via the Phase 1 `BootBrandSnapshot` extension). If it is an object with `launchEnabled === false`: seed `launchPageConfig` **synchronously** from the snapshot and **skip** the `getLaunchPageConfig()` call (line 200). Seed a full `LaunchPageConfig`-compatible shape — at minimum `{ enabled: false, brandName, logoUrl, palette: { accent }, backgroundImageUrl: null }` — because the reactive chain reads `launchPageConfig.palette.accent` (~line 70) and `.enabled` (~line 52); seeding a bare snapshot leaves accent styles building from an empty palette. `showLaunchPanel` (line 52) already evaluates falsy-config correctly — verify it stays false.
- Otherwise (launch panel exists, or injected brand is null): keep the fetch (now deduped with the app.html fallback's own semantics — the app.html fetch no longer happens when injection worked, so no duplication remains).
- `getSetupStatus()` (line 205) and `+page.svelte:220` both now hit the shared wrapper → exactly one request; the setup-wizard override semantics (`+page.svelte:209-230`, server-wins-over-localStorage) are unchanged.

### 4.3 Gotchas

- `+page.svelte`'s `getSetupStatus()` call must remain (it drives `enterSetupWizard`); the dedupe happens below it in the api layer. Do not delete either call site.
- The shared cache is per page-load by construction (module state); no persistence, no cross-user leakage (responses are public endpoints).

### 4.4 Verification

`bun run check && STATIC_BUILD=1 bun run build`. Runtime with DevTools open on a fresh profile: the login page fires **one** `setup-status`, **zero** `launch-page` when the server has no launch story configured, **one** `launch-page` when it does. Returning-session boots unchanged.

**Commit:** `perf(boot): phase 2 — dedupe public-config fetches, skip launch-page when injected brand says none`

---

## 5. Phase 3 — Split the login path from the app bundle (biggest win)

**Goal:** an anonymous visitor loads only the login-sized bundle. The 2.4 MB shared chunk, the 800 KB page node payload currently entangled with it, and the 528 KB layout CSS move behind a dynamic import taken only when a session exists or login succeeds.

### 5.1 Changes — `frontend/src/routes/+page.svelte`

**(a) Remove the static import** (line 7): `import LayoutRouter from '$lib/components/LayoutRouter.svelte';`

**(b) Add lazy machinery** (module scope, plain lets — this file is legacy-syntax Svelte, don't introduce runes):

```ts
type LayoutRouterComponent = typeof import('$lib/components/LayoutRouter.svelte').default;
let LayoutRouterCmp: LayoutRouterComponent | null = null;
let layoutRouterPromise: Promise<unknown> | null = null;

function ensureLayoutRouter(): Promise<unknown> {
	if (!layoutRouterPromise) {
		layoutRouterPromise = import('$lib/components/LayoutRouter.svelte').then((m) => {
			LayoutRouterCmp = m.default;
			return m;
		});
	}
	return layoutRouterPromise;
}
```

`typeof import(...)` is fully erased at build — verify in the output that no static edge remains (§5.3).

**(c) Returning-session path** (lines 232-259): inside the `if (savedUsername && hasSession)` branch, **before** `initSocket(...)`:

```ts
void ensureLayoutRouter();
```

so the module fetch overlaps the socket connect. Then at the **end of the bootstrap IIFE**, before `isBootstrapping = false; dismissDocumentBootShell();` (lines 327-328):

```ts
startupMark('page:layout-module:await:start');
try {
	await Promise.race([
		ensureLayoutRouter(),
		new Promise((resolve) => setTimeout(resolve, 10_000)) // never trap the user on the boot shell
	]);
} finally {
	startupMark('page:layout-module:await:end');
	startupMeasure('page:layout-module', 'page:layout-module:await:start', 'page:layout-module:await:end');
}
```

The boot shell therefore stays up until the app can actually render (no blank flash), with a 10 s escape hatch that dismisses anyway (the render gate below handles a late-arriving module).

**(c₂) Reconnect path** (lines 265-288): the offline-returning-user poll's success branch sets `loggedIn = true` and dismisses the shell **without ever touching LayoutRouter**. Add `void ensureLayoutRouter();` there too (before `loggedIn = true;`, alongside the existing `initSocket(...)` at line 278) — otherwise a reconnecting user lands on the Login UI forever behind the render gate despite holding a valid session.

**(d) Login transition** — `handleLogin` (line 383): first statement `void ensureLayoutRouter();` — the download overlaps socket connect + theme init while Login stays visible and interactive.

**(e) Render gate** — replace both `<LayoutRouter ...>` usages (lines 506, 509). Outer structure becomes:

```svelte
{#if loggedIn && LayoutRouterCmp}
	{#if isInitialLoad}
		<svelte:component this={LayoutRouterCmp} accountSecurityOpenRequest={accountSecurityOpenRequest} on:logout={handleLogout} />
	{:else}
		<div transition:fade={{ duration: 300 }}>
			<svelte:component this={LayoutRouterCmp} accountSecurityOpenRequest={accountSecurityOpenRequest} on:logout={handleLogout} />
		</div>
	{/if}
{:else}
	<!-- Login path: also covers the brief loggedIn-but-module-still-loading window -->
	{#if isInitialLoad}
		<Login on:login={handleLogin} />
	{:else}
		<div transition:fade={{ duration: 300 }}>
			<Login on:login={handleLogin} />
		</div>
	{/if}
{/if}
```

Keep the existing `ConfirmDialog` blocks attached to the logged-in branch as they are today. `on:logout` forwarding through `<svelte:component>` works in legacy mode; if `bun run check` complains, switch to `on:logout` handled via a small wrapper event created with `createEventDispatcher` inside a thin local component — do not restructure further.

### 5.2 Optional stretch — drop socket.io from the pure-login path

**Only attempt after 5.1 is green, and abandon it the moment it gets messy** (explicit skip criteria below). `+page.svelte` statically imports `$lib/socket` (line 4) which drags the 850 KB socket.io chunk onto the login path.

- The bootstrap's uses (`initSocket`, `disconnect`, `joinChannel`, `getAuthToken`-adjacent) are inside async functions → convert to `const { initSocket } = await import('$lib/socket')` at the three call sites.
- The reactive uses are `$currentUser` (line 360) and `$dmPanelSignal` (line 354). `dmPanelSignal` is *defined* in `socket.ts:34` (a plain writable) and `currentUser` is re-exported from `socket-manager` but *defined* in a leaf state module. **Skip criteria:** re-importing those two stores from their definition modules (`socketConnectionState`-family) must not transitively import `socketConnectionCore`/socket.io — verify with the build chunk graph. If it does, or if check fails, revert this stretch entirely and note it in the log; 5.1 alone is the win.

### 5.3 Acceptance (must show in the build)

```bash
cd frontend && bun run check && STATIC_BUILD=1 bun run build
```

- `frontend/build/index.html` modulepreload list and `nodes/2.*.js` static imports **must not** contain the big shared chunk (formerly `DoO4lUKe.js`-class, ~2.4 MB), and layout CSS (`0.*.css`-class) must move behind the dynamic edge. The names are content-hashed per build — compare **sizes**: eager graph (entry + preloads + node 2 + eager CSS) should drop from ~4.3 MB/690 KB to well under ~1.5 MB total (exact number goes in the report).
- Login smoke (runtime, William): fresh profile → login page renders and is interactive; login → app appears without blank flash; hard reload with a session → boot shell → app.
- Run once with `localStorage.wabi_startup_profiler = 'true'` and capture the console `StartupProfile` table before/after — include in the report.

### 5.4 Gotchas

- Socket init stays ONLY here (constraint 9).
- Do not add `LayoutRouter` to any other static import graph (e.g. don't "helpfully" import it in `+layout.svelte`).
- The `transition:fade` wrappers exist to smooth auth-state flips — preserve them.
- Message-id/keying rules (golden rule 3) are untouched by this phase — no list changes.

**Commit:** `perf(boot): phase 3 — lazy LayoutRouter; login path no longer downloads the app bundle`

---

## 6. Phase 4 — Trim the logged-in first paint

**Goal:** shrink what a *logged-in* reload downloads, by moving non-first-paint surfaces and their CSS out of the eager graph.

### 6.1 CSS moves — `frontend/src/routes/+layout.svelte`

- Delete line 3 (`import '$lib/prism-theme.css';`) and line 4 (`import 'katex/dist/katex.min.css';`).
- Re-add both imports in the **message-rendering** module that actually uses them: locate the component that imports the katex *JS* (`grep -rn "from 'katex'" frontend/src/lib`) — likely the markdown/math message renderer reachable from `Chat.svelte`. Put each CSS import next to the corresponding JS usage (prism CSS next to the syntax-highlight import). If the two live in different modules, split the CSS accordingly. The effect: both stylesheets load with the Phase 3 dynamic app chunk, not at login boot.
- Acceptance: eager CSS (the layout-node CSS asset) shrinks by ~the katex+prism share (KaTeX alone declares 20 `@font-face`s today — the font *files* were already lazy, the CSS weight was not).

### 6.2 Lazy surfaces — `frontend/src/lib/components/MainLayout.svelte`

Convert to `{#if}` + dynamic import, one component at a time, in this order (biggest first, each independently verifiable):

1. `ModelViewportTab` (three.js)
2. `Settings`
3. `AdminCenterStage` (+ its css import at line 39 — move into the component)
4. `VoiceView` and `CallModal`
5. `PlannerWorkspace` (business)
6. `MapWorkspace`, `MediaAlbumsTab`, `ReaderTab`, `GalleryChannel`
7. `CallDebugPanel`, `KeepNotesView` (only if trivial)

**Keep eager:** `Chat`, `ChannelSidebar`, `ServerRail`, `RightPanel`, `VoiceLiveStrip`, `FloatingPanelHost`, `WorkspaceViewBar`, `QuickScratchpad` — first-paint surfaces.

Per-component pattern (legacy syntax to match the file):

```ts
let ModelViewportTab: typeof import('./ModelViewportTab.svelte').default | null = null;
// on first activation (the existing {#if} that already gates the tab):
{#if modelViewportOpen}
	{#if ModelViewportTab}
		<svelte:component this={ModelViewportTab} ... />
	{:else}
		<div class="lazy-panel-placeholder" aria-busy="true"></div>
	{/if}
{/if}
...
// trigger where the tab's open flag flips:
if (modelViewportOpen && !ModelViewportTab) void import('./ModelViewportTab.svelte').then((m) => (ModelViewportTab = m.default));
```

A uniform 1-line shimmer placeholder class in the component's `<style>` is enough — these are all lazily-opened panels; there is no layout shift to preserve.

**Caution — module-level side effects:** only the `.svelte` components go lazy. Utility-module imports that MainLayout uses directly (`openWhiteboardSurface`, `voiceViewOpen`, workspace-ID constants, stores) stay static — they're cheap and often carry app state. If a lazy component registers global listeners in `onMount` only, late mounting just delays registration (fine); if you find one doing top-level side-effect imports that other code depends on, leave that component eager and note it.

**Stopping rule:** this phase is a battery of independent conversions. If any single conversion makes `bun run check` unhappy in a non-obvious way, revert that one conversion, leave the rest, and log it.

### 6.3 Acceptance

- Eager graph after Phase 4 (logged-in first paint) drops meaningfully vs the Phase 3 measurement — record the number.
- Functional smoke (William): open each converted surface once after a reload — Settings, admin stage, a call, planner, map, media albums, reader, gallery, model viewport.

**Commit:** `perf(boot): phase 4 — lazy non-first-paint surfaces + katex/prism CSS off the boot path`

---

## 7. Phase 5 — Parallelize the server `init` roster

**Goal:** `init` payload built in ~1 store-RTT instead of N serial roundtrips; identical bytes on the wire.

### 7.1 Change — `core/crates/wabi-server/src/socketio/presence.rs` (lines 88-112)

Replace the serial loop (actual current code, presence.rs:88-112):

```rust
let server_members: Vec<Value> = {
	let users = state.app.wdb.list_users().await.unwrap_or_default();
	let mut views = Vec::with_capacity(users.len());
	for u in users {
		views.push(
			build_user_view(
				&state,
				u.user_id as i64,
				&u.username,
				&u.color,
				u.profile_picture.clone(),
				u.username_font.clone(),
				u.bio.clone(),
				u.status_message.clone(),
				!u.password_hash.is_empty(),
				None,
			)
			.await,
		);
	}
	views
};
```

with:

```rust
let server_members: Vec<Value> = {
	let users = state.app.wdb.list_users().await.unwrap_or_default();
	futures::future::join_all(users.into_iter().map(|u| {
		let state = &state;
		async move {
			build_user_view(
				state,
				u.user_id as i64,
				&u.username,
				&u.color,
				u.profile_picture.clone(),
				u.username_font.clone(),
				u.bio.clone(),
				u.status_message.clone(),
				!u.password_hash.is_empty(),
				None,
			)
			.await
		}
	}))
	.await
};
```

`futures = "0.3"` is already a dependency (`core/crates/wabi-server/Cargo.toml:45`). `join_all` preserves input order — the roster order is byte-identical to today. Same treatment for the `online_users` loop (lines 114-121) if it has more than a handful of entries — it's over connected users, usually small; convert only if trivial.

### 7.2 Test & verification

`cargo test -p wabi-server` (the existing socketio contract tests cover init payload shape). No wire change → no frontend change.

**Commit:** `perf(boot): phase 5 — build init roster concurrently`

---

## 8. Phase 6 — Small nits

1. **`frontend/src/routes/+layout.svelte:79-82`** — the `await import('$lib/components/loginHelpers')` for `injectNeutralBranding` is mid-boot blocking for no reason; `loginHelpers` is already statically imported on line 14. Add `injectNeutralBranding` to that import and delete the dynamic-import block.
2. **`frontend/src/routes/+page.svelte` reconnect path (lines 265-288)** — the offline-returning-user poll waits a full 3 s before its first `/api/user/me` probe. Extract the probe into a named function, call it once immediately, then keep the existing `setInterval(..., 3000)`.

**Commit:** `perf(boot): phase 6 — static loginHelpers import, immediate reconnect probe`

---

## 9. Measurement protocol (do this BEFORE starting, and after Phases 3 & 4)

Record all numbers in the Implementation Log (§11):

1. **Bundle:** `cd frontend && STATIC_BUILD=1 bun run build`, then total-bytes of eager graph = `entry/*` + every chunk listed in `build/index.html` as modulepreload + `nodes/2.*.js` + eager CSS `<link>`s. `bunx vite-bundle-visualizer` or a plain `ls -la` table is fine — just be consistent.
2. **Runtime:** with `localStorage.wabi_startup_profiler = 'true'`, hard-reload a logged-in tab and a fresh-profile login tab; screenshot both `StartupProfile` console tables.
3. **Network:** DevTools, "Disable cache" ON, hard reload — total transfer + request count for (a) anonymous login page, (b) logged-in boot. Then Disable cache OFF (warm) for both.

---

## 10. Risks & rollback

| Risk | Mitigation | Rollback |
|---|---|---|
| Brand token missing from embedded HTML (stale frontend build) | Server logs warn once, serves raw file — behavior = today | n/a (fail-open by design) |
| Phase 3 boot shell held too long (network flake) | 10 s `Promise.race` escape hatch dismisses shell regardless | Revert single commit |
| Phase 3 event forwarding through `<svelte:component>` | `on:logout` works in legacy mode; fallback plan documented in 5.1(e) | Revert single commit |
| Phase 4 lazy panel regression | One commit, but conversions are per-component — revert individual conversions, keep the rest | Per-conversion |
| AppState field addition breaks test literals | Find-all on `AppState {` — update every construction site | Mechanical |
| Injection XSS via admin strings | HTML-escape name/icon; strict hex regex for accent; test case 3.6.4 | n/a |

Every phase is one revertible commit. There is no data migration, no persistence-format change, no protocol regen.

---

## 11. Implementation log (append after each phase — executor)

Executed 2026-08-26 by ox-alpha. All phases committed; nothing pushed/deployed.

- [x] **Baseline (§9 bundle)** — pre-change eager union (`entry` + modulepreloads + `nodes/2.*` closure + eager CSS): **4,887,066 bytes / 26 files**. Big items: shared app chunk 2,410,616 B; socket.io chunk 876,562 B; page node `nodes/2.*` 825,750 B; layout CSS 540,118 B. Runtime/network DevTools captures are William's (headless can't render Wabi, rule 7).
- [x] **Phase 1** — commit `da317fb`. Router extracted into lib-visible `src/app_router.rs` (plan said "in main.rs", but integration tests link the lib target, not the bin — same construction, new home). New test `tests/boot_brand_injection.rs`: 6/6 green (branded `/` + deep link, stock untouched shell, sw/manifest no-cache, accent guard, mtime recompose, script-breakout). Full `cargo test -p wabi-server` green (131×2 unit + all integration). Release build OK.
  - **Addition beyond plan:** `build_boot_brand_json` output is additionally `\u`-escaped for `<>&` — serde_json does not escape `</script>`, which would let an admin-entered name terminate the inline boot script (found while writing tests; covered by `brand_json_cannot_break_out_of_script`).
  - **Plan correction applied:** no `AppState {` literal constructions exist in tests (they use `AppState::new`); field init went into `AppState::new`.
  - Runtime curl verification (release binary, temp data dir): stock `/` serves un-replaced token; branded config injects `<title>Fort Night</title>`, favicon, `#ff0055` theme-color, `"brandName":"Fort Night"`; deep link `/channels/x` gets the SAME composed shell; rewrite of `admin_policies.json` reflected on next request without restart; `sw.js` + `manifest.webmanifest` → `no-cache`.
- [x] **Phase 2** — commit `97e51a0`. `sharedRequest` dedupe (10 s setup-status / 15 s launch-page) wraps only local variants; `getLaunchPageConfigFrom(baseUrl)` untouched. Login seeds a full `LaunchPageConfig` shape from the injected snapshot when `launchEnabled === false`. Request-count confirmation needs DevTools (William).
- [x] **Phase 3** — commit `62a0572`. LayoutRouter behind `ensureLayoutRouter()` dynamic import; render gate `{#if !loggedIn || !LayoutRouterCmp}` login `{:else}` `<svelte:component>`; `on:logout` forwarding works in legacy mode (no wrapper needed). Reconnect paths (poll success + `wabi:work-offline`) both kick the import. Eager union after: **1,746,047 bytes / 23 files**; page node 825,750 → 37 KB; 2.41 MB chunk off the login path entirely.
  - **Deviation (goal-preserving):** the end-of-IIFE 10 s `Promise.race` await runs only when `savedUsername && hasSession` — taken literally it would have started the import for anonymous visitors too, contradicting the phase goal.
  - **§5.2 stretch SKIPPED per its own criteria:** `currentUser` is defined in `presenceStore.ts`, which statically imports `getSocket/connected` from `socketConnection.ts` → `SocketManager` from `socketConnectionCore.ts` → socket.io. `dmPanelSignal` sits in `socket.ts` behind the same manager. Re-importing either drags the 850 KB chunk; conversion gains nothing. 5.1 alone stands.
- [x] **Phase 4** — commit `d4d7081`. katex/prism CSS moved into `$lib/markdown.ts` (both JS deps live there) — eager CSS 540,209 → 510,679 B, stylesheets now ship with the dynamic app chunk. Lazy conversions in MainLayout: ModelViewportTab, Settings (bind:isOpen via `<svelte:component>` works), AdminCenterStage (+ its CSS moved into the component), VoiceView, CallModal (trigger: incoming/outgoing/in-call/group-ring/active-calls), PlannerWorkspace, MapWorkspace, MediaAlbumsTab, ReaderTab, GalleryChannel, CallDebugPanel, KeepNotesView. All check-clean; separate chunks/CSS assets confirmed in build output.
  - **Blockers noted (conversions kept, weight not yet moved):** `PlannerWorkspace` is also statically imported by `Chat.svelte`, and `ModelViewportTab` by `WorkspacePanelHost.svelte` (→ RightPanel) and `WhiteboardTab.svelte`; those static edges pin both components into the shared app-world chunk (~2.05 MB dynamic chunk, 6 small lazy sub-chunks split out so far). Follow-up: apply the same lazy pattern at those two importers.
  - Final eager union: **1,706,776 bytes / 26 files** vs baseline 4,887,066 → **−65.1%**.
- [x] **Phase 5** — commit `f2e9df7`. Serial `for u in users { build_user_view(...).await }` replaced with `futures::future::join_all` (order-preserving → identical wire bytes). `online_users` loop left serial per plan ("convert only if trivial" — it iterates connected sockets only). `cargo test -p wabi-server` green.
- [x] **Phase 6** — commit `08cf03c`. `injectNeutralBranding` added to the static `loginHelpers` import; dynamic-import block deleted. Reconnect probe extracted to `probeReconnect()` and fired immediately before the 3 s interval.
- [ ] Final runtime StartupProfile tables + network transfer counts — require a real browser (William).


---

## 12. Explicitly out of scope

- Changing the SW navigation strategy (network-first stays — freshness over offline speed for the shell).
- Client-side message caching in IndexedDB for instant-paint reloads (WabiDB client today is an outbound queue only; a read-cache is its own project).
- Dynamic/branded manifest generation (only its cache header is fixed here).
- Any terser/`minify` change (golden rule 1), any ts-rs regen (rule 4), any postcard record change (rule 5).
- Push/deploy (explicit gates only).
