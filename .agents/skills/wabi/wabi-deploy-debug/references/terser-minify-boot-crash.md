# Terser minification breaks the SPA boot (root cause of "stuck on Starting Wabi" / `n.subscribe is not a function`)

Found 2026-07-19 while debugging a Wabi deploy where the login page sat forever on the
"Starting Wabi" boot shell (and headless Chromium's tab died). Initially mis-diagnosed as a
client store bug / app-code regression and a wild-goose-chase bisect — the real cause was the
build minifier.

## Symptom
- `STATIC_BUILD=1` SPA deploys to the Rust `wabi-server` (rust_embed serves `frontend/build`).
- On load: boot shell `#wabi-boot-shell` never hides → user stuck on "Starting Wabi" / "Work Offline".
  In headless Chromium the tab can crash (`page.on('crash')`, empty document). In a real browser it
  usually just sits stuck (no visible JS error).
- Console may show `n.subscribe is not a function` (store runtime `Pt(n,t,e)` called with undefined store).
- Dev server (`bun run dev`, SSR) and `bun run check` are both CLEAN. This is what hides the cause.

## Root cause
`frontend/vite.config.ts` had:
```ts
minify: !process.env.TAURI_DEBUG ? 'terser' : false,
terserOptions: { compress: { drop_console: !process.env.TAURI_DEBUG } },
```
Terser's `compress` pass (especially with `drop_console`) mangles Svelte's store runtime and the
multi-hop re-export chain (`+page.svelte` -> `socket.ts` -> `socket-manager.ts` -> `*Store.ts`). In the
client-only SPA bundle a store used as `$store` ends up `undefined` at module-init -> `n.subscribe is
not a function` -> the boot `async` IIFE in `+page.svelte` dies before `dismissDocumentBootShell()`
(line ~322) dispatches `wabi:boot-hide`. SSR/init order differs, so dev/SSR never hits it.

## Decisive diagnosis (run this BEFORE touching app code)
```bash
cd /var/home/Ronin/wabi/frontend

# 1) Unminified SPA — if this boots clean, terser is the culprit
TAURI_DEBUG=1 STATIC_BUILD=1 bun run build
# serve build/ on :8099, load in headless -> expect 0 pageerror, no crash

# 2) esbuild-minified SPA (the fix) — confirm it also boots clean
STATIC_BUILD=1 bun run build      # vite.config minify:true => esbuild
# serve build/ on :8099, load in headless -> expect 0 errors

# 3) (for contrast) terser-minified reproduces the crash — do NOT ship this
```
Headless state capture that works (no minified `page.evaluate` race): capture `pageerror` + `crash`
over ~8-10s; if unminified yields 0 errors while the original terser build crashes, the minifier is proven guilty.

## The fix
`frontend/vite.config.ts`:
```ts
build: {
  target: isTauri ? 'ES2021' : ['ES2020','edge88','firefox78','chrome87','safari13.1'],
  minify: !process.env.TAURI_DEBUG, // esbuild minify; terser broke Svelte store runtime in SPA client bundle
  // (drop the terserOptions block — inert once terser isn't the minifier, and it was the thing breaking the app)
},
```
Then rebuild the release binary so rust_embed picks up the fixed frontend:
```bash
STATIC_BUILD=1 bun run build && cargo build --release -p wabi-server
```
Deploy (stop -> rm BOTH locks -> swap binary -> up) and verify login reaches the form.

## Why the first pass went wrong (so the next session doesn't)
- Assumed "SPA crash = app-code regression" and started a `git bisect` of overnight code. The pre-overnight
  anchor ALSO "crashed" in the flaky headless harness, which should have been the tell that it wasn't code.
- The headless tab death makes error capture unreliable — don't trust "no pageerror captured" as "no bug".
- `rg`/search_files output is redacted in this env (imports -> `n`); `terminal grep -n` is NOT redacted.
- Building unminified is the single highest-signal step: a clean unminified boot = minifier bug, full stop.
