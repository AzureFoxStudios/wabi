# Wabi Hermes Test Regression Plan

> **For Hermes:** Use the `systematic-debugging` and `subagent-driven-development` skills when executing this plan. Do not implement from the raw test notes without first verifying each claim against the current runtime.

**Goal:** Convert the latest Wabi Hermes test notes into an evidence-backed regression ledger, then resolve correctness, persistence, interaction, and visual issues in a controlled order without destabilizing unrelated work.

**Architecture:** Treat this as a product-wide audit, not one large UI cleanup. Each report is traced across the Svelte frontend, Rust/API persistence layer, Socket.IO contracts, addon gates, and live runtime. Correctness and softlock issues come first; visual polish follows only after the underlying state and data contracts are verified.

**Tech Stack:** Svelte/SvelteKit frontend, TypeScript stores and Socket.IO client, Rust/Axum Wabi server, WabiDB projections, addon/workspace registry, browser/runtime smoke tests.

---

## Execution rules

- **Planning phase only:** this document does not authorize implementation yet.
- Preserve the existing dirty tree. Current unrelated modified files include channel, lore, sidebar, socket, and documentation work; do not reset, checkout, stash, or commit them as part of this audit without an explicit scope decision.
- Every item receives one of: `confirmed`, `partial`, `not reproduced`, `already fixed`, or `needs runtime smoke`.
- No item is marked fixed from source inspection alone. Build-verified and runtime-proven are separate statuses.
- For realtime features, verify both directions: frontend emit → backend handler → persistence/broadcast → frontend listener/store update.
- For uploads, verify the complete path: file classification → upload endpoint → attachment record → projection/API response → UI rendering.
- For workspace views, every full view must retain a visible return-to-Messages path. No reload-only escape path is acceptable.
- Do not add a new setting or control until its ownership is decided: server policy, user identity styling, local readability preference, or addon capability.

## Deliverables

1. This implementation plan.
2. A canonical evidence ledger, to be created during the audit phase:
   `docs/audits/2026-08-11-wabi-hermes-regression-audit.md`
3. Targeted regression tests for confirmed correctness bugs.
4. A runtime smoke matrix covering auth, uploads, messaging, workspaces, notifications, and calls.
5. A final decision list for unresolved product-shape questions (DM layout, wiki authoring model, emoji scale, notification/sound placement, and Longcat theme disposition).

---

# Phase 0: Audit setup and claim verification

### Task 0.1: Record the baseline

**Files:**
- Read: current repository status and recent history
- Create: `docs/audits/2026-08-11-wabi-hermes-regression-audit.md`

Record the dirty-tree state, current branch/commit, frontend check baseline, server check baseline, and running-process/port state. Do not clean or modify unrelated work.

**Verification:** Run `git status --short`, the project’s documented frontend check, and non-mutating process/port probes. Record exact results.

### Task 0.2: Build the evidence ledger

Use these columns for every report:

| Area | User report | Current status | Frontend evidence | Backend/persistence evidence | Reproduction | Next action | Priority |
|---|---|---|---|---|---|---|---|

Group rows by runtime/correctness, persistence, messaging, media/calls, navigation, and visual/product decisions.

### Task 0.3: Trace existing implementations before creating work

Specifically verify existing code before opening tasks for:

- notifications and notification audio
- emoji and sticker manifests/custom emotes
- password-change auth flow
- reader workspace and shared workspace return bar
- voice-channel docked/embedded state
- upload orchestration, resumable upload, media albums
- profile/banner/overlay upload controls
- addon/payment visibility gates
- Notes, Planner, forum/wiki, and Code panel registration

Items already present in code become `implemented / needs smoke` or `partial`, not automatically missing.

---

# Phase 1: P0 runtime safety and softlock prevention

Order these before visual changes because they can trap users or corrupt state.

### Task 1.1: Reproduce and isolate the `title` undefined crash

Trace the minified stack back to the source component and identify which object is undefined, where it originates, and whether the failure is from a missing route/panel manifest, stale persisted state, or an unsafe derived value.

**Acceptance:** a minimal reproduction or fixture exists; the ledger names the exact source boundary and the safe fallback/invalidation behavior.

### Task 1.2: Audit password-change session lifecycle

Trace Rust `/api/auth/change-password`, token issuance/revocation, frontend auth store updates, socket reconnect behavior, and login/bootstrap handling.

**Acceptance:** determine whether password change is intended to preserve the current session or require a controlled re-login. In either case, the user gets a deterministic next step and cannot enter an authentication loop.

### Task 1.3: Audit push navigation and Model View takeover

Trace notification/push payload handling, deep-link parsing, workspace/addon tab routing, and any code that opens Model View from a push event.

**Acceptance:** push navigation opens the intended target without replacing the shell unexpectedly, and every resulting view has a visible escape route.

### Task 1.4: Remove reader full-screen softlock path

Verify the current Reader route/workspace state and all full-screen branches. Decide whether Reader is a center-stage workspace or an application takeover; the default plan is center-stage with the shared workspace bar.

**Acceptance:** Reader HTML/image mode renders within the normal shell, and Messages is reachable without reload, browser back, or keyboard knowledge.

### Task 1.5: Diagnose folder/text-channel state corruption

Trace folder creation, channel type assignment, parent/position persistence, channel list hydration, and leave/reopen behavior across frontend stores and Rust channel APIs.

**Acceptance:** a folder cannot accidentally become a text channel; leaving/reopening does not convert or misplace stored content; malformed legacy records are handled explicitly.

### Task 1.6: Correct audio/video classification

Trace the file picker, MIME/extension classifier, upload metadata, message renderer, and media element selection. Test common audio formats independently from video formats.

**Acceptance:** audio is rendered with an audio player, video with a video player, and unsupported formats receive a useful error instead of a misleading video MIME error.

---

# Phase 2: P0 persistence and collaborative state

### Task 2.1: Profile picture and profile image persistence

Separate avatar/profile picture, banner, overlay/frame, and rendered profile-card image paths. Verify upload endpoint, auth, storage, DB/projection persistence, bootstrap payload, socket fanout, and observer-side store updates.

**Acceptance:** upload survives reload and a second client sees it; settings exposes the correct upload affordance; missing/failed uploads show an actionable error.

### Task 2.2: Folder membership and server channel ordering

Verify parent ID and position fields at create/update/list/bootstrap boundaries. Confirm the server response is authoritative and the client does not overwrite it with stale local state.

**Acceptance:** channels remain inside folders after reload and server/channel ordering is remembered across clients.

### Task 2.3: Album/gallery image upload path

Audit `uploadOrchestrator`, resumable upload, album creation, album-item insertion, attachment MIME fields, and gallery hydration/rendering.

**Acceptance:** one image, multiple images, captions, retry/resume, and reload all work; orphaned uploaded files and failed album records are handled or reported.

### Task 2.4: Wiki image uploads with captions and authoring model

Decide whether wiki content is markdown/document blocks, rich editor content, or a layout-capable page model before implementation. Audit the existing route/API/storage path.

**Acceptance:** the plan distinguishes the minimum usable wiki upload/caption feature from advanced layout editing, which remains a separately scoped product decision.

### Task 2.5: Server-enforced channel timer

Trace timer configuration, channel state, message send path, reconnect behavior, and server authorization. The client countdown is not enforcement.

**Acceptance:** server rejects messages/actions after expiry, clients receive the authoritative state, and the UI clearly explains who can set/extend the timer and what enforcement means.

### Task 2.6: Voice channel full-status and connection contract

Trace `joinVoiceChannel`, `connectedVoiceChannelIds`, active transmit state, listening state, CallModal viewport state, global CallView gating, and backend participant broadcasts. Use the real `VoiceChannels = HashMap<String, Vec<VoiceParticipant>>` model.

**Acceptance:** channel status accurately distinguishes connected, transmitting, listening, and disconnected; joining does not unexpectedly take over center stage; explicit open/focus does work; two-client audio smoke remains required.

---

# Phase 3: Messaging, identity, and composer behavior

### Task 3.1: Restore DM composer actions

Inventory the DM composer against the text-channel composer and decide which actions are shared: emoji, GIF, media/upload, voice, and any DM-only controls. Do not duplicate the composer without an explicit design decision.

### Task 3.2: Decide DM visual relationship to text channels

Choose between shared composer/message primitives with a distinct DM shell, or a deliberately separate DM view. Preserve the same interaction affordances unless there is a documented DM-specific reason not to.

### Task 3.3: Mentions and tagging

Trace mention parsing, entity storage, server delivery, DM behavior, text-channel rendering, notification/highlight behavior, and user lookup. Add separate acceptance cases for DM tagging and text-channel mention highlighting.

### Task 3.4: Stable offline identity fallback

Trace presence disconnect handling and display-name derivation. `user-x` must not replace a known username merely because presence is offline.

### Task 3.5: User context menu and DM pinning

Add a product decision for actions: Add Friend, Send DM, Block, and any staff/moderation actions. Define DM pinning ownership and persistence before implementation; do not confuse pinned messages with pinned conversations.

### Task 3.6: Send button visibility

Trace composer layout, emoji popover focus, conditional rendering, disabled state, and responsive CSS. The button must have one stable visibility rule and must not appear only after an unrelated emoji interaction.

### Task 3.7: Emoji/sticker/GIF system

Audit the size and shape of `/openmoji/emojis.json`, sticker manifest, custom emote type mapping, search/filter UI, typed suggestions, and Giphy configuration/health. Decide whether recognized emoji-like stickers should be merged, separated, or explicitly labeled.

**Acceptance:** filtering is usable at the actual dataset size; typed suggestions work; stickers and emojis have clear relationships; Giphy reports configured/unconfigured/error state instead of silently appearing connected.

---

# Phase 4: Media, notifications, sounds, and upload UX

### Task 4.1: Establish notification and sound surfaces

Trace settings, browser permission, in-app display, push notifications, notification audio, call ringtone, mute/squelch settings, and Tauri-specific behavior.

**Acceptance:** document where users configure notifications and sounds, what works in browser versus desktop, and what permission/state prevents playback.

### Task 4.2: Redesign image upload interaction

Define the desired interaction before CSS work: preview, progress, cancel/retry, caption, album choice, spoiler, failure state, and post-upload confirmation. Reuse the existing upload orchestration rather than creating a second upload path.

### Task 4.3: Media renderer regression matrix

Test audio, video, images, albums, captions, and unsupported files through message rendering and gallery/album rendering. Include reload and second-client visibility.

---

# Phase 5: Navigation, workspace, and settings cleanup

### Task 5.1: Resolve workspace chevron collision

Audit the Planner/forum-board/wiki/Code entry point, the channel list edge, and the right-dock/workspace registry. Choose one ownership location for the navigation affordance; do not stack competing chevrons beside the channel list.

### Task 5.2: Notes surface reconciliation

Compare the full DM Notes implementation with the legacy Notes view. Select one canonical state/store and make the other an alias or remove it after migration verification.

### Task 5.3: Search-channel focus shell

Make focus treatment span the entire search control, then evaluate the square-to-rectangle transition used by main-channel search. Verify keyboard focus, escape, mobile layout, and no layout jump.

### Task 5.4: Active status popup behavior

Trace outside-click handling, selected status persistence, and an explicit invisible status. Clicking elsewhere must close the popup; Invisible must be a real presence state, not merely a hidden menu.

### Task 5.5: Addon gates and redundant controls

Verify payment controls against the payment addon capability gate. Review Map and More against actual remaining actions, then remove or consolidate only after confirming no hidden behavior is lost.

### Task 5.6: Channel deletion control

Trace channel settings permissions, delete API, confirmation flow, child-channel behavior, and client list updates. Add the control only for authorized users with safe confirmation and server-side authorization.

---

# Phase 6: Personalization and visual polish

### Task 6.1: Username font color ownership

Determine whether username font color is a user identity setting, viewer-side readability setting, theme token, or server policy. Trace the sickly-green default through palette/token generation and profile rendering.

**Acceptance:** the intended owner can change it, the value persists, other viewers receive the correct value, and contrast remains acceptable.

### Task 6.2: Profile cards and role badges

Prevent profile cards from being cropped in text channels. Redesign Owner/Staff badges around hierarchy and recognizable meaning rather than adding more color noise.

### Task 6.3: React menu interaction

Audit hover/focus/touch behavior and action-bar CSS. Desktop hover may emphasize the menu, but it must not permanently occupy the UI or disappear before it can be used.

### Task 6.4: Reader HTML rendering

Define supported HTML input and sanitization boundary. If the reader accepts HTML, render the document as a document within the reader surface rather than displaying source-like or malformed output. Preserve safe handling for scripts, embeds, and external resources.

### Task 6.5: Wiki authoring scope

After the Phase 2 data audit, choose the wiki authoring level: usable upload/caption blocks first, then optional advanced layout editing. Do not let “advanced editor” expand the initial correctness batch.

### Task 6.6: Longcat theme disposition

Verify whether Longcat is a valid selectable theme, an accidental model/provider entry, or corrupted theme data. Remove it only after confirming no user configuration or theme registry depends on it; otherwise rename/reclassify it.

---

# Verification matrix

## Static/build gates

- Frontend type/check command used by the repository, compared against the clean baseline.
- Rust server check/test command for touched backend crates.
- Targeted unit tests for classifiers, stores, payload normalization, and permission gates.
- No source-regex tests; test behavior through imported functions/components or real endpoints.

## Runtime smoke gates

1. Fresh login and bootstrap.
2. Change password and recover/re-login according to the chosen contract.
3. Push/deep-link into each workspace, then return to Messages.
4. Upload avatar/banner/overlay; reload; verify from a second client.
5. Upload image/audio/video; verify correct renderer and persisted attachment.
6. Create album, add images/captions, reload gallery.
7. Create folder/channel hierarchy; reload from two clients.
8. Expire a channel timer and verify server rejection.
9. DM send, mention, offline-name fallback, pin, context menu.
10. Text-channel mention highlight and profile-card positioning.
11. Voice channel join, status, explicit center-stage open, leave; two-client audio.
12. Notification permission, in-app notification, sound/ringtone settings.
13. Reader HTML/image mode and escape path.
14. Wiki image/caption flow and safe rendering.

## Final completion rule

A row is complete only when:

- the root cause is recorded;
- the implementation or product decision is explicit;
- the targeted regression test/build gate passes where applicable;
- the affected runtime path is smoke-tested;
- unrelated dirty-tree work remains intact;
- the audit ledger distinguishes `build-verified` from `runtime-proven`.

## Open product decisions to resolve before implementation

1. Should DMs share the text-channel composer and message primitives, or intentionally use a distinct shell?
2. Are Notes, Reader, Wiki, Planner, Forum, and Code all center-stage workspaces with the shared return bar?
3. What exactly is the emoji/sticker relationship, and what dataset/filtering UX is acceptable at full scale?
4. Where should notification and sound controls live, and which surfaces are supported?
5. Is wiki advanced layout editing in this pass, or only reliable image/caption blocks?
6. Is Longcat removed, renamed as an AI/provider item, or retained as a legitimate theme?
7. Is DM pinning conversation-level, message-level, or both?
8. Which users may change username font color, and is the color viewer-controlled or identity-controlled?

**Plan status:** ready for claim-verification audit; no implementation authorized yet.
