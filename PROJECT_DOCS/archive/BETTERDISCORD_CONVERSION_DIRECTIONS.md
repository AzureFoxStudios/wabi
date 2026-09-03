# BetterDiscord Conversion Directions (Wabi)

## Purpose
Document the exact process used to convert BetterDiscord plugin ideas into Wabi-native features.
This is a behavior translation workflow, not raw code copy.

## What "Conversion" Means Here
1. Read plugin behavior and UX intent from BetterDiscord source/pages.
2. Re-implement the behavior in Wabi architecture (Svelte + existing backend/API).
3. Preserve outcome for users, not Discord-specific internals.
4. Ship in phases with test and rollback paths.

## Source Of Truth Docs
- Master plan: `PROJECT_DOCS/PLUGIN_PORTING_MASTER_PLAN.md`
- BetterDiscord catalog cross-analysis: `PROJECT_DOCS/PLUGIN_CROSS_ANALYSIS_BETTERDISCORD.md`
- Grading round 1: `PROJECT_DOCS/PLUGIN_GRADING_ROUND1.md`
- Grading round 2: `PROJECT_DOCS/PLUGIN_GRADING_ROUND2_BETTERDISCORDPLUGINS.md`
- ZipPreview spec: `PROJECT_DOCS/PLUGIN_SPEC_ZIPPREVIEW.md`
- VideoCompressor spec: `PROJECT_DOCS/PLUGIN_SPEC_VIDEOCOMPRESSOR.md`
- GifCaptioner spec: `PROJECT_DOCS/PLUGIN_SPEC_GIFCAPTIONER.md`
- UnicodeEmojis spec: `PROJECT_DOCS/PLUGIN_SPEC_UNICODEEMOJIS.md`
- CustomStatusPresets spec: `PROJECT_DOCS/PLUGIN_SPEC_CUSTOMSTATUSPRESETS.md`
- EmojiStatistics spec: `PROJECT_DOCS/PLUGIN_SPEC_EMOJISTATISTICS.md`
- BetterSearchPage spec: `PROJECT_DOCS/PLUGIN_SPEC_BETTERSEARCHPAGE.md`
- HideMutedCategories spec: `PROJECT_DOCS/PLUGIN_SPEC_HIDEMUTEDCATEGORIES.md`
- UserNotes spec: `PROJECT_DOCS/PLUGIN_SPEC_USERNOTES.md`
- RemoveNicknames spec: `PROJECT_DOCS/PLUGIN_SPEC_REMOVENICKNAMES.md`
- LocalNicknames spec: `PROJECT_DOCS/PLUGIN_SPEC_LOCALNICKNAMES.md`
- GoogleSearchReplace spec: `PROJECT_DOCS/PLUGIN_SPEC_GOOGLESEARCHREPLACE.md`
- SpotifyControls spec: `PROJECT_DOCS/PLUGIN_SPEC_SPOTIFYCONTROLS.md`
- StaffTag + TopRoleEverywhere spec: `PROJECT_DOCS/PLUGIN_SPEC_STAFFTAG_TOPROLEEVERYWHERE.md`
- TimedLightDarkMode spec: `PROJECT_DOCS/PLUGIN_SPEC_TIMEDLIGHTDARKMODE.md`
- Shared albums spec (ImageFolder track): `PROJECT_DOCS/FEATURE_SPEC_MEDIA_ALBUMS.md`

## Step-By-Step Workflow
1. Intake and grade
- Pull plugin candidate from BetterDiscord list/local plugin folder.
- Grade with the weighted rubric from the master plan.
- Route to `Core` vs `Addon` using the user-approved `+` rule.

2. Extract behavior contract
- Define exactly what users can do in the original plugin.
- Separate required behavior from Discord-only implementation details.
- Write requirements into a Wabi spec doc.

3. Build a Wabi mapping table
- For each plugin behavior, map to:
  - Wabi UI component(s)
  - Wabi data/API path
  - limits/guardrails
  - fallback behavior
- For animation/motion behavior, map to Wabi motion primitives (`animationPassStore`, shared CSS tokens, reduced-motion rules) instead of Discord timing/layout assumptions.
- Reject features that violate Wabi constraints (security/perf/scope).

4. Phase the implementation
- Phase 0: Discovery
- Phase 1: MVP
- Phase 2: Harden
- Phase 3: Polish
- Every phase gets scope checklist, test checklist, rollback notes.

5. Implement in Wabi-native code
- Prefer existing Wabi component surfaces first.
- Keep features runtime-gated where needed (desktop/mobile/web differences).
- Add explicit UI failure states; never silently fail.

6. Validate each slice
- Run frontend checks and build.
- Add plugin-specific smoke checks where useful.
- Confirm behavior in packaged desktop runtime when desktop is in scope.

7. Update docs immediately after each slice
- Update spec progress checkboxes.
- Update master plan status row + phase.
- Record decisions and unresolved questions.

8. Promote/ship
- Mark complete only after manual pass + build pass + rollback path.
- Keep backlog items explicit instead of hidden.

## How The Current Conversions Were Done

### 1) ZipPreview (A+, Core)
Source intent:
- Let users inspect ZIP contents without full extraction.

Wabi translation:
- Detect `.zip` attachments in chat.
- Parse ZIP central directory in-browser.
- Render list/tree + sizes + entry counts.
- Add safety limits (archive size cap, entry cap, timeout, malformed archive rejection).
- Add cache + filter/search + retry.
- Add polish controls:
  - inline preview for safe text/image entries
  - sortable entry list (`name` / `size`)
  - user settings for ZIP preview + inline preview behavior.

Key implementation files:
- `frontend/src/lib/components/MessageList.svelte`
- `frontend/src/lib/components/ZipPreviewPanel.svelte`
- `frontend/src/lib/zip/zipPreview.ts`
- `frontend/scripts/zip-preview-fixture-smoke.ts`

Validation used:
- `bun run check`
- `bun run check:zip-preview`
- `bun run build:only`

### 2) VideoCompressor (B+, Core)
Source intent:
- Compress oversized videos before upload.

Wabi translation:
- Intercept large video attachments at composer intake.
- Prompt compression modal with presets.
- Run client-side compression path.
- Expose progress/cancel/retry/keep-original controls.
- Use runtime-aware profiles (desktop + Android/iOS mobile-safe presets and guardrails).
- Emit optional client metrics/failure codes into admin observability (explicit env opt-in).
- Sample input metadata to improve output-size estimates and add borderline suggestion copy in modal.
- Send client compression metadata through resumable uploads and verify it on backend finalization.

Key implementation files:
- `frontend/src/lib/components/Chat.svelte`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/video/videoCompressor.ts`
- `frontend/src/lib/video/videoCompressionSettings.ts`
- `frontend/src/lib/video/videoCompressionTelemetry.ts`
- `backend/src/server.ts`
- `backend/src/observability/compressionMetrics.ts`

Validation used:
- `bun run check`
- `bun run build:only`
- desktop runtime smoke during packaging cycle

### 3) ImageFolder -> Shared Media Albums (B+, Core)
Source intent:
- Persistent, easier media organization and retrieval.

Wabi translation:
- Add persistent albums scoped to channel/DM.
- Add album CRUD + item CRUD.
- Add search/sort/pagination and grid/list browsing.
- Add moderation-aware deletion rules.
- Add message context-menu "add to album" flow.
- Add abuse controls for album item creation (rate + size policy).
- Add mobile-first layout polish for album navigation and item tooling on narrow screens.
- Add phase-3 organization controls:
  - manual drag-drop reorder mode for album items
  - optional featured-album pinning per scope
  - per-scope saved view preferences (`sort` + `view mode`)

Key implementation surfaces:
- `frontend/src/lib/components/MediaAlbumsTab.svelte`
- `frontend/src/lib/components/MessageContextMenu.svelte`
- `frontend/src/lib/components/MessageList.svelte`
- API integration through `frontend/src/lib/api.ts`
- `backend/src/api/albumRoutes.ts`
- `backend/src/db/repositories/albumRepository.ts`
- policy wiring in `backend/src/server.ts`

Validation used:
- `bun run check`
- `bun run build:only`
- manual browse/upload/delete role checks

### 4) MoreQuickReacts (C+, Core)
Source intent:
- Faster one-click reactions without opening picker every time.

Wabi translation:
- Add quick-reaction strip to message hover actions.
- Seed quick options from:
  - top existing reactions on the message
  - user-custom quick emoji set (if configured)
  - curated defaults (`thumbs up`, `heart`, `joy`, `fire`, `eyes`)
  - fallback to available emoji inventory
- Reuse existing `toggleReaction` behavior (no new backend path).
- Add per-user quick-reaction settings in Add-ons:
  - enable/disable toggle
  - custom quick emoji list management
- Add bounded candidate-scan guardrails for large emoji inventories.
- Add lightweight local counters (device-only) for quick-strip vs picker adoption.

Key implementation surfaces:
- `frontend/src/lib/components/MessageList.svelte`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/quickReactions.ts`
- `frontend/src/lib/quickReactionTelemetry.ts`

Validation used:
- `bun run check`
- `bun run build:only`
- manual quick-react add/remove + settings customization + local counter pass

### 5) GifCaptioner (C, Addon)
Source intent:
- Add captions/overlays to GIF/video media before sending.

Wabi translation (current Phase 3 slice):
- Keep send flow lightweight and reliable first:
  - GIF picker send now reuses composer text as caption text.
  - caption text runs through alias expansion + outgoing chat filter before send.
- Render caption text below GIF in timeline UI when present.
- Reuse existing `gif` message type + `text` field; no new backend schema/API for MVP.
- Phase 2 hardening now layered on top:
  - explicit caption length limit + hint
  - optional dedicated GIF caption input field
  - long-caption mobile readability polish.
- Phase 3 polish now layered on top:
  - optional caption style presets (`plain`, `accent`, `card`)
  - timeline renderer applies selected caption style preference.

Deferred parity items:
- In-media overlay rendering (caption baked into GIF/video output).
- Speech-bubble editing mode from original plugin.

Key implementation surfaces:
- `frontend/src/lib/components/Chat.svelte`
- `frontend/src/lib/components/MessageList.svelte`

Validation used:
- `bun run check`
- `bun run build:only`
- manual GIF send with/without caption + filter-block case

### 6) UnicodeEmojis (D, Addon)
Source intent:
- Replace outgoing emoji tokens with native Unicode equivalents.

Wabi translation (current Phase 3 slice):
- Added an opt-in Add-ons toggle (`UnicodeEmojis`) with local persistence (default OFF).
- For outgoing text surfaces, convert shortcode tokens to Unicode when mapping is known:
  - main chat send
  - DM send
  - GIF caption send
- Conversion scope is intentionally limited to non-custom emoji sources (`default` + `openmoji`).
- Mapping is derived from existing emoji metadata codepoints (Twemoji/OpenMoji URL/name), not a hardcoded table.
- Phase 2 hardening now layered on top:
  - per-source conversion toggles (`default` vs `openmoji`)
  - local counters (device-only) for converted/unknown/collision events
  - local-counter reset control in settings.
- Phase 3 polish now layered on top:
  - live conversion preview hints in chat/DM/GIF-caption compose surfaces
  - settings import/export path for UnicodeEmojis preferences (optional local-counter payload included).

Safety choices:
- custom emoji shortcodes remain unchanged
- unknown shortcode tokens remain unchanged

Key implementation surfaces:
- `frontend/src/lib/unicodeEmojis.ts`
- `frontend/src/lib/components/Chat.svelte`
- `frontend/src/lib/components/DMMessageView.svelte`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/markdown.ts`

Validation used:
- `bun run check`
- `bun run build:only`
- manual send checks for chat/DM/GIF caption with conversion ON and OFF

### 7) CustomStatusPresets (B, Round 1)
Source intent:
- Save custom statuses for fast reuse from the status bubble/menu.

Wabi translation:
- Added a local preset model for presence shortcuts:
  - label
  - presence state (`active` / `away` / `busy`)
  - optional note shown in sidebar profile card.
- Exposed full Add-ons management in settings:
  - ON/OFF toggle
  - add/remove/reset presets
  - quick apply from settings list.
- Integrated quick apply directly into sidebar status popup:
  - built-in status options stay first
  - custom presets render in a dedicated section below defaults.
- Preset safety guardrails:
  - bounded preset count (`12`)
  - sanitized label/note lengths
  - invalid/duplicate data cleanup on read.

Key implementation surfaces:
- `frontend/src/lib/customStatusPresets.ts`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/components/ChannelSidebar.svelte`
- `frontend/src/lib/displayEnhancements.ts`

Validation used:
- `bun run check`
- `bun run build:only`
- manual preset create/apply/remove/reset flow in settings + sidebar popup

### 8) StaffTag + TopRoleEverywhere (C, Round 1)
Source intent:
- Surface authority/context in chat by showing staff and top-role identity tags.

Wabi translation:
- Added independent Add-ons toggles:
  - `StaffTag`
  - `TopRoleEverywhere`.
- Rendered role/staff chips in major people surfaces:
  - chat message headers
  - user popouts
  - member list rows (`UserListTab`).
- Used role-tone badge styling to match Wabi theme variables and avoid Discord visual copy.

Key implementation surfaces:
- `frontend/src/lib/components/MessageList.svelte`
- `frontend/src/lib/components/UserPopout.svelte`
- `frontend/src/lib/components/UserListTab.svelte`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/displayEnhancements.ts`

Validation used:
- `bun run check`
- `bun run build:only`

### 9) TimedLightDarkMode (C, Round 1)
Source intent:
- Automatically switch between light and dark appearance profiles by time of day.

Wabi translation:
- Implemented as a local timed theme scheduler (not a Discord copy):
  - day and night hour boundaries
  - per-slot theme selection from Wabi theme catalog
  - background schedule checks + focus/visibility wake handling.
- Added Add-ons controls for:
  - enable/disable
  - day/night start hours
  - day and night target theme IDs.
- Wired scheduler into both main and detached app entry routes.

Key implementation surfaces:
- `frontend/src/lib/timedThemeMode.ts`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/routes/+page.svelte`
- `frontend/src/routes/detached/+page.svelte`

Validation used:
- `bun run check`
- `bun run build:only`

### 10) EmojiStatistics (C, Round 1)
Source intent:
- Show emoji inventory and usage context in one quick view.

Wabi translation:
- Added Add-ons toggle (`EmojiStatistics`) and local inventory summary controls.
- Renders local catalog metrics in settings:
  - total emoji count
  - custom vs default/open counts
  - top category breakdown.
- Kept behavior local-only (no server telemetry or remote aggregation required).

Key implementation surfaces:
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/displayEnhancements.ts`

Validation used:
- `bun run check`
- `bun run build:only`

### 11) BetterSearchPage (B+, Round 1)
Source intent:
- Keep search controls accessible while scanning long search result lists.

Wabi translation:
- Added Add-ons toggle (`BetterSearchPage`).
- While search is active, result controls are rendered in a sticky in-results toolbar:
  - match count
  - older-history loading state
  - full-history search/stop action
  - status feedback text.
- Search input remains in the header; control density shifts to the sticky result toolbar when enabled.

Key implementation surfaces:
- `frontend/src/lib/components/Chat.svelte`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/displayEnhancements.ts`

Validation used:
- `bun run check`
- `bun run build:only`

### 12) HideMutedCategories (B+, Round 1)
Source intent:
- Hide muted groups/channels from navigation to reduce sidebar noise.

Wabi translation:
- Added Add-ons toggle (`HideMutedCategories`) with local mute map.
- Added per-channel context action (`Mute Channel` / `Unmute Channel`).
- Sidebar channel lists can hide locally muted channels when toggle is enabled.
- Active channel remains visible even when muted to avoid navigation traps.

Key implementation surfaces:
- `frontend/src/lib/components/ChannelSidebar.svelte`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/displayEnhancements.ts`

Validation used:
- `bun run check`
- `bun run build:only`

### 13) UserNotes (B, Round 1)
Source intent:
- Keep private, local notes for specific users.

Wabi translation:
- Added local user-note persistence helper with guardrails (`max 400` chars).
- Completed user-popout editing flow:
  - note textarea
  - save/clear actions
  - local status feedback
  - character counter.
- Added Add-ons toggle (`UserNotes`) to enable/disable note editing surface.

Key implementation surfaces:
- `frontend/src/lib/userNotes.ts`
- `frontend/src/lib/components/UserPopout.svelte`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/displayEnhancements.ts`

Validation used:
- `bun run check`
- `bun run build:only`

### 14) RemoveNicknames (C+, Round 1)
Source intent:
- Prefer stable account names over alias/nickname variants.

Wabi translation:
- Added Add-ons toggle (`RemoveNicknames`).
- `MessageList` author resolution now prioritizes stable identity IDs (`userId`/`dbUserId`) and can render canonical account names in headers.
- Clickable mention/popout behavior remains tied to resolved account identity.

Key implementation surfaces:
- `frontend/src/lib/components/MessageList.svelte`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/displayEnhancements.ts`

Validation used:
- `bun run check`
- `bun run build:only`

### 15) LocalNicknames (Wabi extension)
Source intent:
- Let users assign private nickname overrides without mutating shared profile/account names.

Wabi translation:
- Added Add-ons toggle (`LocalNicknames`) and local nickname map with guardrails.
- Added set/clear local nickname controls in:
  - user list context menu
  - user popout action area.
- Applied local nickname rendering in:
  - message headers
  - user popout title
  - user list rows.
- Kept behavior local-only and device-scoped by design.

Key implementation surfaces:
- `frontend/src/lib/localNicknames.ts`
- `frontend/src/lib/components/MessageList.svelte`
- `frontend/src/lib/components/UserPopout.svelte`
- `frontend/src/lib/components/UserListTab.svelte`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/displayEnhancements.ts`

Validation used:
- `bun run check`
- `bun run build:only`

### 16) GoogleSearchReplace (C, Round 1)
Source intent:
- Replace/redirect quick search continuation into a browser search engine.

Wabi translation:
- Added Add-ons toggle (`GoogleSearchReplace`).
- Added `Search on Web` action in chat-search controls to open current in-chat query externally.
- Added user-selectable provider setting:
  - DuckDuckGo
  - Google
  - Bing
  - Brave
  - Startpage.
- Kept implementation frontend-only with no backend dependency.

Key implementation surfaces:
- `frontend/src/lib/searchEngineJump.ts`
- `frontend/src/lib/components/Chat.svelte`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/displayEnhancements.ts`

Validation used:
- `bun run check`
- `bun run build:only`

### 17) SpotifyControls (C, Round 1)
Source intent:
- Show practical playback controls when Spotify links are shared.

Wabi translation:
- Added Add-ons toggle (`SpotifyControls`).
- Added validated Spotify URL parser and inline embed renderer.
- Supported URL entity types:
  - track
  - album
  - playlist
  - artist
  - show
  - episode.
- For supported links, message timeline now renders inline Spotify control card with `Open in Spotify` action.

Key implementation surfaces:
- `frontend/src/lib/spotifyControls.ts`
- `frontend/src/lib/components/plugins/SpotifyControlsEmbed.svelte`
- `frontend/src/lib/components/MessageList.svelte`
- `frontend/src/lib/components/Settings.svelte`
- `frontend/src/lib/displayEnhancements.ts`

Validation used:
- `bun run check`
- `bun run build:only`

## Per-Plugin Delivery Checklist
- [ ] Spec file created/updated
- [ ] Grading recorded
- [ ] Phase status recorded in master plan
- [ ] Security/performance limits documented
- [ ] Feature implemented in Wabi-native code
- [ ] Manual tests done
- [ ] Build produced
- [ ] Rollback path documented

## Command Quick Reference
- `bun run check`
- `bun run build:only`
- `bun run check:zip-preview` (ZipPreview fixtures)
- `bun run build:tauri` (desktop packaging path when needed)

## Non-Negotiable Rules Used During Conversion
1. No blind copy/paste from BetterDiscord plugin internals.
2. Preserve functionality, rewrite implementation for Wabi architecture.
3. Keep safety/perf guardrails explicit in both code and docs.
4. Keep progress auditable in `PROJECT_DOCS` after every phase.
