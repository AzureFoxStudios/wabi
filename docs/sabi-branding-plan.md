# Sabi Branding Plan — Boot + Login (no default deletion)

Goal: prove self-hosters can plug in their own server branding. Add a new cohesive **Sabi** identity with a boot screen and a branded login, while keeping the current default untouched.

---

## Current state

- Login is `frontend/src/lib/components/Login.svelte`.
- Launch/hero content is `frontend/src/lib/components/login/LaunchPanel.svelte`.
- Login styles are in `frontend/src/lib/components/login.css`.
- Brand metadata comes from `/api/public/launch-page`, sourced from `admin_policies.json` via Rust (`core/crates/wabi-server/src/api/public.rs`).
- No real “boot screen” exists yet. “Boot” experience is really just launch-page branding.

Problem: branding is welded into single-name fields, not profile-based. We need a first-class profile system so a self-hoster can swap in Sabi without editing core UI.

---

## Plan

### 1. Backup default assets

Copy current untouched baseline into frontend scratch space so we can diff/revert if needed:

- `frontend/src/lib/components/Login.svelte`
- `frontend/src/lib/components/login.css`
- `frontend/src/lib/components/login/LaunchPanel.svelte`
- `frontend/src/lib/components/loginHelpers.ts`

Destination: `frontend/backups/default-login/`

Rule: do not modify the originals in this step.

---

### 2. Branding contracts/types

Add `frontend/branding/types.ts` with a stable contract for a profile:

- id
- brandName
- logoUrl / bannerUrl
- palette: background top/bottom, card, accent, text
- headline, subheadline, footerNote
- customCss
- bootSequence: brand copy and timing/motion hinting

This becomes the shared schema used by admin policy, resolver, and components.

---

### 3. Brand profiles

Add two profiles under `frontend/branding/`:

- `default.ts`: mirrors today’s hard-coded Wabi branding so when no profile is set, behavior is unchanged.
- `sabi.ts`: a complete Sabi theme with dark amber/teal palette, custom login motion, boot copy/styles, and no “wabi … loading” strings.

Make each profile self-contained and copy-pasteable. A self-hoster should be able to add a new theme by cloning `sabi.ts`.

---

### 4. Branding resolver/loader

Add `frontend/src/lib/branding.ts`:

- reads active `brandProfile` and palette from public config
- resolves active profile at runtime
- exposes `activeBrand`, `bootConfig`, and `injectCustomCss()`
- no UI changes yet

This replaces the current assumption that “Wabi” is the only identity.

---

### 5. Brand-aware login

Update `frontend/src/lib/components/Login.svelte` to consume `activeBrand`:

- logo, brandName, palette, hero/banner, headline, subheadline, footer, customCss
- keep auth flow, register/login/guest identical
- preserve default Wabi when profile is missing

Hard-coded “Wabi” text falls back to the active brand name.

---

### 6. Boot screen component

Add `frontend/src/lib/components/branding/BootScreen.svelte`:

- uses the active brand profile’s boot sequence
- shows brand name, accent pulse/progress, optional copy
- short duration, then fades out
- coheres visually with login via shared palette and `customCss`
- Sabi gets a distinct non-Wabi identity

---

### 7. App entry gate boot → login transition

Wire BootScreen into the app entry layer so first paint is boot, then transitions to login. Use the same `activeBrand` so boot+login are locked visually.

Do not change route structure or auth dispatch shapes.

---

### 8. Backend persistence for branding

Extend:

- `shared/adminPolicyContracts.ts` — add `brandProfile` and palette object shape
- `core/crates/wabi-server/src/api/public.rs` — include `brandProfile` and full palette in `load_frontend_app_metadata` and `get_launch_page`

Keep all previous fields backward-compatible. Default behavior stays intact when fields are missing.

---

### 9. Admin UI

Update `frontend/src/lib/components/admin/FrontendMetadataPanel.svelte`:

- Brand Profile selector: `default` | `sabi` | future
- palette fields, logo/banner uploads
- preview pane showing boot + login at the same time
- save path should not break existing metadata schema

---

### 10. Self-host docs + smoke-test

Add `BRANDING_SELFHOST.md`:

- how to add a new profile, required exports
- asset paths and previewing options
- swapping via admin UI without deep code changes
- verification checklist

Smoke-test sequence:

1. build
2. pick Sabi in admin → reload → boot + login both show Sabi branding with no Wabi strings
3. switch back to default → reload → default untouched, no Sabi residue

---

## Acceptance criteria

- Default login and launch are unchanged when brandProfile is missing/default.
- Sabi has a distinct boot screen and login identity.
- No “wabi loading” etc. in Sabi paths.
- A self-hoster can add another profile by copying `sabi.ts` shape.
- Admin can switch profiles from settings without code edits.
