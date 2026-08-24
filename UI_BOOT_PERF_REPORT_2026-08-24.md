# UI BOOT PERF REPORT — 2026-08-24

Plan: `UI_BOOT_PERF_PLAN_2026-08-24.md`. All fixes **implemented + build-verified + wire-probed**.
Not deployed (needs explicit go). Not yet eyeballed in a real browser.

## What was actually wrong (measured)

| # | Cause | Effect you could see |
|---|-------|----------------------|
| 1 | Server sent ALL JS uncompressed | Login route shipped **4.19MB** raw JS; multi-second parse/download |
| 2 | Boot shell logo = 356KB PNG (685px) | Boot spinner image itself slow on cold cache |
| 3 | Every boot blocked first paint on `getSetupStatus()` roundtrip | Full API RTT behind the boot shell before ANYTHING rendered |
| 4 | `/uploads/*` cached only 1h (`max-age=3600`) | Avatars/backgrounds re-downloaded after an hour → "scan-line" progressive decode every boot+1h |
| 5 | No thumbnails anywhere — server stores uploads verbatim | 444KB JPEG avatar decoded line-by-line in the browser |
| 6 | Registered users waited on server theme fetch before background applied | Background painted late even when identical prefs were in localStorage |

## Fixes applied

| Fix | Files | Proof |
|-----|-------|-------|
| CompressionLayer (br+gzip) | `core/crates/wabi-server/Cargo.toml`, `src/main.rs` (+Cargo.lock) | Live probe: 2,338KB chunk → **750KB gzip / 746KB brotli** on the wire; `content-encoding: br` confirmed |
| Boot logo 356KB→20KB webp | `frontend/static/wabi-logo-boot.webp` (new), `src/app.html`, `static/sw.js`, `lib/branding.ts`, brand-classifier regex | `curl /wabi-logo-boot.webp` → 200, 19,852B, image/webp |
| Non-blocking setup check | `routes/+page.svelte` | Local decision immediately; server still forces setup wizard async if fresh DB |
| Immutable upload caching | `core/crates/wabi-server/src/main.rs` | Live probe: `cache-control: private, max-age=31536000, immutable`; revocation still returns 410 before cache matters; SW logout purge unchanged |
| Client-side downscale | `frontend/src/lib/imageResize.ts` (new), `profilePictureUpload.ts` (256px cap), `BackgroundImageEditor.svelte` (1920px cap, images only) | GIF/video/SVG pass through untouched; skips re-encode when it wouldn't shrink |
| Theme stale-while-revalidate | `frontend/src/lib/theme/initTheme.ts` | Local snapshot paints instantly; server reconciles after; snapshot refreshed each boot |

## Gates

- `bun run check`: **0 errors**, 166 warnings (= baseline, zero new)
- `STATIC_BUILD=1 bun run build`: ✓ built
- `cargo check -p wabi-server --features addons`: ✓ clean (57 pre-existing warnings)
- `cargo build -p wabi-server --features addons`: ✓
- Live server probes (port 3987): compression encodings, new cache header, new logo asset, setup-status all verified; test server killed, test data dir removed

## Honest labels

- **Implemented + built + wire-probed**: everything above.
- **Deployed**: NO — Tim deploy is gated on your explicit go.
- **Browser-verified**: NO — headless Chromium can't render Wabi (Skia); needs your hard-refresh eyeball.
- **Deferred (P2-G)**: eager three.js/KaTeX in the boot chunk (~3MB raw before compression, ~800KB compressed). Real win but a bigger refactor (dynamic-import ModelViewportTab + markdown katex). Next slice.
- Note: repeat boots will also feel faster simply because previously-uncompressed JS now arrives 3.4–5x smaller AND gets HTTP-cached.

## Tree notes

- Mine: the 11 files above (+ new `wabi-logo-boot.webp`, `imageResize.ts`).
- NOT mine (concurrent sibling/peer session, do not stage with these): `core/addons/lore/backend/src/lib.rs`, `core/crates/wabi-server/src/api/lore.rs`.
