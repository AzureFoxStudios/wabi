# Friends and direct message rebuild candidate (2026-09-25)

This is a branch candidate, not a deployed product claim. Friends are scoped to
one Authority. They do not create global identities, federation or cross-server
messages. Direct messages remain server-readable unless a room's experimental
encryption path is deliberately enabled.

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
Retained DMs also support `beforeMessageId` and `afterMessageId` in
`load-history`. The channel-scoped durable time index returns at most 100 rows
per page in chronological order, with `hasMore` in the requested direction.
An unknown or cross-channel cursor returns `history-error`. Existing non-DM
history behavior is unchanged.

## Verification and remaining acceptance

The `friends_contract` integration test exercises request/accept/remove,
authorization and a WabiDB reopen. `message_delivery_contract` exercises two
real Socket.IO clients: DM creation, repeat open, a send to an unopened
recipient, and latest durable history after an out-of-band write. A real phone
PWA and Tim deployment still need device testing before claiming that mobile
delivery and the entire conversation experience are reliable.
The pagination regression walks 125 durable DM messages through latest,
before and after pages across a second connection.
