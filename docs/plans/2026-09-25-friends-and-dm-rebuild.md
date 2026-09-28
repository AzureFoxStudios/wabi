# Friends and direct message rebuild (2026-09-25)

The `codex/friends-dm-release-20260925` branch was deployed on Tim on
2026-09-25, but has not been merged into `main`. Friends are scoped to one
Authority. They do not create global identities, federation or cross-server
messages. The first 2026-09-25 release kept DMs and groups server-readable.
The later new-room encryption default is experimental, with explicit
server-readable fallback and no verified operator-blind guarantee.

## Durable friend relationship

`friend_relationship_changed_v1` is an additive WabiDB JSON event on stream
`friends:<lower user ID>:<higher user ID>`, handled by the new
`friend_relationships` projection. Its version 1 record contains `schema`,
`low_user_id`, `high_user_id`, `requested_by`, `state` and
`created_at_micros`. `state` is `pending`, `friends` or `removed`; removal
deletes the projection row while its event remains available for replay. The
16-byte index key is the two user IDs in big-endian order. Existing postcard
user, channel, membership and message records are unchanged, so there is no
postcard migration. Older binaries cannot replay the new event and must not be
used as a data-preserving rollback after a friend write.

The API is authenticated and limited to active registered personal accounts:
`GET /api/friends`, `POST /api/friends/requests` with `user_id`,
`POST /api/friends/requests/{id}/accept`, `DELETE /api/friends/requests/{id}`
and `DELETE /api/friends/{user_id}`. Only the recipient can accept a pending
request; either party can cancel or decline one and either friend can remove
the accepted relationship. Writes serialize their read/decide/commit step with
the server membership gate. Each successful change emits `friends-updated` to
the two account rooms so clients refresh their own authenticated list. A
friendship is a social preference, not DM authorization; DM reads and sends
still require current channel membership.

## Direct message delivery

The canonical pair DM uses one WabiDB command containing `channel_created` and
`channel_members_changed` on separate streams. It acknowledges only after both
projections apply, avoiding a half-created channel if writing the second member
fails. Opening an existing pair returns `dm-created` again to let reconnecting
clients recover it. Reopening a deleted pair creates the same canonical channel
with a fresh channel and membership event.

On `join`, a socket enters all current private conversation rooms from
membership-filtered discovery. A newly created DM joins the initiator before
`dm-created`. DM message fanout targets each current member's account room
exactly once, so all of their connected devices receive a send even if that
conversation has not been opened. Non-DM channel fanout keeps its normal channel
room behavior. A failed durable send still emits `message-error` and never
announces delivery. `load-history` uses the durable tail for retained rooms,
overlaying matching session rows for rich live metadata; `limit:1` therefore
returns the latest stored message even when the in-memory cache is stale. A
`live` retention room still uses only its session buffer by design. The
`join-channel` snapshot follows the same durable-tail rule for retained rooms
so reconnect cannot replace correct history with an incomplete cache.
Retained DMs and groups also support `beforeMessageId` and `afterMessageId` in
`load-history`. The channel-scoped durable time index returns at most 100 rows
per page in chronological order, with `hasMore` in the requested direction.
An unknown or cross-channel cursor returns `history-error`. Public channel
history behavior is unchanged.

The DM hub opens group creation in center stage. A newly created group opens
there immediately. Group settings in the center conversation expose the
existing add, remove and leave actions; older history can be requested in the
center conversation and right panel. Group invitees are active registered
members of the same Authority, rather than a friends-only list. Groups from
the first 2026-09-25 release were server-readable; the later new-room policy
is described below. Custom group avatars are not yet supported.

The People tab exposes a right-click menu and a visible More button for touch
and keyboard use. Both include View Profile and relevant friend actions. The
menu now rebuilds from current membership and friendship state, so opening it
after the tab loads does not leave it empty. Profile details use the shared
user popout; this is not a cross-server identity/profile system.

## Timed retention follow-up

The retention label previously applied the current timer to all messages in a
channel. A switch to 5 seconds could therefore hide or delete older history.
The follow-up stores per-channel policy epochs in the existing
`channel_retention.json` sidecar. Each new policy applies only to messages sent
after its effective timestamp; earlier messages keep their previous lifetime.
Existing sidecars with only a `channels` map are read as one policy starting
at time zero. This adds no postcard record change. The authenticated retention
endpoint gives clients the same timeline for per-message countdowns.

The server checks channels with short retention epochs every second, using a
bounded WabiDB time-index query for each timed epoch; a full sweep still runs
once per minute. Durable deletion is based on the original message timestamp,
including after restart. Changing a room to Live keeps earlier durable rows
under their prior policy, but Live mode's session-only history view can hide
those rows until the room returns to retained mode. Messages already deleted
by an older server cannot be recovered by this change. Older binaries ignore
the epoch timeline and are unsafe for rollback after policy changes; restore a
matching stopped WabiDB and sidecar backup if rollback is required.

## Verification and remaining acceptance

The `friends_contract` integration test exercises request/accept/remove,
authorization and a WabiDB reopen. `message_delivery_contract` exercises two
real Socket.IO clients: DM creation, repeat open, a send to an unopened
recipient, and latest durable history after an out-of-band write. The pagination
regression walks 125 durable DM messages through latest, before and after pages
across a second connection.

The exact deployed release binary passed a disposable two-account browser test
of friend actions, two-way DM delivery, read receipts, reconnect history,
previews, bot exclusion and responsive layout. The same test exercised an
embedded static PWA in a phone-sized browser: online send, offline queued reply,
reconnect delivery exactly once, and queue label clearing. The public Tim route
then returned the page without browser errors, health and Socket.IO passed, and
the precache manifest listed 201 embedded assets. A cold backup of Tim's
predeployment runtime data and previous binary was saved at
`/home/tim/Desktop/Wabi/.deploy-backups/2026-09-25-friends-dm-1660fea3`.
Physical phone PWA acceptance is still required before claiming reliable mobile
delivery on real devices. The older binary cannot safely be restored after new
friendship events have been written, because it cannot replay that new event.

The follow-up at `7cfed649a05cab56f1f8338dd6faaf3cf708622a` passed a
125-message group pagination regression and an Authority retention smoke test
that covered expiry before and after restart. A disposable two-account browser
test covered People actions, group history, direct messages, desktop and phone
viewport layouts, an embedded static PWA's online/offline replay, and a
five-second policy change that preserved earlier messages. Frontend checking
finished with zero errors; the static build embedded 201 offline assets with
build ID `faa44f67519637be`.

The addon-enabled release binary (SHA-256
`82feeb901118fb837c7c61e7cddb8efbe7c0e5497bd1733c80420250df325432`)
booted against disposable data on Iyoku, then deployed to Tim on 2026-09-25.
The stopped data, retention sidecar, uploads, configuration and prior binary
were saved at
`/home/tim/wabi-backups/authority-20260925-followup-7cfed649` before the
swap. The Tim service is healthy; the public page, health endpoint, embedded
precache and Socket.IO handshake passed. A physical-phone PWA check remains
open. Do not roll back only the binary after new friendship or retention epoch
writes; restore the matching stopped data and sidecar backup with it.

## 2026-09-26 new-room privacy and phone delivery follow-up

Code commit `88db86a787c518b7dd90a1feba5f0566d8672f53` makes newly created
DMs and groups encryption-pending by default. The Authority refuses plaintext
while pending. Updated participant clients register device keys and enable
experimental encrypted text once all members have a device; a user can instead
choose server-readable mode, but each sender must explicitly choose it before
their own plaintext send. Existing rooms retain their previous policy.
Encrypted message previews are generic rather than disclosing text. This is
still not an independently verified E2EE or operator-blind guarantee: first-seen
keys are supplied by the Authority, the Authority supplies browser code, and
attachment, device recovery and multi-device behavior need further acceptance.

The same commit fixes a Socket.IO initialization race, starts browser realtime
with HTTP polling so installed PWAs can deliver when WebSockets are blocked,
and reconciles optimistic sends with accepted message IDs. Friends navigation,
sent and incoming request state, toast notices, People actions, profiles and
DM/group visual hierarchy are included. The retention badge now shows a
message's actual policy: changing 30 seconds to 24 hours affects new messages
only, and a later 5-second policy expires only messages sent under that epoch.

The disposable two-account browser regression exercised two-way DMs, reactive
previews, friend actions, People/profile actions, encrypted DM and group text,
ciphertext-only stored history, phone-sized installed PWAs including a
polling-only client, offline queue and reconnect replay, and 30-second,
24-hour and 5-second retention changes. The Rust encryption tests passed 6/6,
the frontend unit tests passed 4/4, and frontend checking reported zero errors.
Iyoku booted the code candidate against disposable data. The exact final
addon-enabled release artifact (SHA-256
`32c068d237040668415e0ac62548a25b8c745b30513df2368b45d5decb7bd422`)
passed the Lore addon marker gate and a fresh disposable health/readiness and
embedded static build smoke check. Its frontend build ID is
`9c03d7127eb2619d` with 201 offline assets. Physical installed-phone
acceptance by Ronin and Tim remains open.

The release was deployed to Tim on 2026-09-26 after stopping the Wabi server
and refreshing a cold backup of WabiDB data, privacy/retention sidecars,
uploads, configuration and the previous binary at
`/home/tim/wabi-backups/authority-20260926-friends-dm-e2ee`. Tim's deployed
binary matches the SHA-256 above. Its database readiness and container health
passed; Lore remained compiled and enabled; the anonymous admin and Friends
endpoints returned 401; and the public page, health and Socket.IO polling
routes returned 200. The public precache manifest reported build ID
`9c03d7127eb2619d` and 201 assets. The backup must be restored together with
its matching previous binary if a rollback is required after new friendship,
retention or encryption-policy writes.
