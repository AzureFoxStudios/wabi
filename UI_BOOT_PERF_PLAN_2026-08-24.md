# UI BOOT PERF PLAN — 2026-08-24

Symptom: launch feels laggy; backgrounds/profile pics visibly load late ("scan-line by scan-line" PFPs).
All numbers measured from `frontend/build/_app/immutable` closure analysis + source reading today.

## Measured root causes (ranked)

### P0-A. Server sends JS uncompressed — 4.19 MB raw on the login route
- `wabi-server` has NO compression layer (`tower-http` features = cors/trace/timeout only).
- Login route eager graph: 26 files, 4.19MB — chunks `BOUAJakT.js` (2,338KB), `D70bwhn6.js` (796KB), `nodes/2.C059jXJ5.js` (786KB).
- Brotli/gzip cuts this ~4–5x. Single biggest win, zero frontend changes.
- Files: `core/crates/wabi-server/Cargo.toml`, `src/main.rs`.

### P0-B. Boot logo is a 356 KB PNG
- `app.html` boot shell + SW precache use `/wabi-logo.png` (356KB); `wabi-logo.webp` is 80KB, `-small.webp` is 4KB.
- Fix: point boot shell + precache list at an optimized asset.

### P0-C. Every load blocks first paint on `getSetupStatus()` roundtrip
- `routes/+page.svelte` awaits the API before choosing login vs auto-connect. Returning users eat a full RTT behind the boot shell every time.
- Fix: decide locally first, reconcile with server response in parallel (only force setup wizard if it says so).

### P0-D. Avatars re-download after 1h
- `serve_upload` sets `Cache-Control: private, max-age=3600`. Filenames are UUIDs (immutable content) → safe for 1-year immutable caching. Repeat boots currently refetch every avatar.

### P1-E. Profile-picture pipeline: no thumbnails anywhere
- Server stores uploads verbatim (no `image` crate, no resize). Dev-box evidence: 444KB JPEG avatar → visible progressive decode = the "scan-line" effect.
- Fix: client-side canvas downscale (avatars ≤256px, backgrounds ≤1920px, webp) at upload time in the upload/editor paths. No new Rust deps.

### P1-F. Registered users wait on theme fetch before background applies
- `initTheme.ts` always awaits server prefs for registered users even when a valid localStorage snapshot exists. Fix: apply local snapshot immediately, reconcile with server response after (stale-while-revalidate).

### P2-G. Eager heavy libs (three.js/KaTeX in boot graph)
- `MainLayout.svelte` statically imports `ModelViewportTab` (three.js path); `markdown.ts` statically imports katex. Dynamic-import both behind their usage points. Larger refactor — separate slice.

## Allowed files
- `core/crates/wabi-server/Cargo.toml`, `core/crates/wabi-server/src/main.rs`
- `frontend/src/app.html`, `frontend/static/sw.js`
- `frontend/src/routes/+page.svelte`
- `frontend/src/lib/theme/initTheme.ts`
- avatar/background upload paths (AvatarEditor / upload helpers) for client-side resize

## Forbidden
- data/, docs/, audit docs, layoutStore, socket layer, calling/*, other sessions' WIP.

## Verification gate
- `cd frontend && bun run check` (0 NEW errors; baseline 166 warnings)
- `cd frontend && bun run build` (✓ built)
- `cargo check -p wabi-server` (clean)
- Wire proof: uncompressed vs compressed size of `_app/immutable` chunks (curl --compressed against local server, or brotli CLI estimate)
- Honest labels: built ≠ deployed ≠ browser-verified. Deploy needs Ronin's explicit go.
