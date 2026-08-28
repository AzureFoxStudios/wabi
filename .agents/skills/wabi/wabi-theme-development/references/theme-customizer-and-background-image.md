# Theme Customizer seeding + Chat Background Image (2026-08-23)

Session findings on the Customize flow and background image uploads. Both surfaces
look finished but have gaps that only show at runtime.

## 1. Customizer must seed from the ACTIVE palette, not hardcoded purple

`frontend/src/lib/components/ThemeCustomizer.svelte` initializes its editor state
from a hardcoded Nebula-purple palette (`#0f0c29`, `#1a1a2e`, `#ff00ff`, …):

- `customColors` defaults (top of `<script>`)
- `customGradients` defaults
- `panelColors` / `PANEL_META` solidDefaults

**Ronin's requirement:** when the user hits Customize while on e.g. Synapse, the
editor should start from Synapse's values so there is "less overall work to be
done when starting" — not from scratch on purple.

Fix shape:
- Import `ALL_PALETTES` (or a lookup helper) from `frontend/src/lib/theme/palettes.ts`.
- In the existing reactive init block (`$: if ($themeStore.themeId === 'custom' && $themeStore.customTheme)`),
  also handle `themeId !== 'custom'`: resolve the active `BasePalette` by id and map
  it into `customColors`/`customGradients` seeds:
  - `bgSunken` → `bgPrimary`, `bgBase` → `bgSecondary`, `bgRaised` → `bgTertiary`
  - `textPrimary/textSecondary/textMuted` → `textPrimary/textSecondary/textTertiary`
  - `accent` → `accent`+`accentHex`+`accentRgb` (hexToRgb), derive `border` from bgRaised darkened
  - gradients built from the same hexes (`linear-gradient(to right, …)`)
  - panel solidDefaults per-panel seeded from the palette's bg values
- Only reseed when entering customize with no saved customTheme; once a
  customTheme exists, the saved values win (current reactive block behavior).

## 2. BackgroundImageEditor calls an endpoint that does not exist

`frontend/src/lib/components/BackgroundImageEditor.svelte:73` POSTs multipart
field `backgroundImage` to `/api/upload-background-image`. **No such route exists
anywhere in the Rust backend** — the server 404s via the rust_embed SPA fallback,
so the browser shows a plain 404 and the editor shows "Upload failed".

Everything ELSE in the flow works: response contract expected is
`{ success: true, backgroundImageUrl: "/uploads/<uuid>.<ext>" }`; the URL is then
persisted inside `custom_theme.backgroundImage` via `saveThemePreferences`
(server-side theme prefs already round-trip this fine). Only the file receiver is
missing.

Fix shape (backend, `core/crates/wabi-server/src/api/upload.rs`):
- Add `.route("/background-image", post(upload_background_image))` in `routes()`
  → mounted as `/api/upload/background-image` (see `api/routes.rs` nest).
  Update the Svelte fetch URL to match.
- Copy the `upload_group_avatar` handler pattern: `AuthUser`, reject guests,
  validate png/jpeg/gif/webp ≤10MB, UUID filename under `state.config.uploads_dir`,
  record in `upload_registry` (UploadKind), return JSON.
- No DB persistence needed beyond the registry — the URL rides in theme prefs.

## Diagnostic note

A frontend fetch to `/api/<thing>` returning **404 with no matching route string
anywhere under `core/crates`** means the endpoint was never implemented — check
with `grep -rn "<route-name>" ~/wabi/core/crates --include=*.rs` before assuming a
regression. The rust_embed SPA fallback converts API misses into ordinary-looking
404s.
