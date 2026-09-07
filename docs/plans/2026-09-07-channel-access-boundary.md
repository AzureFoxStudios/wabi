# Channel content authorization across REST and Socket.IO

Status: channel-content boundary implemented locally; final verification recorded below.
No commit, push, deployment, live data or host-package changes.
Continues the completed Lore credential boundary objective.

## Diagnosis and objective

REST history, wiki, forum, gallery, incident and album reads currently accept
anonymous requests; their writes generally authenticate without checking the
resource's channel. The REST self-join route also admits outsiders into DMs.
Socket access distinguishes only two-party DMs, not GroupDm, and its DM fallback
can infer membership from an ID after the persisted membership is gone. Socket
init sends every channel, and group creation broadcasts private metadata.

Establish one channel-content policy using current persisted membership, shared
by REST and socket checks. Ordinary channels remain discoverable to authenticated
users and self-joinable. DM and GroupDm require explicit membership regardless
of ID spelling or admin/owner status. Albums derive authority from their stored
scope, never a caller-selected parent. Authentication/authorization must happen
before reads, writes, cache insertion or room joins.

The frontend currently emits join-channel without completing the REST membership
join. Restore that workflow and order content loads after its acknowledgment;
do not convert permission failures into empty/success states or cache permission
indefinitely. Preserve browser/Tauri auth refresh and server selection.

## Verification approach

First reproduce unauthorized reads, writes, DM self-join, discovery and album
parent bypass through the production Axum router with real temporary WabiDB.
Then test positive member/admin ordinary-channel access, no admin DM override,
removed membership, deleted/missing channels, nested IDs and socket policy.
Test frontend join/content ordering, concurrent joins, failures and stale
navigation/session handling. Run relevant and broader backend/frontend suites,
type checking and both frontend build modes. Inspect the final diff and update
security/API guidance. No new postcard fields or event formats are planned.

This objective establishes the channel boundary, not a claim that every server
endpoint or per-author moderation rule has been audited. Public upload capability
URLs, media transport ownership and optional Lore's stricter capability rules
remain separate. Instance-secret exposure/rotation and deployment stay gated.

## Implemented behavior and coupling found

`channel_access.rs` centralizes content access and authenticated discovery.
Membership uses the existing projection's exact indexed lookup, including decode
error propagation, instead of repeated whole-table scans. The channel kind is
read from the live channel projection before applying policy; missing/deleted
channels cannot inherit admin access. No new records, events, codec fields or
projection registrations were added in this objective.

Wiki/forum/gallery/incidents install one route layer protecting all methods.
History and reactions use the same guard explicitly. Album handlers resolve the
stored scope before accessing items or changing anything; spoofing scopeType
cannot weaken the actual channel's policy. Deleted albums are 404, list-items
returns the album expected by its client, and add-item reads back the acknowledged
projection instead of fabricating metadata that wasn't persisted. Album deletion
also requires its owner or a moderator/admin who already has channel access.

Nested-ID testing found compatibility upserts: updating a missing wiki page,
forum post or gallery work could create a duplicate of an ID from another channel.
REST now requires an existing live record before those updates. New forum replies
and gallery feedback also require their actual parent in the authorized channel.

Socket init filters private conversations and rebuilds their member arrays from
WabiDB. Private creation/deletion events target participant user rooms, not global
broadcasts. Sync-newer, edit/delete/pin/reactions/typing use the guarded identity
and channel policy; nested message mutations verify the actual message parent
even for admins/authors. Existing message IDs and media transport code are unchanged.

The browser/Tauri frontend completes REST membership join before socket-room
join and scoped workspace loads. Concurrent joins share an in-flight promise;
there is no permanent permission cache. Account/server changes and a replaced
socket generation invalidate delayed joins; same-account token refresh remains
compatible. Pre-connect DM intent still uses Socket.IO's normal buffer rather
than disappearing while the first handshake is in flight. Existing DM open paths
still use channelStore's shared join function.
The privacy/frontend skills informed this shared-boundary and navigation design;
API/frontend guidance was updated, including the obsolete projection-polling advice.

## Explicitly unfinished operations and launch limits

The old group add/kick/leave handlers broadcast success without any membership
write. Avatar upsert could overwrite the group name without persisting the avatar.
They now report `NOT_IMPLEMENTED` with no state mutation or success event, surfaced
through the existing frontend error UI. Album reorder/featured stubs similarly
return 501. These features are **not completed** by this objective.

Group membership changes need a separate coherent lifecycle: authorize an actor,
commit membership, evict every affected account socket/media room/roster, and
reconcile client state. Direct/out-of-band membership removal denies subsequent
guarded requests but does not evict existing sockets from all broadcast rooms.
Do not restore leave/kick success until that receive-side boundary is finished.

The next highest-priority investigation is **call/voice admission and membership
revocation**, not cosmetic UI: voice-channel join/listen admission currently
builds rosters separately from these content guards, while relay admission trusts
those rosters. Trace P2P, group calls, relay, listen-only, multi-device and desktop
paths before changing them; preserve the recent transport recovery fixes.

Also still open: independent admin JWT/session helpers, expired long-lived socket
behavior, per-author moderation parity, unrelated server-wide metadata handlers,
offline queue acknowledgments, and the previously recorded instance-secret
exposure/rotation work. This is not a whole-product launch security sign-off.

## Verification evidence

- Before: all four initial REST contracts failed against the previous code
  (`/tmp/wabi-channel-access-before.log`): anonymous content reads, outsider
  writes, private self-join/discovery, and album authorization.
- Expanded tests additionally reproduced the nested update-as-create behavior
  before adding record-existence checks. No real user data was used.
- Authorization suite: real Axum + temporary WabiDB, plus real Engine.IO polling
  through Axum for socket handshake/init/rooms/events. Covers outsider and owner
  denial in Dm/GroupDm (including non-DM-looking IDs), legitimate public join/send,
  forbidden durable and live-cache writes, removed/missing membership, nested
  resource spoofing, participant-only private fanout and truthful unsupported
  operations. Final suite has nine tests.
- Full server suite with addons, including audio/security units, all thirteen
  Lore credential contracts and write-visibility contracts. Final run:
  `/tmp/wabi-channel-access-server-final.log`.
- Frontend: 279 passed, 12 existing crypto-related skips; typecheck: zero errors,
  181 existing warnings in 49 files. Logs: `/tmp/wabi-channel-access-frontend-tests.log`
  and `/tmp/wabi-channel-access-frontend-check.log`.
- Six new frontend coordination tests prove ordering/coalescing, truthful denial,
  malformed success rejection, stale session/server cancellation, refreshed bearer
  use and wrong-server URL rejection.
- Headful Chromium: `node scripts/channel-access-browser-smoke.mjs` passed with
  actual wiki/forum/album stores/API helpers and Tauri CSP. Session, user-directory
  and HTTP responses are fixtures. The actual channelStore is also exercised
  with a socket fixture: same-generation emission, replacement rejection and
  initial pre-connect buffering. This is wiring verification, not a live-server
  or whole-shell visual acceptance test (`/tmp/wabi-channel-access-browser.log`).
- Both Tauri frontend and static web builds passed. The final frontend/build is
  the static web bundle. **No new native Linux binary/package was built.**
- Server without addons checks; API/frontend skill validators and diff whitespace
  checks pass. The frontend skill's legacy author/version metadata was preserved
  under metadata to satisfy its validator.

The completed Lore/WabiDB changes and the four unrelated frontend-lane planning
documents were preserved. No deployed server, WabiDB lock files or instance
secrets were touched. Temporary test/browser servers shut down after verification.
