# Friends and direct message rebuild (2026-09-25)

The `codex/friends-dm-release-20260925` branch was deployed on Tim on
2026-09-25, but has not been merged into `main`. Friends are scoped to one
Authority. They do not create global identities, federation or cross-server
messages. Direct messages and group rooms are server-readable. The experimental
encryption path is not a shipped confidentiality guarantee.

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
members of the same Authority, rather than a friends-only list. Group content
is server-readable, and custom group avatars are not yet supported.

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
