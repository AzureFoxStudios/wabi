# Wabi Mobile — PWA then Tauri Android

**Locked split:** Phase 1 = PWA. Phase 2 = Tauri Android. No iOS native.

**Plan SoT:** this file. End-state: `docs/proposals/wabi-mobile-endstate.md` (restore if missing).

## Phase 1 — PWA acceptance

- [ ] Installable on Android Chrome
- [ ] In-app install banner when BIP fires
- [ ] SW push + notificationclick deep-link
- [ ] Server `/api/push/*` VAPID + subscribe + test
- [ ] Bottom nav: Chat · Browse · Messages · You
- [ ] Settings → Background push controls
- [ ] Redmi verify in real Chrome

## Phase 1 status (2026-08-08)

**Landed (frontend):**
- `frontend/src/lib/pwa/*` — platform, installPrompt, pushClient, deepLink
- `InstallAppBanner.svelte`
- `sw.js` push + notificationclick
- SW version bump → 9
- `+layout.svelte` install capture + SW nav
- `MainLayout` 4-tab mobile nav + back handling
- Notifications settings push UI
- i18n browse/messages/you

**Still needed:**
- Server Web Push (`api/push.rs`, `push_store.rs`, VAPID, cargo deps) — was wiped mid-session by concurrent peer; re-add
- Deploy + Redmi smoke
- Phase 2 Tauri Android only after P1 gates

## Phase 2 — Tauri Android (later)

- `tauri android init`, APK, native notify adapters, server URL model
- See end-state doc

## Peer collision note

Another Hermes session wiped uncommitted mobile files mid-work once. Re-verify `ls frontend/src/lib/pwa` and `rg openMobileChat MainLayout` before trusting status.
