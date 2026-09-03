# Plugin Porting Master Plan

## Goal
Port high-value plugin functionality into Wabi in controlled phases, with clear scope, risk controls, and auditable implementation notes.

## Conversion Playbook
- Step-by-step directions for the implemented BetterDiscord-to-Wabi workflow:
  - `BETTERDISCORD_CONVERSION_DIRECTIONS.md` (docs-history branch)

## Execution Rules
1. Functionality-first, but no blind copy/paste.
2. Build Wabi-native implementations (Svelte + existing backend services) in small, shippable slices.
3. Every phase must ship with:
   - scope checklist
   - test checklist
   - rollback notes
   - version bump note
4. Keep one source of truth for status in this file.

## Plugin Grading System
Grade each candidate before implementation so effort stays focused on high-value wins.

### Core vs Addon Routing Rule (User Approved)
- `Core`: any plugin/feature marked `A+`, `B+`, `C+` (or otherwise explicitly marked with `+`).
- `Addon`: everything else unless explicitly promoted.
- This rule takes precedence over raw letter score when deciding packaging surface.

### Inputs (1-5)
- User Impact: how much day-to-day value users get.
- Usage Frequency: how often the feature is expected to be used.
- Differentiation: how much this helps Wabi stand out.
- Implementation Effort: engineering complexity (higher = harder).
- Runtime Risk: performance/security/stability risk (higher = riskier).

### Weighted Score
`Score = (Impact*0.35 + Frequency*0.25 + Differentiation*0.20 + (6-Effort)*0.10 + (6-Risk)*0.10) * 20`

### Letter Grade
- `A` = 85-100 (ship early)
- `B` = 70-84 (strong candidate)
- `C` = 55-69 (nice-to-have)
- `D` = 40-54 (low priority)
- `F` = 0-39 (skip unless strategic reason)

## Phase Model
1. `Phase 0 - Discovery`
   - Capture behavior, UX, and integration points.
   - Define security/perf constraints and data limits.
2. `Phase 1 - MVP`
   - Core feature, minimal UI, safe defaults.
3. `Phase 2 - Harden`
   - Edge cases, abuse protection, telemetry, better UX.
4. `Phase 3 - Polish`
   - Quality-of-life options, accessibility, docs cleanup.

## Plugin Queue
| Plugin | Priority | Grade | Score | Track | Status | Current Phase | Owner Notes |
|---|---|---|---|---|---|---|---|
| ZipPreview | P0 | A+ | 88 | Core | Done | Complete | Inline text/image previews, sorting/icons, settings controls, fixture smoke checks, and desktop production build verification are complete |
| VideoCompressor | P0 | B+ | 79 | Core | Done | Complete | Runtime-aware presets, sampled-metadata estimates, verification metadata, and opt-in metrics/observability are complete with production build verification |
| ImageFolder | P0 | B+ | 81 | Core | Done | Complete | Albums CRUD, role-aware limits, mobile polish, drag-drop reorder, featured pinning, and per-scope view preferences are complete |
| MoreQuickReacts | P1 | C+ | 67 | Core | Done | Complete | Quick-strip UX, custom emoji controls, local usage counters, and mobile long-press quick actions are complete |
| GifCaptioner | P2 | C | 57 | Addon | Done | Complete | Caption flow, limits, dedicated caption input, and style presets are complete; overlay rendering evaluated and intentionally out of core scope |
| UnicodeEmojis | P3 | D | 48 | Addon | Done | Complete | Source toggles, local counters, compose previews, prefs import/export, and compatibility smoke coverage are complete |

## Round 1 Translation Status (Current Codebase)
The following entries from `PLUGIN_GRADING_ROUND1.md` (docs-history branch) are implemented as Wabi-native features.

| Plugin (Round 1) | Status | Wabi Translation Notes |
|---|---|---|
| ChatAliases | Implemented | Slash-style alias expansion in outgoing chat flow + settings management. |
| ChatFilter | Implemented | Incoming/outgoing filtering with censor/hide modes and editable blocked-term set. |
| CustomQuoter | Implemented | Configurable quote template used by message action `Copy Quote`. |
| ImageUtilities | Implemented | Reverse-image search provider controls from image viewer/menu. |
| NotificationSounds | Implemented | Custom notification sound upload/selection and volume controls. |
| PinDMs | Implemented | Local DM pinning with pinned-first ordering and settings reset path. |
| SpellCheck | Implemented | Browser spellcheck toggle for main chat + DM composer. |
| SplitLargeMessages | Implemented | Automatic chunking with user-configurable chunk size guardrails. |
| Translator | Implemented | Translator-assist runtime integration and per-user model/language settings. |
| CharCounter | Implemented | Live counters in chat + DM composers. |
| ClickableMentions | Implemented | Click usernames and rendered `@mentions` to open `UserPopout`. |
| CompleteTimestamps | Implemented | Selectable timestamp display modes (`compact` / `complete` / `detailed`). |
| CustomStatusPresets | Implemented | Wabi translation: saved status presets (label + presence + optional note), quick-apply from sidebar status popup, and add-on management controls. |
| MessageUtilities | Implemented | Message hover/context actions are consolidated and runtime-gated in Add-ons (`quick mention`, local pin actions, edit/delete affordances). |
| QuickMention | Implemented | Fast mention action is available in message utilities/context menu and can be toggled from Add-ons. |
| PersonalPins | Implemented | Local message pin map with per-channel persistence, clear/reset controls, and timeline pin indicators. |
| LastMessageDate | Implemented | User popout shows most recent message time for the active channel when enabled. |
| ShowConnections | Implemented | User popouts render connection metadata from profile handle and linked URL parsing. |
| FriendNotifications | Implemented | Local desktop status-change notifications with tracked-user mode and per-user tracking controls. |
| BetterFriendList | Implemented | User panel list supports search/filter/sort and status summary counters when enabled. |
| BetterSearchPage | Implemented | Search-mode toolbar in chat can stay pinned above results while scrolling matched messages. |
| HideMutedCategories | Implemented | Wabi translation: local mute map + optional sidebar hiding of muted channels (current channel stays visible). |
| RevealAllSpoilers | Implemented | Ctrl/Cmd-click reveal-all within message, with minimum-role control. |
| ReadAllNotificationsButton | Implemented | Sidebar action to clear unread notifications across channels. |
| ServerCounter | Implemented | Wabi translation: workspace channel counter chip in channel sidebar. |
| BetterNsfwTag | Implemented | Wabi translation: high-visibility NSFW-like channel tag in sidebar. |
| EmojiStatistics | Implemented | Local emoji inventory totals and top-category breakdown are available in Add-ons settings. |
| UserNotes | Implemented | User popout now supports local private note editing (save/clear) per user with local persistence. |
| RemoveNicknames | Implemented | Optional canonical account-name display in chat headers when messages carry alias-style names. |
| LocalNicknames (Wabi extension) | Implemented | Private per-user nickname overrides (device-local) now render in chat headers, user popouts, and user-list surfaces with set/clear controls. |
| GoogleSearchReplace | Implemented | Wabi translation: in-chat search can jump to browser search via `Search on Web`, with selectable provider (Brave default, DuckDuckGo/Startpage/Bing/Google) plus a custom URL template that uses `{query}` insertion. |
| SpotifyControls | Implemented | Wabi translation: Spotify links render inline playable embed controls in message timeline, runtime-gated by Add-ons toggle. |
| StaffTag | Implemented | Staff marker chips for owner/admin/mod are shown in chat headers, popouts, and user-list surfaces. |
| TopRoleEverywhere | Implemented | Top-role chips render across chat headers, user popouts, and user-list rows with role-tone styling. |
| TimedLightDarkMode | Implemented | Local schedule-driven day/night theme switching with per-slot theme selection and hourly boundary checks. |
| WriteUpperCase | Implemented | Optional sentence-start capitalization in outgoing chat/DM/caption paths. |

### Round 1 Still Pending
- `ServerFolders` (requires server-list surface not currently present in Wabi)
- `DisplayServersAsChannels` (depends on server/workspace surface strategy)
- `GameActivityToggle` (currently marked out-of-scope for Wabi product direction)
- `RemoveBlockedUsers` (requires explicit block/ignore model in current architecture)
- `ServerDetails` (depends on server-list tooltip/UI surface)
- `ShowBadgesInChat` (requires badge model and policy decisions)
- `EditChannels` / `EditRoles` / `EditServers` / `EditUsers` (low-priority local-mutation set; local nickname subset delivered via `LocalNicknames`)
- `OpenSteamLinksInApp` (platform-specific, low transfer value)
- `ServerHider` (requires server-list surface + moderation/product policy)
- `OldTitleBar` (explicitly not relevant)

## Approved Product Feature: Shared Media Albums
- Status: `Approved`
- Track: `Core`
- Rationale: align media browsing with Line/Discord-style album flows while keeping one consistent Wabi UX across desktop/mobile.
- Spec: `FEATURE_SPEC_MEDIA_ALBUMS.md` (this directory)

## ZipPreview Initial Breakdown
### Phase 0 - Discovery
- Enumerate how Wabi currently renders attachments.
- Define where ZIP metadata parsing lives (frontend-only vs backend assist).
- Set hard limits: archive size, entry count, preview bytes, timeout.

### Phase 1 - MVP
- Detect `.zip` attachments.
- Parse ZIP central directory without full extraction.
- Show file tree, entry count, total uncompressed size.
- Expand/collapse panel in message attachment UI.

### Phase 2 - Harden
- Add limits + graceful failure messaging.
- Cache parsed metadata.
- Add simple filename search/filter.

### Phase 3 - Polish
- Optional inline preview for safe text/image files.
- Better sorting and icons.
- Settings toggles.

### ZipPreview Progress Update (2026-02-27)
- Implemented in `frontend`:
  - ZIP detection in message attachments.
  - Reusable `ZipPreviewPanel` with expand/collapse.
  - In-browser central-directory parsing (`parseZipPreviewMetadata`).
  - Guardrails: archive-size cap, entry render cap, fetch timeout, encrypted-file fallback.
  - In-memory metadata cache keyed by URL+size with TTL + simple LRU eviction.
  - Entry-name filter/search in preview panel.
  - Parser hardening for split/multi-disk ZIP rejection and central-directory consistency checks.
  - Retry action in panel error state (recover without remounting).
  - Phase 3 UX:
    - entry sort controls (`name/size asc/desc`)
    - entry-type icon tags
    - inline preview for safe text/image entries
    - add-on settings for ZIP preview enablement and inline-preview enablement
  - Extraction hardening for inline previews:
    - bounded inflate stream reads with strict max-output cap to avoid oversized decompression payloads.
  - Fixture smoke command `bun run check:zip-preview` covering malformed/split/ZIP64-boundary cases.
- Completion notes:
  - fixture smoke pass: `bun run check:zip-preview`
  - desktop production build verified: `bun run build:tauri`

## VideoCompressor Initial Breakdown
### Phase 0 - Discovery
- Confirm desktop encoder strategy and output codec matrix.
- Lock max input size, timeout, and CPU safeguards.
- Confirm integration points in composer + resumable upload pipeline.

### Phase 1 - MVP (Desktop First)
- Trigger compression prompt for over-limit video attachments.
- Preset-based encode (resolution + frame rate).
- Queue compressed output into existing upload flow.

### Phase 2 - Harden
- Accurate size estimate improvements.
- Cancellation + retry + fallback behavior.
- Telemetry and failure classification.

### Phase 3 - Polish
- Optional default preset setting.
- Android capability tuning.
- Better UX copy and docs.

### VideoCompressor Progress Update (2026-02-26)
- Implemented in `frontend`:
  - Over-limit video detection path in composer file intake.
  - Compression decision modal with preset picker.
  - Progress + cancel + retry + keep-original + remove-file actions.
  - Compression runtime setting (`ON/OFF`) and default preset setting in `Settings`.
  - Runtime-aware profile tuning:
    - desktop profile keeps `balanced_720p`/`quality_1080p` options.
    - Android/iOS profile adds `mobile_540p`, tighter timeout, and max-input thermal guardrail.
  - Optional client metrics emission for success/failure/cancelled/skipped outcomes with failure-code tags.
- Implemented in `backend` + admin surface:
  - Metrics ingestion endpoint (`/api/telemetry/video-compression`) with auth + rate limits, gated by `WABI_VIDEO_COMPRESSION_CLIENT_METRICS_ENABLED`.
  - Compression observability snapshot extended with client video-compression counters, runtime summaries, and top failure codes.
  - Admin panel now renders client compression metrics alongside server upload/download compression stats.
- Implemented in `frontend` + resumable upload path:
  - Compression modal now samples input metadata and shows a preset-aware output-size estimate.
  - Modal now renders borderline suggestion copy for near-threshold/low-gain cases.
  - Client compression metadata now rides in resumable init refresh requests for compressed files.
- Implemented in `backend` resumable finalization path:
  - Upload metadata sanitizer for client compression claims (`runtime/preset/original/compressed/codec`).
  - Finalization-time verification payload (size + codec + mime checks) persisted in resumable meta.
  - Verification metadata now returned from resumable `init/status/complete` responses.
- Completion notes:
  - desktop production build verified: `bun run build:tauri`
  - runtime-aware compressor path and upload verification wiring are complete.

### ImageFolder Progress Update (2026-02-26)
- Implemented in `frontend` + `backend` API surface:
  - Persistent album CRUD + album item CRUD paths.
  - Grid/list view switch, search, sort, and client-side pagination in albums tab.
  - Moderation-aware deletion guards (album owner/item owner/mod roles).
  - Message context-menu entry to add attachments directly into albums.
  - Policy-backed abuse controls for album item creation:
    - per-role size caps
    - per-user per-scope uploads/minute limits
    - per-scope uploads/minute saturation guard
  - Structured limit errors now surface in albums UI with retry guidance.
- Implemented in `frontend` (2026-02-27 mobile polish pass):
  - responsive album list/tile behavior for narrower screens
  - mobile-friendly toolbar/action stacking
  - small-screen item/meta/pagination layout tuning
- Implemented in `frontend` + `backend` (2026-02-27 phase-3 closure pass):
  - manual drag-drop reorder mode for album items with persisted server-side order
  - per-scope featured album pin/unpin support (`/api/albums/:id/featured`)
  - per-scope persisted view preferences (`sort mode`, `view mode`) for albums tab
- Completion notes:
  - album CRUD, moderation guards, limits, featured pinning, and reorder persistence are complete in frontend/backend integration.

### MoreQuickReacts Progress Update (2026-02-26)
- Implemented in `frontend`:
  - Added a quick-reaction strip to per-message hover actions in `MessageList`.
  - Quick-reaction candidates are seeded from top existing reactions on a message, then filled from a curated defaults list (`thumbs up`, `heart`, `joy`, `fire`, `eyes`) with fallback to available emoji inventory.
  - One-click quick-react toggles now reuse existing reaction add/remove behavior, preserving current backend/state flows.
  - Added per-user quick-reaction setting controls in `Settings`:
    - ON/OFF toggle for quick strip
    - custom quick emoji set management (add/remove/clear)
  - Added bounded custom quick-set guardrail (`max 12` custom emoji IDs) with dedupe.
  - Added bounded alias/fallback scan pool for large emoji inventories to avoid full catalog scans during candidate resolution.
  - Added lightweight local usage counters (device-only):
    - quick-strip clicks
    - full picker opens
    - quick-strip share and reset action in settings.
- Implemented in `frontend` (2026-02-27 UX pass):
  - mobile long-press action tray now surfaces quick reactions in a bounded horizontal strip.
- Completion notes:
  - desktop + mobile quick-reaction flows are complete with settings/local-counter integration.

### GifCaptioner Progress Update (2026-02-27)
- Implemented in `frontend`:
  - GIF picker send path now uses composer text as a caption (`sendMessage(..., 'gif')`) instead of hardcoded empty text.
  - Caption text now runs through alias expansion + outgoing chat filter before send.
  - GIF message renderer now displays caption markdown below the GIF when caption text is present.
  - Hardened caption flow:
    - explicit caption length guardrail (`280` chars) with user-facing hint
    - optional dedicated GIF caption field in composer flow
    - long-caption rendering polish for narrower screens
  - Phase 3 caption-style polish:
    - settings-side caption style presets (`plain`, `accent`, `card`)
    - GIF timeline caption renderer now applies per-user style preference
- Completion notes:
  - advanced overlay/baked-caption renderer evaluated and intentionally excluded from core scope due encode-cost/risk tradeoff.

### UnicodeEmojis Progress Update (2026-02-27)
- Implemented in `frontend`:
  - Added opt-in `UnicodeEmojis` add-on setting (default OFF) with local persistence.
  - Added outgoing shortcode-to-Unicode conversion utility for non-custom emoji sources (`default`/`openmoji`), derived from emoji codepoint metadata.
  - Wired conversion into:
    - main chat outgoing send path
    - DM outgoing send path
    - GIF caption outgoing path.
  - Expanded shortcode parser compatibility to include `+`/`-` characters for broader emoji name support.
  - Phase 2 hardening:
    - per-source conversion toggles (`default` / `openmoji`)
    - local conversion counters (device-only) for:
      - converted tokens
      - unknown shortcode tokens
      - shortcode collisions
    - settings reset action for local counters
  - Phase 3 polish:
    - live composer conversion preview hints in chat/DM/GIF caption paths
    - settings-side import/export for UnicodeEmojis preferences (with optional local-counter payload)
- Completion notes:
  - compatibility smoke matrix added: `bun run check:unicode-emojis`.

### CustomStatusPresets Progress Update (2026-02-28)
- Implemented in `frontend`:
  - New persistent custom-status preset store with guardrails (`max 12`, dedupe, label/note length caps, active-preset state).
  - Add-on management controls in `Settings`:
    - ON/OFF toggle
    - preset add/remove/reset
    - per-preset quick apply (status + active preset selection).
  - Sidebar status popup integration:
    - built-in presence options (`active` / `away` / `busy`) preserved
    - custom preset list rendered below defaults when enabled
    - applying a preset updates presence and stores active preset locally.
  - Profile card translation:
    - active preset note/label now shown under self user tag in sidebar.
- Completion notes:
  - frontend checks/build validated with existing workspace warning baseline (`bun run check`, `bun run build:only`).

### StaffTag + TopRoleEverywhere Progress Update (2026-02-28)
- Implemented in `frontend`:
  - Added explicit Add-ons toggles for `StaffTag` and `TopRoleEverywhere` in settings.
  - Chat timeline translation:
    - message headers now render role-tone top-role badges when enabled
    - staff marker chip renders for owner/admin/mod when enabled.
  - User profile translation:
    - `UserPopout` now renders top-role and staff chips with role-tone styling.
  - Member-list translation:
    - `UserListTab` rows now render top-role and staff chips behind the same toggles.
- Completion notes:
  - changes validated with standard frontend checks/build (`bun run check`, `bun run build:only`).

### TimedLightDarkMode Progress Update (2026-02-28)
- Implemented in `frontend`:
  - Added new persisted settings store for timed theme mode:
    - enable/disable
    - day start hour
    - night start hour
    - day-theme and night-theme IDs.
  - Added local scheduler runtime:
    - applies schedule at startup
    - re-checks at minute boundaries
    - wakes/re-applies on window focus or visibility return.
  - Added Add-ons controls in settings for schedule/theme selection.
  - Wired scheduler into both app entry routes:
    - `routes/+page.svelte`
    - `routes/detached/+page.svelte`.
- Completion notes:
  - local-only behavior by design (no server-side theme preference writes for scheduled flips).

### BetterSearchPage + HideMutedCategories + UserNotes + RemoveNicknames Progress Update (2026-02-28)
- Implemented in `frontend`:
  - `BetterSearchPage` translation:
    - new Add-ons toggle in settings
    - sticky in-results search toolbar in `Chat` while search is active (result counts + full-history scan controls)
    - existing header search control remains available, while result controls are routed to sticky toolbar when enabled.
  - `UserNotes` translation:
    - completed local user-note persistence helper (`wabi.userNotes.byUserId`) with note-length guardrail.
    - `UserPopout` now supports note editing with `Save` / `Clear` and local-only status feedback.
    - feature is runtime-gated behind a dedicated Add-ons toggle.
  - `HideMutedCategories` translation:
    - added Add-ons toggle and local muted-channel registry.
    - channel context menu now supports local `Mute/Unmute Channel`.
    - sidebar channel lists can hide muted channels while preserving visibility for the currently active channel.
    - muted-channel registry can be cleared from Add-ons settings.
  - `RemoveNicknames` translation:
    - added Add-ons toggle for canonical account-name display behavior.
    - `MessageList` now resolves message authors by stable identity IDs first and can render canonical usernames when alias-style names are present in message payloads.
- Completion notes:
  - frontend checks/build validated with warning-only baseline (`bun run check`, `bun run build:only`).

### GoogleSearchReplace + SpotifyControls + LocalNicknames Progress Update (2026-02-28)
- Implemented in `frontend`:
  - `GoogleSearchReplace` translation:
    - added Add-ons toggle (`GoogleSearchReplace`) and provider setting (DuckDuckGo/Google/Bing/Brave/Startpage).
    - search UI in chat now exposes `Search on Web` action to open the current in-chat query in the selected browser search engine.
    - behavior remains local/client-side with no backend dependency.
  - `SpotifyControls` translation:
    - added Add-ons toggle (`SpotifyControls`).
    - message timeline now detects supported Spotify links (`open.spotify.com`) and renders inline playable embed controls.
    - supports track/album/playlist/artist/show/episode URL shapes.
  - `LocalNicknames` (Wabi extension to nickname features):
    - added Add-ons toggle (`LocalNicknames`) and local nickname store with guardrails.
    - user-list context menu and user-popout now support `Set Local Nickname` and `Clear Local Nickname`.
    - local nicknames now render in chat message headers, user popouts, and user-list rows.
- Completion notes:
  - frontend checks/build validated with warning-only baseline (`bun run check`, `bun run build:only`).

## Required Artifacts Per Plugin
- Spec: `PLUGIN_SPEC_<NAME>.md` (docs-history branch, old-specs/)
- Decisions: `PLUGIN_DECISIONS_<NAME>.md` (docs-history branch, plugin-decisions/)
- Changelog note in final implementation PR/commit message.

## Working Checklist (Use Every Phase)
- [x] Scope locked
- [x] Integration points listed
- [x] Security/perf limits documented
- [x] Implementation merged
- [x] Manual/fixture validation complete
- [x] Build produced (desktop where applicable)
- [x] Docs/status updated
