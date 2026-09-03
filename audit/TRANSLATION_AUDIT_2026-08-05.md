# Wabi Translation & i18n — Audit & Plan

Date: 2026-08-05
Status: Plan approved for documentation; implementation deferred.

This document audits Wabi's multi-language capabilities in two areas — (A) the
app's UI language (i18n) and (B) message translation (translator-assist) — and
records the agreed plan. No code was changed as part of this pass.

---

## A. App language switching (UI i18n)

### Current state — works, partially covered

Infrastructure (`frontend/src/lib/i18n/index.ts`, svelte-i18n):

- Two locales registered: `en` and `es`.
- Both files hold 501 keys with **100% key parity**; `bun run check:i18n`
  passes (script: `frontend/scripts/check-i18n.mjs`).
- ~96% of `es.json` values are actually translated (18 of 501 values are
  intentionally identical to `en`, e.g. "On", "Off", "Add-ons", "Emojis").
- Language switcher exists in Login (`Login.svelte:295`) and Settings
  (`Settings.svelte:304`); preference persists to `localStorage['wabi_locale']`.
- Contributor guide exists: `audit/TRANSLATION_GUIDE.md`. Adding a language =
  copy `en.json` + register in `index.ts`.

### Gaps

1. **Coverage is low**: only 53 of 244 components import `$lib/i18n`.
   - Entire `business/` workspace is hardcoded English (20 components:
     calendar, kanban, projects, diary, sprints).
   - Hardcoded English in `MessageActionsBar.svelte`, `ChannelSidebar.svelte`,
     and 9 of 10 `settings/addons/` sections.
   - Residual hardcoded labels even in translated components (e.g. Login
     `aria-label="Language"`, Translator Assist settings text).
2. **No browser-locale auto-detect** — always defaults to `en` on first visit.
3. **No server-side locale persistence** — language does not follow the user
   across devices.
4. Minor quality nits in `es.json` (e.g. "Configuracion" missing accent).

---

## B. Message translation (translator-assist) — broken end-to-end

Frontend UI exists and is wired:

- Context-menu "Translate" item (`MessageContextMenu.svelte:91`,
  `MessageListOverlays.svelte:105`).
- Per-message inline translated overlay (`MessageList.svelte` →
  `message/MessageContent.svelte` via `translatedText`).
- Translator settings logic in `components/message/messageTranslator.ts`.

But three things make the feature dead:

1. **Backend proxy route does not exist.** With default `useProxy: true`,
   `requestTranslation` POSTs to
   `/api/plugins/runtime/translator-assist/translate` — no such route is
   registered in the Rust server (`main.rs:839-859` registers only
   health/api/ws/uploads/static). Result: 404.
2. **Backend plugin is archived.** The only `translator-assist` backend plugin
   lives in `archive/addons-dead-node-layer/` (dead Node addon layer).
3. **Settings UI is hidden.** `translatorAddonDetected`
   (`AddonSettingsTab.svelte:46`) requires `id === 'translator-assist'` in
   `/api/addons` or the frontend inventory — it is in neither — so the
   Translator Assist section in `UtilitiesSection.svelte:148` never renders.
   Users cannot switch models or disable the proxy.

Only working path (unreachable by default): direct mode to a local LibreTranslate
at `127.0.0.1:5000`.

---

## C. Decisions (agreed with owner)

1. **Provider model**: both cloud and self-hosted are shipped; the default must
   work in-app with **zero install** (no 1GB client/server download). Default =
   Cloud LibreTranslate public API; local LibreTranslate is an opt-in offline
   option.
2. **Architecture**: the wabi server itself is the translator — a service for
   its own users. Long-term engine: **embedded Bergamot (Mozilla)** compiled
   into `wabi-server` as an optional cargo feature.
3. **Federation: explicitly out of scope.** No cross-server translation mesh,
   no `TranslatorWorker` node capability. Rationale below.
4. **Languages**: Thai is the primary target for the first new locale; `fr`/`de`
   are possible later. Only Thai in this pass.
5. **Existing translation quality is acceptable** — no human-quality rewrite
   pass required for `es.json`.

### Why no federation (rationale)

- A translation service receives plaintext + target language — an attack
  surface, but no code/file payloads.
- The real issue is liability: routing content through a peer server makes the
  peer operator a technical party to another community's content. The
  Discord/Matrix model — each server operator responsible for their own
  community's content — keeps liability boundaries clear. A cross-server text
  relay blurs exactly that line.
- The mesh already exists for binary relay/media (`NodeCapability::MediaRelay`
  etc.), which has a different risk profile than content transport.
- If federation is ever revisited: separate design required (explicit opt-in,
  peer authentication, written policy).

---

## D. Implementation plan

### Phase 1 — Translation service (server-side)

1. `POST /api/plugins/runtime/translator-assist/translate` in `wabi-server`:
   sanitize inputs (providerUrl ≤ 500 chars, text ≤ 8000, lang codes ≤ 16,
   optional apiKey → `Authorization: Bearer`), forward LibreTranslate-style
   `{q, source, target, format: 'text'}`, return `{translatedText}`.
2. Add `translator-assist` entry to `enabled_addons()` in
   `core/crates/wabi-server/src/api/addons.rs` (always-on, permission
   `network:outbound`) so the frontend detection un-hides the settings UI.
3. Provider chain: embedded engine (if enabled) → cloud LibreTranslate fallback.
   Target language auto-follows the current app locale; overridable in settings.
4. Better failure toast when all providers are unreachable (hint to check
   Settings > Add-ons > Translator Assist).

### Phase 1.5 — Embedded Bergamot engine (server hosts the model)

5. Optional cargo feature `wabi-translate`: compile bergamot-translator
   (C++ with Rust bindings; requires cmake/C++ toolchain at build time) into
   `wabi-server`.
6. Model store: admin-configured directory; language pairs fetched on demand
   (en↔es, en↔th first); server falls back to cloud until models are present.
7. Fallback if the C++ build proves too heavy: expose a local
   LibreTranslate/llama.cpp endpoint through the same proxy chain instead.

### Phase 2 — UI i18n coverage

8. Wave 1 (high visibility): `MessageActionsBar`, `ChannelSidebar`, chat
   composer, message components, all 9 `settings/addons/` sections, Login /
   UtilitiesSection residual labels.
9. Wave 2: `business/` workspace (20 components).
10. Wave 3: remaining components via inventory sweep.
11. Add a coverage metric to `check:i18n` (fraction of components importing
    i18n).

### Phase 3 — i18n plumbing

12. Browser-locale auto-detect on first visit (`navigator.language` → en/es/th).
13. Persist locale server-side (existing user-settings endpoint) so language
    follows across devices.

### Phase 4 — Thai locale

14. Generate `th.json` (501 keys) by machine translation, spot-check
    placeholders.
15. Register in `i18n/index.ts`: import, `availableLocales`, `LocaleCode`,
    `normalizeLocale`.

### Verification

- `cd frontend && bun run check:i18n && bun run check && bun run build`
- `cargo check -p wabi-server` (and `cargo check -p wabi-server --features
  wabi-translate` when that feature lands)
- Manual: language switcher → Thai; right-click translate with local engine and
  cloud fallback.

---

## E. Key files

- `frontend/src/lib/i18n/index.ts` — locale registration & switching
- `frontend/src/lib/i18n/locales/en.json`, `es.json` — translation sources
- `frontend/src/lib/components/message/messageTranslator.ts` — client-side translator
- `frontend/src/lib/components/MessageList.svelte:1145` — `handleTranslate`
- `frontend/src/lib/components/settings/AddonSettingsTab.svelte:46` — addon detection gate
- `frontend/src/lib/components/settings/addons/UtilitiesSection.svelte:148` — Translator settings UI (hidden)
- `core/crates/wabi-server/src/api/addons.rs` — `/api/addons` (needs translator-assist entry)
- `core/crates/wabi-server/src/main.rs:839` — router (no plugins/runtime route)
- `archive/addons-dead-node-layer/source/translator-assist/` — archived node-layer plugin (reference logic)
- `frontend/scripts/check-i18n.mjs` — key-parity check
- `audit/TRANSLATION_GUIDE.md` — contributor guide
