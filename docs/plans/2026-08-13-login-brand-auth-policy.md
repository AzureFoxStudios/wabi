# Login + Brand + Auth-Policy Plan

> **Goal:** Host decides the shape of its server. Users just hit whatever that host is.
> One client, multiple host shapes. No central account. No drag-and-drop form editor.

## What changes

1. **Brand is real and origin-aware.**
   - Backend advertises a brand profile (`brandProfile`) plus legacy fields.
   - Launch page actually turns on when branding exists (`enabled` is not hardcoded `false`).
   - Boot + login chrome come from that profile, not from “last connected server.”
   - First visit to an unknown origin does not flash Wabi; it stays pending and asks the host.

2. **Auth is policy-driven, not a pile of forms.**
   - Host picks a mode: `open` / `invite` / `verified` (and whether guests are allowed).
   - Client fetches that policy and renders the matching steps.
   - Open: handle + password, like any site.
   - Invite: same card plus a passcode/link field.
   - Verified: optional email factor when the host actually configured SMTP.
   - OIDC/TOTP are optional factors, never the default, never the identity.

3. **Setup asks the owner one question, not a form builder.**
   - “Who can join this server?” → Open / Invite only / Open + email verify
   - “Allow guest access?”
   - “Strip Wabi branding?”
   - Later: admin panel edits the same policy.

## Non-goals

- Do not replace handle + password as the identity core.
- Do not build a drag-and-drop login form editor.
- Do not make email/OIDC/TOTP the default.
- Do not invent a central account system.
- Do not fork `Login.svelte` into multiple products.

---

## Phase 1 — Brand actually works and is origin-aware

### 1.1 Backend: add `brandProfile` to public metadata
**Files:**
- `core/crates/wabi-server/src/api/admin.rs`
- `core/crates/wabi-server/src/api/public.rs`

- Add `brandProfile: Option<String>` to `FrontendAppMetadataPolicy`.
- Persist it in `admin_policies.json` under `frontend_app_metadata`.
- In `get_launch_page()`, include `brandProfile` in the JSON when set.
- Keep legacy fields (`displayName`, `iconUrl`, `bannerUrl`, `accentColor`, `description`, `tagline`, `launchPageFallbackEnabled`) so old frontends still work.

**Verification:**
- `curl /api/public/launch-page` returns `brandProfile` when set.
- `admin_policies.json` contains `frontend_app_metadata.brandProfile`.

### 1.2 Backend: stop hardcoding `enabled: false`
**File:** `core/crates/wabi-server/src/api/public.rs`

- `get_launch_page()` should set `enabled: true` when there is a real brand:
  - `brandProfile` is set, **or**
  - legacy branding fields are non-empty/non-default.
- Otherwise `enabled: false`.

**Verification:**
- With branding set, `enabled` is `true`.
- With no branding, `enabled` is `false`.

### 1.3 Frontend: brand resolver reads `brandProfile`
**Files:**
- `frontend/src/lib/branding.ts`
- `frontend/branding/types.ts`

- Add a resolver that turns `brandProfile` id into a `BrandConfig`-like shape.
- Default remains hardcoded Wabi; neutral remains the strip-Wabi fallback.
- `brandProfile` drives boot logo, login chrome, palette, custom CSS, and optional boot sequence.

**Verification:**
- In dev, set `brandProfile` to a known id; login card uses that profile’s palette/logo.

### 1.4 Boot shell: key brand by origin, not “last connected”
**File:** `frontend/src/app.html`

- The inline head script already reads `localStorage wabi.savedServers.v1`.
- Change it to prefer the entry matching `window.location.origin` when present.
- If the current origin has no cached brand, do **not** paint Wabi.
  - Leave boot in `pending`.
  - Let the app fetch public metadata for this origin and apply with `force`.

**Verification:**
- Open a branded server URL with no saved servers.
- Boot does not show the Wabi logo; it stays pending until the host responds.

### 1.5 First visit: fetch public brand before painting Wabi
**Files:**
- `frontend/src/app.html`
- `frontend/src/lib/savedServerActions.ts`

- On unknown origin, do a tiny early fetch for:
  - `/api/public/launch-page`
  - `/api/public/frontend-app-metadata`
- On response, cache the brand under the origin key and apply with `force: true`.
- This replaces the “last connected” heuristic for first visits.

**Verification:**
- Clear localStorage, load a known-branded server.
- Boot paints that server’s brand, not Wabi.

### 1.6 Cache brand per-origin
**Files:**
- `frontend/src/lib/savedServerStore.ts`
- `frontend/src/lib/savedServers.ts`

- Store a `brandCacheByOrigin` map alongside saved servers.
- `refreshSavedServerMetadata` writes to it.
- Boot script reads from it so Server A and Server B do not bleed brands.

**Verification:**
- Connect to Server A (red brand), then Server B (blue brand).
- Each origin boots in its own color.

---

## Phase 2 — Auth policy advertised by the host

### 2.1 Backend: add auth policy to admin policies
**File:** `core/crates/wabi-server/src/api/admin.rs`

Add a policy struct roughly like:

```rust
pub struct AuthPolicy {
    pub mode: AuthMode,        // open | invite | verified
    pub allow_guest: bool,
    pub allow_register: bool,
    pub invite_only: bool,
    pub email_verify_required: bool,
    pub oidc_providers: Vec<OidcProvider>,
    pub totp_required: bool,
}
```

- Persist it in `admin_policies.json` under `auth_policy`.
- Keep it separate from branding; they compose in the client.

**Verification:**
- `cat data/admin_policies.json` shows `auth_policy`.

### 2.2 Backend: expose auth policy publicly
**File:** `core/crates/wabi-server/src/api/public.rs`

- Add `GET /api/public/auth-policy`.
- Return the policy without secrets.
- Frontend calls this unauthenticated.

**Verification:**
- `curl /api/public/auth-policy` returns `mode`, `allowGuest`, etc.

### 2.3 Backend: enforce invite mode on register
**File:** `core/crates/wabi-server/src/api/auth.rs`

- In `handle_register`, if policy is invite-only, require a valid invite code.
- Return `403` with `error: "invite_required"` if missing/invalid.

**Verification:**
- Invite mode on, register without code → 403.
- Invite mode on, register with valid code → 200.

### 2.4 Backend: enforce guest policy
**File:** `core/crates/wabi-server/src/api/auth.rs`

- In `handle_guest`, check `auth_policy.allow_guest`.
- If false, return `403`.

**Verification:**
- `allowGuest: false` → guest login fails.

---

## Phase 3 — Policy-driven login shell

### 3.1 Shared: define login step contracts
**File:** `shared/loginPolicyContracts.ts`

```ts
export type AuthMode = 'open' | 'invite' | 'verified';
export interface AuthPolicy {
  mode: AuthMode;
  allowGuest: boolean;
  allowRegister: boolean;
  inviteOnly: boolean;
  emailVerifyRequired: boolean;
  oidcProviders: Array<{ id: string; name: string; clientId: string }>;
  totpRequired: boolean;
}
export interface LoginStep {
  kind: 'credentials' | 'invite' | 'email_code' | 'oidc' | 'totp' | 'guest';
  required: boolean;
}
```

### 3.2 Frontend: `Login.svelte` fetches policy and renders steps
**File:** `frontend/src/lib/components/Login.svelte`

- On mount, fetch `/api/public/auth-policy`.
- Build a vertical step list:
  - `open` + `allowRegister`: credentials form (username, password, handle)
  - `invite`: credentials + invite code field
  - `verified`: credentials + email code field when email is configured
  - `oidc`: “Continue with …” buttons only if providers are present
  - `totp`: 6-digit field after password when required
  - `guest`: guest name form only if `allowGuest`
- Render as one form with conditional fields, not tabs.

**Verification:**
- Invite mode shows invite code input.
- Open mode does not.

### 3.3 Frontend: register handler sends policy-required fields
**Files:**
- `frontend/src/lib/api/auth.ts`
- `frontend/src/lib/components/Login.svelte`

- Extend `register()` to accept optional `inviteCode`, `email`, `oidcToken`.
- Pass them through from the form.
- Backend `handle_register` accepts and validates them.

**Verification:**
- Register with invite code succeeds when policy allows.

### 3.4 Frontend: keep “forgot password” hidden until recovery exists
**File:** `frontend/src/lib/components/Login.svelte`

- Gate on real recovery, not on policy alone.
- Until email recovery exists, never show it.

**Verification:**
- No “forgot password” link in any mode.

---

## Phase 4 — Setup wizard for the host owner

### 4.1 Setup asks registration style
**File:** wherever the first-owner setup flow lives today

After first owner creation, ask:

1. “Who can join this server?” → Open / Invite only / Open + email verify
2. “Allow guest access?” → Yes / No
3. “Strip Wabi branding?” → Yes / No

Save answers to `admin_policies.json`:
- `auth_policy`
- `frontend_app_metadata.brandProfile` / neutral flag

**Verification:**
- Fresh server setup writes `auth_policy` to disk.

### 4.2 Admin panel edits auth policy
**File:** existing admin workspace

- Add an “Access” tab with the same questions.
- Persist via the existing admin API.

**Verification:**
- Toggle invite mode in admin; login card updates on next visit.

---

## Phase 5 — Invite system

### 5.1 Invite model
**Files:**
- `core/crates/wabi-server/src/state.rs`
- `core/crates/wabidb/src/domain/mod.rs`

Invite:
- `code`
- `created_by`
- `max_uses`
- `use_count`
- `expires_at`
- optional `channel_id`

Store in `data/invites.json` or WabiDB.

### 5.2 Invite minting API
**File:** `core/crates/wabi-server/src/api/admin.rs`

- `POST /api/admin/invites` creates a code.
- `GET /api/admin/invites` lists them.
- Require owner/admin auth.

### 5.3 Invite validation on register
**File:** `core/crates/wabi-server/src/api/auth.rs`

- `handle_register` checks invite code against store.
- Increments `use_count`.
- Rejects if expired or over `max_uses`.

### 5.4 Join-by-link route
**File:** `core/crates/wabi-server/src/api/public.rs`

- `GET /join?code=XYZ` returns a small page or redirect with the code embedded.
- Frontend `/join` route reads the query param and pre-fills the invite field.

**Verification:**
- `/join?code=abc123` opens login with invite code pre-filled.

---

## Phase 6 — Optional factors (email, OIDC, TOTP)

### 6.1 User identity: add email + factors
**Files:**
- `core/crates/wabidb/src/domain/mod.rs`
- `core/crates/wabidb/src/engine/wabi_store.rs`

- Add `email: Option<String>` to `User`.
- Add `email_verified: bool`.
- Add a factors table for TOTP/OIDC links.

### 6.2 SMTP config
**Files:**
- `core/crates/wabi-server/src/config.rs`
- `core/crates/wabi-server/src/state.rs`

- Add `smtp` section to server config.
- Only required if the host enables email factors.

### 6.3 Email verify flow
**File:** `core/crates/wabi-server/src/api/auth.rs`

- `POST /api/auth/send-email-verification` sends a code.
- `POST /api/auth/verify-email` checks it.
- Gate registration completion on `email_verify_required` when enabled.

### 6.4 OIDC link flow
**File:** `core/crates/wabi-server/src/api/oauth.rs` (new)

- Standard OIDC authorize/callback.
- On success, find or create local user, link `oidc_sub` to user.
- Frontend “Continue with …” button only appears if `auth_policy.oidc_providers` is non-empty.

### 6.5 TOTP enrollment
**File:** `core/crates/wabi-server/src/api/auth.rs`

- `POST /api/auth/totp/enable` returns secret.
- `POST /api/auth/totp/verify` validates.
- Require TOTP on login if `totp_required` is true.

---

## Execution order

1. Phase 1 — brand actually works and is origin-aware.
2. Phase 2 — auth policy advertised by the host.
3. Phase 3 — policy-driven login shell.
4. Phase 4 — setup wizard for the host owner.
5. Phase 5 — invite system.
6. Phase 6 — optional factors, only for hosts that opted in.

## Verification checklist

- [ ] New origin boots in its own brand, never Wabi, even with empty localStorage.
- [ ] Returning origin uses cached brand; no network flash.
- [ ] `curl /api/public/auth-policy` returns the host’s mode.
- [ ] Open server: register with handle + password, no extra fields.
- [ ] Invite server: register without code fails; with code succeeds.
- [ ] Guest server: guest button works. Guest-disabled server: guest button hidden/disabled.
- [ ] Setup wizard writes `auth_policy` and `brandProfile` to `admin_policies.json`.
- [ ] Admin panel can toggle modes without restart.
- [ ] `/join?code=...` pre-fills invite field.
- [ ] Email/OIDC/TOTP buttons only appear when the host configured them.
