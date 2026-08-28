# SPA boot crash — repro + diagnosis (SEE ALSO references/terser-minify-boot-crash.md)

> **2026-07-19 CORRECTION:** The dominant cause of this symptom is NOT an app-code regression.
> It is **terser minification** in `vite.config.ts` (`minify: 'terser'` + `drop_console`) mangling
> Svelte's store runtime / circular re-export init order in the client bundle. The fix is to switch
> to esbuild minify (`minify: !process.env.TAURI_DEBUG`). Read `references/terser-minify-boot-crash.md`
> FIRST — it has the decisive unminified-vs-esbuild diagnosis and the exact fix. The bisect recipe
> below is now a LAST RESORT, not step one.

## Symptom
`STATIC_BUILD=1 bun run build` + Rust binary deploy. On load the browser tab either:
(a) sits forever on the "Starting Wabi" boot shell (full-screen `position:fixed; z-index:2147483647` overlay `#wabi-boot-shell` in `index.html`), OR
(b) the renderer CRASHES (Playwright `page.on('crash')`; `document` goes empty; `page.evaluate` returns `{}`; `pageerror` may not fire before the context dies).

`bun run dev` (SSR) and a clean `bun run check` are BOTH fine. (That clean dev/check is exactly why this hides — it is a BUILD/minifier issue, not app logic.)

## Root cause class
A client-only store-initialization bug that SSR masks. In SSR the store is created during server render; in the client-only SPA bundle a store export is `undefined` when a component uses it as `$store` → `n.subscribe is not a function` (the store-runtime chunk, e.g. `DUjf2F7D.js`) → uncaught → renderer death. The `n` is the minified store-helper arg; the real store name is hidden by minification.

## Repro that works (headless WILL die — that's the signal)
Serve the built `frontend/build` with any static server (python `http.server 8099` inside `build/`), then load `/login` headlessly. Capture `page.on('crash')`, `pageerror`, and a `window.__e` array fed by `addEventListener('error'/'unhandledrejection')` installed via `page.addInitScript`. Poll `window.__e` every 500ms and break as soon as it's non-empty (the page dies fast — the error is usually gone before a 6s wait). With the real API succeeding (or mocked `{"setupRequired":false}`), the tab dies. With the API 404ing, boot stalls on the shell but does NOT crash — confirms the crash is in the render path AFTER `getSetupStatus()` resolves.

## Why normal debugging fails here (write this down)
- **Headless tab death** prevents error capture. Don't trust "no pageerror captured" as "no bug" — the page may have died.
- **`rg`/search_files output is REDACTED** in this environment: import statements and some identifiers come back as `n` (same redactor that corrupts secret-like var names via write_file/patch). Grep-based trace of cycles/imports is UNRELIABLE. Read suspect files directly with read_file.
- Disabling SSR in dev via a temp `src/routes/+layout.ts` (`export const ssr = false`) does NOT cleanly reproduce: dev's dynamic module loading differs and you get MIME-type 404s on `nodes/*.js` instead of the real crash. Remove that temp file after.
- Build with `prerender = true` also won't mirror it (dev module loading differs from the prod Rollup bundle).

## Bisect recipe (LAST RESORT — only if unminified ALSO crashes)
If `TAURI_DEBUG=1 STATIC_BUILD=1 bun run build` (unminified) STILL crashes/sticks, then it really is
app code, not the minifier. Only then:

## Boot shell mechanics (so you know what "stuck on Starting Wabi" means)
- `index.html` has `<div id="wabi-boot-shell">` (the spinner) + an inline `<script>` that defines `window.__hideWabiBootShell` / `window.__enterReconnectMode` and listens for `wabi:boot-hide` / `wabi:boot-reconnect` (once each).
- SvelteKit mounts the app into a sibling `<div style="display:contents">`. After hydration `+page.svelte`'s boot `onMount` async IIFE calls `dismissDocumentBootShell()` (which dispatches `wabi:boot-hide`) → shell fades + removes.
- If that IIFE never reaches the dismiss (crashes, or `getSetupStatus()` 502-hangs the await), the shell stays forever → "asinine login".
- The `Work Offline` / `Reconnecting…` state shows when `+page.svelte` boot sees `localStorage.wabi_has_logged_in === 'true'` but no valid token → it dispatches `wabi:boot-reconnect` → shell switches to reconnect mode and waits (stuck if reconnect fails). Clearing `wabi_has_logged_in` + wabi.* auth keys unblocks a returning browser.

## Don't
- Don't abandon adapter-static for adapter-node "because SPA crashes" — adapter-node has no top-level `index.html` and the Rust `serve_static` SPA-fallback needs `index.html`. It would 404. Switch the minifier (esbuild), not the adapter.
- Don't deploy a temp `+layout.ts` with `ssr = false` — leave it in and SSR breaks permanently. Remove it.
