# Wabi TUI live transport + wire contract (2026-08-23)

Verified against `core/crates/wabi-server/src/socketio/wiring.rs` and
`frontend/src/lib/socketConnectionCore.ts`. Do not re-derive; trust this.

## The real live transport is Socket.IO, NOT the raw /ws endpoint

Two transports exist in wabi-server:
- `socketio/` (socketioxide 0.16) at `/socket.io/` — THE live chat transport.
  Frontend uses socket.io-client. Messages, typing, presence, reactions,
  pins, edits, voice signaling all flow here.
- `websocket.rs` (`/ws`) — mostly call-session signaling only. A TUI that
  connects to `/ws` will NOT receive chat messages. (Earlier skill note said
  "still poll-based, no WebSocket" — superseded: Slice B wired Socket.IO.)

## Wire contract

- Endpoint: `ws(s)://<host>/socket.io/`, namespace `/`, Engine.IO v4.
- Handshake auth: connect with auth payload `{"token": "<jwt>"}`. Invalid →
  server emits `auth-failed` and disconnects.
- After connect: emit `"join"` with the username as a BARE STRING payload,
  then `"join-channel"` with the channel id as a BARE STRING (not an object).
- Inbound `"message"` event: `{"channelId": str, "message": {...view}}`.
  message_view fields: `id, user, userId ("user-123"), senderStableId, color,
  text, timestamp (ms), bornAt, type, clientMessageId, isSpoiler, replyTo,
  files, ...`
- Inbound `"typing"` event: `{"channelId": str, "usernames": [..]}` (array!).
  Emitting typing uses object payload `{"channelId": id}`.
- Other useful events already wired server-side: `message-edited`,
  `message-deleted`, `message-pinned`, `add-emoji-reaction` /
  `remove-emoji-reaction`, `presence`, reactions errors via `reaction-error`.
- REST history fallback unchanged: `GET /api/messages/{channel_id}?limit=N`.

## rust_socketio 0.6 API gotchas (verified against crate source)

- Crate name in Cargo.toml must be `rust_socketio` (underscore) — crates.io
  rejects the hyphenated alias at resolve time.
- Import `Client` from `rust_socketio::client::Client`; builder callbacks
  receive `(Payload, RawClient)` — emits inside callbacks go through
  `RawClient::emit(event, data.into_payload)`.
- `Payload::Text(Vec<serde_json::Value>)` is the JSON variant (no
  `Payload::Json`); take `.first().cloned()` for single-object events.
- Every `.on(...)` closure needs its OWN clones of shared `Arc`s (tx, health)
  — closures are `FnMut` moved into storage; a single outer clone won't compile.
- Callbacks run on the client's own threads: use
  `tokio::sync::mpsc::Sender::blocking_send` to forward into the app's bg
  queue; never mutate app state from callback context.
- `blocking_send` panics inside a tokio runtime worker; fine here because
  socket.io client threads are plain OS threads.

## App integration pattern (wabi-tui)

- New `BgMsg` variants: `LiveConnected`, `LiveDisconnected(String)`,
  `LiveMessage { channel_id, message }`, `LiveTyping { channel_id, username }`.
- Connect trigger points: after `LoginOk`, and after first `Channels` load when
  token exists + not connected (needs an active_channel for join-channel).
- Poll demotion guard: skip REST poll while `live.is_connected()` AND last
  event <30s ago; reconnect falls back automatically since health flips false.
- Dedupe inbound messages by id against existing buffer before append
  (server may echo your own sends).
- Unread counter per channel cleared on selection (`nav_channels`).

## Tier 1 status (2026-08-23)

Shipped: Slice A `c880c61` (channel-type badges + DM section), Slice B
`3e5fae2` (live feed), plan doc `a554e7f`
(`docs/plans/2026-08-23-tui-tier1.md`). Release build clean.
NOT yet runtime-smoked (TUI vs second client, live latency, typing display).

## Deferred backlog (Tier 2+)

Reactions UI, presence column, calls/live-rooms screen, wiki/forum/albums
viewers, screen registry refactor (Screen enum → pluggable registry),
theme alignment with wabi palettes (indigo is now off-brand vs 14 themes).
