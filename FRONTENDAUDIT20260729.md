# Wabi Frontend Audit — 2026-07-29

## Scope and method

Current-state audit of `frontend/` plus the deployment and CI files that directly determine frontend behavior.

- Crawled 727 files under `frontend/src`: 248 Svelte, 352 TypeScript, 1 JavaScript, and supporting assets.
- Ran `bun run build`, `npm run check`, `npm run check:i18n`, `bun test`, the four dormant custom test runners, `npm ci`, and `npm audit --omit=dev`.
- Inspected authentication, configured-server routing, DM encryption, uploads/downloads, markdown/HTML rendering, add-ons, service-worker caching, PWA metadata, browser permissions, lifecycle cleanup, accessibility, and CI.
- Re-checked the 2026-07-08 audit in `audit/FRONTEND_AUDIT.md`. Findings already fixed or deleted were not copied here.

This is a static and build-level audit. Multi-user calls, payments, uploads, offline recovery, Tauri, and browser/PWA installation still need runtime smoke tests against a live backend.

## Priority definitions

- **P0 — stop-ship:** security promise is false, production cannot build, or a documented deployment disables core features.
- **P1 — urgent:** exploitable dependency, broken primary workflow, data/privacy risk, or missing quality gate likely to ship regressions.
- **P2 — important:** significant accessibility, reliability, maintainability, or user-experience defect.
- **P3 — cleanup:** low-risk correctness, dead configuration, documentation drift, or polish.

## Executive summary

The frontend is **not release-ready**.

- The production build fails.
- The DM UI displays an `E2EE` guarantee while production send/upload code does not encrypt DMs.
- The recommended Caddy configuration denies camera and microphone access and blocks several shipped integrations.
- The installed dependency graph reports 10 known vulnerabilities, including 2 high severity.
- `svelte-check` reports 94 warnings in 37 files, in addition to 60 explicitly suppressed accessibility diagnostics.
- Four security/layout test files are not registered with the test runner, and CI runs no frontend tests.
- Clean npm installs fail because `package.json` and `package-lock.json` are out of sync.

## Ranked findings

### 1. P0 — The UI falsely labels DMs as end-to-end encrypted

**Evidence**

- `frontend/src/lib/components/DmConversationView.svelte:63` always renders `E2EE` with the title “End-to-end encrypted.”
- No production caller uses `dmRatchet.encryptMessage`, `sealBase64`, or `deriveConversationKey`; those primitives are only exercised by dormant custom test runners.
- `frontend/src/lib/components/chat/uploadOrchestrator.ts:71-87` sets both DM privacy branches to `null`, appends `&& false` to `canEncrypt`, and contains `await null` in the encryption branch. DM attachments therefore upload normally without `attachmentEncryption`.
- `frontend/src/lib/components/MessageList.svelte:1430-1445` deliberately makes encrypted attachment decryption unreachable with `!false` and `await null`.
- `README.md:65` acknowledges that the visible badge is not a production security guarantee.

**Impact**

Users are given a concrete security guarantee that the implementation does not provide. DM text and attachments can be readable by infrastructure that users were told could not read them.

**Fix**

Remove the `E2EE` badge immediately. Either finish authenticated message and attachment encryption/decryption, identity verification, key rotation, recovery, multi-device handling, and failure UX, or explicitly label DMs as transport-encrypted only.

### 2. P0 — Production builds fail

**Evidence**

- `bun run build` and `npm run build` fail at `frontend/src/lib/effects/AmbientBackground.svelte:95`.
- Rollup receives the TypeScript-only optional parameter syntax in `function loop(time?: number)` as JavaScript and reports `Expected ',', got '?'`.
- `frontend/svelte.config.js:12` explicitly sets `preprocess: []`.

**Impact**

The frontend, embedded server assets, Tauri builds, and release CI cannot produce a deployable artifact from the current tree.

**Fix**

Configure `vitePreprocess()` in `svelte.config.js` or rewrite the component to syntax the configured compiler supports. Keep `bun run build` as a required CI gate.

### 3. P0 — Recommended deployment headers disable calls, capture, maps, and shipped integrations

**Evidence**

- `Caddyfile.example:40` and `Caddyfile.tunnel:20` set `Permissions-Policy "camera=(), microphone=(), geolocation=()"`.
- The frontend uses `getUserMedia` for calls, camera capture, audio recording, and audio settings, and uses geolocation in `frontend/src/lib/directionsAssist.ts:86`.
- `Caddyfile.example:38` and `Caddyfile.tunnel:19` omit `frame-src` and restrict scripts/images to self.
- Shipped features load YouTube iframes/API, Spotify iframes, OpenStreetMap iframes, Giphy/media images, LibreTranslate, and `esm.sh` model-viewer modules.

**Impact**

Deployments following the supplied configuration deny the exact browser capabilities used by core calling and mapping features. CSP also blocks YouTube, Spotify, maps, external images, and remote model-viewer code.

**Fix**

Generate a feature-derived CSP and Permissions Policy. At minimum allow self camera/microphone/geolocation where enabled and add explicit `frame-src`, `script-src`, `img-src`, and `connect-src` origins for supported integrations. Add a Playwright smoke test that loads the production headers and checks browser-console CSP violations.

### 4. P1 — Known vulnerable dependencies are installed on user-controlled rendering paths

`npm audit --omit=dev` reports **10 vulnerabilities: 2 high, 7 moderate, 1 low**.

Important exposures include:

- `devalue`: high-severity sparse-array deserialization DoS ([GHSA-77vg-94rm-hx3p](https://github.com/advisories/GHSA-77vg-94rm-hx3p)).
- `ws`: high-severity memory disclosure and memory-exhaustion DoS ([GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx), [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p)).
- `dompurify@3.4.2`: multiple sanitizer/XSS advisories. DOMPurify protects chat, wiki, and reader `{@html}` sinks in `frontend/src/lib/markdown.ts` and `readerTabHelpers.ts`.
- `svelte@5.55.5`: multiple SSR/DOM-clobbering XSS and ReDoS advisories.
- `esbuild` and `uuid`: development-server request exposure and buffer-bounds advisories.

**Fix**

Upgrade and re-audit. Prioritize DOMPurify, Svelte/devalue, and Socket.IO’s `ws` chain. Add dependency auditing to CI with an explicit severity policy.

### 5. P1 — Service worker can retain authenticated media across sessions and its expiry logic is nonfunctional

**Evidence**

- `frontend/static/sw.js:39-48` caches `/uploads/` and whiteboard files without checking authentication, user, server, or logout state.
- Cache keys are effectively request URL/method; Authorization identity is not partitioned by the application.
- Logout/session-clearing code does not clear `media-cache-v1`.
- `sw.js:88`, `114`, and `134` use `cache.put` directly.
- `cachePut()` at `sw.js:157` is the only function that adds `X-Cached-At`, but it is never called.
- `isEntryFresh()` therefore sees no timestamp. The stale-while-revalidate path still returns stale entries, so the declared seven-day maximum age is not enforced.

**Impact**

Private uploads can remain available to a later account using the same browser profile. Cached media has no effective maximum age.

**Fix**

Do not cache authenticated/private media unless cache keys are partitioned by server and user and cleared on logout. Use `cachePut`, enforce expiration before serving, and add cache-migration/version tests.

### 6. P1 — Mention suggestions use incompatible data contracts and can fail at runtime

**Evidence**

- `frontend/src/lib/components/chat/mentionSuggestions.ts` returns objects shaped like `{ id, label, kind, targetId, detail }`.
- `frontend/src/lib/components/chat/types.ts:8-16` requires `{ key, label, value, kind, ... }`.
- `frontend/src/lib/components/chat/MentionSuggestions.svelte:10` keys the list with `suggestion.key`, which is absent from every returned item.
- `frontend/src/lib/components/chat/ChatComposer.svelte:148` and `:288` silence the mismatch with `as any`.

**Impact**

Multiple suggestions share an `undefined` key, which can trigger duplicate-key failures or incorrect DOM reuse. The casts hide the defect from `svelte-check`.

**Fix**

Define one `MentionSuggestion` type, return stable unique `key` and `value` fields, remove both `as any` casts, and add tests for multiple user/channel/object suggestions.

### 7. P1 — Dependency installation is not reproducible

**Evidence**

- `npm ci --ignore-scripts` fails because `package-lock.json` is missing `playwright@1.61.1`, `playwright-core@1.61.1`, and `fsevents@2.3.2` required by `package.json`.
- The repository has no `bun.lock`/`bun.lockb`.
- CI uses `bun install` with `bun-version: latest`, producing a fresh transitive resolution on every run.

**Impact**

Developers, CI, and releases can install different graphs; npm-based setup is completely blocked.

**Fix**

Choose one package manager, regenerate and commit its lockfile, use a pinned tool version, and require frozen-lockfile installation in CI.

### 8. P1 — Frontend tests and static checks do not protect releases

**Evidence**

- `bun test` reports 7 tests, all from `cssSanitize.test.ts`.
- `dmCrypto.test.ts`, `dmRatchet.test.ts`, `dmRecovery.test.ts`, and `docking/layoutSchema.test.ts` only export custom runner functions and register zero `test()` cases.
- Invoking the custom runners manually yields 27/27 passing, but normal test and CI commands never execute them.
- Some custom assertions are ineffective: the X3DH test checks only that two root keys are non-empty rather than equal; the recovery passphrase test computes a passphrase-derived seed but never compares it.
- `.github/workflows/build.yml` runs no frontend test command.
- `.github/workflows/build.yml:110` marks `svelte-check` as `continue-on-error: true`.
- No Playwright E2E test is run despite Playwright being declared.

**Impact**

CI can be green while crypto/layout suites do not run and static diagnostics regress.

**Fix**

Convert custom runners to real test cases, repair weak assertions, add component/API tests, run Playwright smoke coverage, fail CI on `svelte-check`, and run `bun test` in CI.

### 9. P1 — Two subsystems read an authentication key that the auth layer deletes

**Evidence**

- `frontend/src/lib/authSession.ts` stores scoped tokens under `wabi_auth_token:<server>` in session storage and optionally `wabi_persisted_auth_token:<server>` in local storage.
- Legacy `authToken` values are migrated and deleted.
- `frontend/src/lib/addons/loader.ts:209` and `frontend/src/lib/docking/layoutPersistence.ts:43` read `localStorage.getItem('auth_token')`, a different key that is never written by the current auth layer.

**Impact**

Authenticated add-on manifest loading and remote dock-layout synchronization silently run unauthenticated or never run.

**Fix**

Import `getAuthToken()` from `authSession.ts`, pass the intended server scope, and remove local token-reading helpers.

### 10. P1 — Configured remote-server mode still makes critical same-origin API calls

**Evidence**

- `frontend/src/routes/+page.svelte:261` reconnect validation calls `/api/auth/validate`.
- `frontend/src/lib/components/AdminCenterStage.svelte:62` and `AdminTab.svelte:38` call `/api/admin/stats`.
- `frontend/src/lib/docking/layoutPersistence.ts:16` hardcodes `/api/user/layout`.
- Most other API modules correctly prefix requests with `getServerUrl()`.

**Impact**

When the UI is pointed at a user-configured server, reconnect validation, admin statistics, and layout sync target the frontend origin instead of the selected server.

**Fix**

Route every backend request through one typed API client based on `getServerUrl()`. Add a test where frontend origin and server origin differ.

### 11. P1 — Local-storage encryption uses a global static salt in three diverging implementations

**Evidence**

- `frontend/src/lib/storage-compression.ts:31`, `storageEncryption.ts:16`, and `storage/encryption.ts:12` use `wabi-storage-salt-v1`.
- `enableStorageEncryption()` stores that constant but `deriveKey()` ignores stored metadata and hardcodes the same value.
- PBKDF2 therefore produces the same derived key for the same password on every installation.

**Impact**

Attackers can amortize password guessing across all Wabi installations, and duplicated crypto implementations can drift.

**Fix**

Generate a random per-install salt, store it with version/KDF parameters, feed it into derivation, migrate old ciphertext, and consolidate to one implementation. Reassess the 100,000 PBKDF2 iteration count for the supported devices.

### 12. P1 — Offline PWA navigation is not actually implemented

**Evidence**

- `frontend/static/sw.js:14-18` says it pre-caches the app shell but the install handler only calls `skipWaiting()`.
- No code writes `/` to `shell-cache-v1`.
- `navigationHandler()` at `sw.js:69-77` looks for a shell entry that can never exist and falls back to a bare hardcoded “Offline” page.
- Stale media revalidation is started without `event.waitUntil`, so the worker can terminate before caching completes.

**Impact**

Reloading the installed PWA offline cannot open the application or its local-first UI, despite WabiDB/offline features.

**Fix**

Precache a versioned shell/build manifest, use a tested navigation fallback, attach background work to the fetch event lifetime, and add offline install/reload tests.

### 13. P1 — “Forgot password” is a visible no-op

`frontend/src/lib/components/Login.svelte:221` renders a recovery link whose handler contains only `TODO: implement forgot password`.

**Impact**

Locked-out users are offered a control that does nothing.

**Fix**

Implement the complete recovery flow or remove the link until the backend and UX exist.

### 14. P1 — Add-on loading is both broken for local fallbacks and an unbounded code-execution trust boundary

**Evidence**

- `frontend/src/lib/addons/loader.ts:57` executes `await import(manifest.frontendEntry)` from server-provided manifest data.
- Local fallback entries at `loader.ts:225-236` use strings such as `$lib/components/plugins/YouTubeWatchEmbed.svelte`. Vite cannot transform a runtime variable containing an alias into a bundled module.
- There is no frontend-entry origin allowlist, signature check, or capability boundary at this import point.

**Impact**

Bundled fallback add-ons can fail to load. A compromised or malicious manifest endpoint can direct the browser to execute arbitrary JavaScript in the authenticated Wabi origin/context.

**Fix**

Use `import.meta.glob` with an explicit ID-to-loader map for bundled add-ons. For remote add-ons, verify signatures and origin, define capabilities, and isolate execution in a sandboxed frame or worker.

### 15. P1 — Place-mention HTML is malformed

`frontend/src/lib/markdown.ts:175` builds `data-place-id="...` without the closing quote before the next attribute.

**Impact**

DOMPurify/browser parsing can merge or drop place attributes, breaking place mention activation and producing inconsistent sanitized DOM.

**Fix**

Close the attribute, stop building entity markup with string concatenation where practical, and add renderer tests for hostile and ordinary entity values.

### 16. P2 — Accessibility debt is systemic

`npm run check` reports **94 warnings in 37 files**:

| Diagnostic | Count |
|---|---:|
| Unused exported props | 22 |
| Click handlers without keyboard equivalents | 18 |
| Invalid self-closing non-void HTML | 18 |
| Static elements with interaction handlers/no role | 17 |
| Unused CSS selectors | 6 |
| Non-interactive elements with handlers | 4 |
| Labels not explicitly associated | 3 |
| Invalid `href` | 2 |
| Media without captions | 2 |
| Dialog not focusable | 1 |
| Autofocus | 1 |

There are also **60 `svelte-ignore a11y...` directives across 19 files**, so the 94 warnings understate the problem.

Highest-warning files:

- `GalleryLightbox.svelte` — 16
- `LoreChannel.svelte` — 10
- `EmojiPicker.svelte` and `GalleryChannel.svelte` — 6 each
- `ReaderTabImpl.svelte` and `WikiPageTree.svelte` — 4 each

**Fix**

Prioritize dialogs/lightboxes, wiki trees, gallery controls, and message/media controls. Use native buttons, focus traps/restoration, Escape handling, associated labels, keyboard drag/drop alternatives, and captions/transcripts. Remove ignores only after equivalent interaction exists.

### 17. P2 — Type checking is intentionally weakened and masks real defects

**Evidence**

- `frontend/tsconfig.json:9-11` sets `skipLibCheck: true` and `strict: false`.
- Current source contains approximately 423 explicit `any` occurrences and 108 `as any` assertions.
- The mention-picker defect in finding 6 is hidden by those assertions.
- `svelte-check` also reports 22 exported props that components do not consume.

**Impact**

API and component contract drift reaches runtime instead of failing during development.

**Fix**

Turn on strict flags incrementally, starting with shared API/socket/message contracts and new code. Ban new `any` in CI and replace broad component props with typed interfaces.

### 18. P2 — Core files are too large to review or test safely

Largest current files:

- `calling_impl_core.ts` — 2,097 lines
- `MessageList.svelte` — 1,926
- `LoreChannel.svelte` — 1,697
- `MainLayout.svelte` — 1,123
- `MapWorkspace.svelte` — 1,108
- `ServerSwitcherPanel.svelte` — 1,026
- `MediaAlbumsTabImpl.svelte` — 1,023
- `socketConnectionCore.ts` — 1,022
- `CallModal.svelte` — 973
- `AdminWorkspace.svelte` — 920

**Impact**

State, effects, rendering, networking, and cleanup are coupled; regressions are hard to isolate and unit-test.

**Fix**

Split by state machine/domain operation rather than visual fragments. Extract network clients and pure reducers first, then component sections with explicit typed inputs/outputs.

### 19. P2 — Native blocking dialogs are pervasive

Current source contains roughly **144 alert**, **38 confirm**, and **28 prompt** call sites.

**Impact**

Native dialogs block the main thread, are difficult to style/localize/test, can interrupt media/call flows, and provide inconsistent keyboard/screen-reader behavior.

**Fix**

Create shared toast, confirmation-dialog, and validated-input-dialog services. Migrate high-frequency upload, settings, payment, moderation, and call paths first.

### 20. P2 — Localization coverage is incomplete even though key parity passes

`npm run check:i18n` passes because English and Spanish JSON files have matching keys, but many active components embed English directly. Examples include `DmHub.svelte`, `DmConversationView.svelte`, `AdminCenterStage.svelte`, `AdminWorkspace.svelte`, `WikiChannel.svelte`, `ReaderTabImpl.svelte`, and add-on settings.

**Impact**

Spanish mode produces a mixed-language UI. The checker validates parity, not coverage.

**Fix**

Move user-visible literals into i18n keys and extend the checker to flag raw text/placeholder/title/aria-label literals with a small allowlist.

### 21. P2 — Connection status reports browser network state, not Wabi server state

`frontend/src/lib/effects/ConnectionBadge.svelte` derives status only from `navigator.onLine`. Its `reconnecting` state is never rendered or assigned.

**Impact**

The UI can show “Online” while the selected Wabi server/socket is unreachable.

**Fix**

Drive the badge from socket/API health plus browser network state and expose connecting, reconnecting, offline, and server-unreachable states.

### 22. P2 — Add-on settings opens to a removed section

- `frontend/src/lib/components/settings/addonSettingsRegistry.ts` still declares a `dms` section and DM controls.
- `frontend/src/lib/components/settings/AddonSettingsTab.svelte:43` defaults to `activeAddonSection = 'dms'`.
- The DM settings component was removed; rendered sections start with Chat/Spoilers/Search.

**Impact**

The page initially opens with no section expanded and retains controls for a removed feature.

**Fix**

Remove stale DM registry entries or restore the section, then default to the first rendered section.

### 23. P2 — Custom external-note URLs allow unsafe schemes and retain opener access

`frontend/src/lib/components/DmHub.svelte:173-174` accepts any string parsed by `new URL()` and passes it to `window.open(..., '_blank')` without `noopener,noreferrer`.

**Impact**

`javascript:`, `data:`, or unexpected custom schemes can be accepted; opened HTTPS pages may retain access to `window.opener`.

**Fix**

Allowlist `https:` plus explicitly supported application schemes, reject credentials and control characters, and always use `noopener,noreferrer`.

### 24. P2 — Encryption wrapping secret is stored beside the wrapped private key

`frontend/src/lib/encryption.ts:325-347` stores a device wrapping secret in local storage, and `loadUserKeys()` reads it from the same origin/storage as the wrapped private key.

**Impact**

This prevents a copied ciphertext blob alone from being useful, but it does not protect against XSS, malicious same-origin code, or an attacker who obtains the complete browser profile.

**Fix**

Document the limited threat model in UI. For stronger protection, derive from a user secret or use platform-backed credential/secure storage (especially in Tauri) rather than colocating key and wrapping secret.

### 25. P2 — Raw server layout JSON can crash layout loading

`frontend/src/lib/docking/layoutPersistence.ts:78` parses `server.layoutJson` outside the fetch helper’s `try/catch` and returns it without schema validation.

**Impact**

Malformed or old server data can reject the entire layout initialization path.

**Fix**

Parse inside a guard, validate/migrate with `layoutSchema`, fall back to local/default state, and surface a recoverable warning.

### 26. P2 — Service-worker and PWA documentation/metadata have diverged

- `frontend/src/app.html:6` links `manifest.webmanifest`.
- `frontend/docs/custom-service-worker.md` repeatedly says the active manifest is `static/manifest.json`.
- Both files exist with different application names, descriptions, icon purposes, and branding.
- `app.html`, the web manifest, and the unused JSON manifest also use different theme/description values.

**Impact**

Developers can edit the wrong file and installed-app metadata differs by consumer.

**Fix**

Keep one manifest, generate or validate it in CI, and update the service-worker documentation.

### 27. P2 — Errors are deliberately swallowed in several user-facing paths

Examples:

- Admin statistics catches leave the dashboard silently stale.
- Dock-layout saves ignore HTTP status and network failures.
- Add-on manifest loading silently falls back to local entries after auth/server failures.
- Audio device enumeration and multiple live/plugin operations use empty catches.

**Impact**

Users cannot distinguish “no data” from “request failed,” and support diagnostics lose the cause.

**Fix**

Use typed error results, non-blocking status/toast feedback, and structured debug logging. Only suppress errors proven to be harmless.

### 28. P3 — Invalid HTML and a styling typo remain

- 18 Svelte warnings are self-closing non-void elements such as `div`, `span`, and `textarea`.
- `frontend/src/lib/components/admin/RoleGatePanel.svelte:44` uses `admin_empty`; the stylesheet defines `.admin-empty`.

**Impact**

Markup can parse differently between compiler/browser versions, and the role-gate note is unstyled.

**Fix**

Use explicit closing tags and correct the class name.

### 29. P3 — The source tree contains non-runtime handoff documents

These non-runtime documents remain inside the application source tree:

- `frontend/src/lib/components/FRACTURE_PLAN.md`
- `frontend/src/lib/components/HANDOFF.md`
- `frontend/src/lib/REFACTORING_STATUS.md`

**Fix**

Move maintained documents under `docs/`; delete obsolete handoff notes.

### 30. P3 — A prototype is shipped as a public production asset

`frontend/static/gallery-prototype.html` is copied into deployed static assets but is referenced only by planning documents. It contains a standalone mock UI, inline script, direct `innerHTML` writes, and external Picsum requests.

**Impact**

It expands public surface area, conflicts with strict CSP, and can be mistaken for a supported route.

**Fix**

Move it to design documentation/fixtures or exclude it from production builds.

### 31. P3 — Dependency and configuration cleanup remains

- `@giphy/js-components` is declared but not imported; only `@giphy/js-fetch-api` is used.
- `@types/marked` is redundant because current `marked` ships types.
- The two manifest files are duplicate configuration.
- The code contains approximately 118 `console.log`/`console.debug` calls, including connection, storage, call, and migration paths.

**Fix**

Remove unused packages/configuration and gate diagnostic logging behind a structured debug setting.

### 32. P3 — Small incomplete or misleading controls remain

- `frontend/src/lib/components/MessageList.svelte:254` has an unfinished emoji-reactions TODO despite reaction infrastructure elsewhere.
- `frontend/src/lib/gameScreenshotPipe.ts:459` discards the real MIME type as `application/octet-stream`.
- `VoiceChannelList.svelte:97-102` marks every other voice participant as draggable; the parent later cancels unauthorized drags, so the cursor/HTML state still advertises an unavailable operation.
- `ConnectionBadge.svelte:17` installs an anonymous `wabi:work-offline` listener that cannot be removed on destroy.

**Fix**

Finish/remove the reaction affordance, preserve MIME metadata, pass the parent permission into voice-row rendering, and retain/remove the event callback by reference.

## Complete `svelte-check` affected-file inventory

The 94 warnings are distributed as follows:

- `src/lib/components/admin/ChannelAccessPanel.svelte` — 1
- `src/lib/components/admin/EmojiRoleRulesPanel.svelte` — 1
- `src/lib/components/admin/FrontendMetadataPanel.svelte` — 1
- `src/lib/components/admin/OverviewSection.svelte` — 3
- `src/lib/components/admin/RoleGatePanel.svelte` — 1
- `src/lib/components/admin/RoleNamesPanel.svelte` — 1
- `src/lib/components/admin/ui/Skeleton.svelte` — 1
- `src/lib/components/admin/ui/StatusDot.svelte` — 1
- `src/lib/components/AdminCenterStage.svelte` — 3
- `src/lib/components/AudioRecorder.svelte` — 1
- `src/lib/components/business/PlannerWorkspace.svelte` — 1
- `src/lib/components/emoji/EmojiGrid.svelte` — 2
- `src/lib/components/EmojiPicker.svelte` — 6
- `src/lib/components/GalleryChannel.svelte` — 6
- `src/lib/components/GalleryLightbox.svelte` — 16
- `src/lib/components/Login.svelte` — 1
- `src/lib/components/LoreChannel.svelte` — 10
- `src/lib/components/MainLayout.svelte` — 2
- `src/lib/components/map/MapPlaceHeader.svelte` — 1
- `src/lib/components/media-albums/MediaAlbumsTabImpl.svelte` — 1
- `src/lib/components/message/MessageEditForm.svelte` — 1
- `src/lib/components/message/MessageHeader.svelte` — 1
- `src/lib/components/NotesView.svelte` — 2
- `src/lib/components/plugins/ModelViewerShell.svelte` — 3
- `src/lib/components/ReaderTabImpl.svelte` — 4
- `src/lib/components/settings/admin/CommunityNodes.svelte` — 3
- `src/lib/components/settings/admin/DonationConfig.svelte` — 2
- `src/lib/components/settings/admin/OfflineDonations.svelte` — 1
- `src/lib/components/sidebar/GalleryChannelList.svelte` — 2
- `src/lib/components/sidebar/VoiceChannelList.svelte` — 2
- `src/lib/components/SpringPanel.svelte` — 1
- `src/lib/components/WikiChannel.svelte` — 1
- `src/lib/components/WikiPageTree.svelte` — 4
- `src/lib/components/WikiRevisionDrawer.svelte` — 3
- `src/lib/effects/ConnectionBadge.svelte` — 1
- `src/lib/payments/PaymentSheetImpl.svelte` — 1
- `src/routes/detached/+page.svelte` — 2

## Verification snapshot

| Command | Result |
|---|---|
| `bun run build` | **Failed** — `AmbientBackground.svelte:95` TypeScript parse error |
| `npm run check` | Passed exit code, **0 errors / 94 warnings in 37 files** |
| `npm run check:i18n` | Passed — locale key parity only |
| `bun test` | Passed — **7 registered tests** |
| Manual custom crypto/layout runners | 27/27 passed, but not part of normal tests/CI |
| `npm ci --ignore-scripts` | **Failed** — lockfile/package mismatch |
| `npm audit --omit=dev` | **Failed policy** — 10 vulnerabilities (2 high, 7 moderate, 1 low) |

## Recommended repair order

1. Remove the false E2EE badge and decide whether real DM E2EE is in release scope.
2. Restore a reproducible production build and frozen dependency install.
3. Correct Caddy browser permissions/CSP and test the actual production headers.
4. Upgrade vulnerable rendering/network dependencies.
5. Stop caching private media; repair PWA shell/expiry behavior.
6. Fix mention contracts, auth-key consumers, and configured-server URL routing.
7. Register real tests and make build/check/test mandatory in CI.
8. Repair encryption salt/versioning and migrate existing data safely.
9. Address accessibility, localization, type safety, and component decomposition in bounded batches.
