# Calling Backend Worker Report: TeamSpeak Multi-Listen Fix

## Summary
Fixed the backend socket.io voice subscribe/unsubscribe wiring so a client can
join (transmit in) one voice channel while listening to multiple others
(TeamSpeak-style multi-listen). Previously `voice-channel-subscribe` was
erroneously routed to the join/transmit handler, and `voice-channel-unsubscribe`
was not registered at all.

## Files changed

### `core/crates/wabi-server/src/socketio/shared.rs`
- Added `is_listening_only: bool` field to `VoiceParticipant`.
- `voice_participant_to_view` now emits `"isListeningOnly"` so frontends can
  distinguish listening vs transmitting members.
- Updated the sweep test's `VoiceParticipant` constructor for the new field.

### `core/crates/wabi-server/src/socketio/voice_channels.rs`
- `on_voice_channel_join`: now sets `is_listening_only: false` (explicit
  primary/transmit mode). It already `retain`s and re-pushes, so any prior
  listen-only entry for the same socket is replaced by the primary entry.
- New `on_voice_channel_subscribe`:
  - Requires `channelId`.
  - Resolves identity the same way join does (token → stable_id, username, color).
  - Adds the socket as a listen-only participant (`transmit_mode: "listening"`,
    `is_listening_only: true`).
  - If the socket is already a **primary** participant in that channel, it is
    NOT demoted.
  - Broadcasts `voice-channel-state` (full member list) to all clients so the
    roster reflects the new listener everywhere, without firing
    `voice-channel-joined`/`voice-channel-user-joined` as if they were a
    transmitter.
- New `on_voice_channel_unsubscribe`:
  - Removes this socket from the channel **only if** it is a listen-only
    participant. A primary (transmitting) joiner is never kicked by an
    unsubscribe.
  - On removal, broadcasts the updated `voice-channel-state` to all clients.
- `on_voice_channel_leave`: unchanged in behavior (removes the socket entirely,
  primary or listen-only); the only edit was the new field on the join path.

### `core/crates/wabi-server/src/socketio/wiring.rs`
- `voice-channel-subscribe` now routes to `on_voice_channel_subscribe`
  (was incorrectly mapped to `on_voice_channel_join`).
- Registered `voice-channel-unsubscribe` → `on_voice_channel_unsubscribe`.

## Behavior
- Subscribe = listen-only, multi-channel capable.
- Join = primary/transmit, single active transmit channel (UI-enforced
  frontend-side).
- Unsubscribe only drops listen-only members; it never removes a transmitting
  joiner.
- Rosters stay consistent via `voice-channel-state` broadcasts.

## Commands run
```
cargo check -p wabi-server
cargo test -p wabi-server
```

## Results
- `cargo check -p wabi-server`: success (only pre-existing dead-code warnings
  unrelated to this change).
- `cargo test -p wabi-server`: 48 passed, 0 failed.

## Notes / out of scope
- No frontend edits, no docker/compose, no commits, no rewrite of the socketio
  stack (per constraints).
- `transmit_mode` value `"listening"` is only used to tag listen-only
  participants; the `set-voice-transmit-mode` state machine ("primary" /
  "all-listening") is unaffected because listening participants are never
  primary.
