# Chat retention: default ephemeral, opt-in persist

Product rule (Ronin / PRIVACY_STANCE): **default timed chat; keep-forever is opt-in.** Ops docker/`tracing` logs are a separate dial.

## Was inverted (pre-2026-07-17)

| Step | Wrong default |
|------|----------------|
| Send message | Always durable `wdb.send_message` |
| Auto-delete | Only if channel had a timer |
| UI | “Never” selected by default |

## Correct default (implemented)

| Concept | Value |
|---------|--------|
| Default channel TTL | **24h** (`DEFAULT_CHANNEL_RETENTION` / `DEFAULT_CHANNEL_AUTO_DELETE_MS`) |
| Keep forever | Explicit opt-in: `autoDeleteAfter: null` + label `forever` + WDB retention `days=0` |
| Unset channel (no policy, no map) | Backend applies **24h** on send |
| New channel create / first-user general | Seed 24h map + retention days=1 |
| UI | “Keep forever” (confirm); presets including 24h; purge button |

## Key files

- `shared/messageRetention.ts` (+ `.js`): `DEFAULT_CHANNEL_RETENTION`, `effectiveChannelRetention`, labels
- `core/crates/wabi-server/src/socketio/messages.rs`: resolve delete_after_ms
- `wiring_handlers.rs`: null → forever label
- `api/channels.rs` + `api/auth.rs` first-user seed: 24h on create
- `ChannelSettingsModal.svelte`: chooseRetention confirms + purge offer
- `MessageList.svelte`: client countdown uses default 24h when unset

## Semantics

- **null** autoDeleteAfter = keep forever (opt-in)
- **undefined** / missing = effective **24h** (not forever)
- Do not use `autoDeleteAfter || null` in UI — collapses unset into forever

## Third class: Live (session-only, no disk) — added 2026-07-17

Ronin wants a **Live** room class beyond timed/forever: messages are **never persisted** to WabiDB, fanned out via `session_messages` only, gone on restart. Pitch: stage/lobby/watch-party rooms; saves server hardware (no message segment/index growth). **Live is NOT E2EE** — still operator-readable while live; never market as private. Default stays timed 24h (Ronin: people use Discord as pseudo-email, so 24h beats pure-live default).

### Replay-SAFE implementation (critical)
Do NOT add a field to the `Channel` domain struct — a trailing postcard field risks the UserRecord-style replay break (users vanish, owner pointer stays). Instead reuse the existing **in-memory `channel_auto_delete_label` map** with sentinel `"live"` (alongside `"forever"`).

| Piece | What |
|-------|------|
| Send gate | `channel_is_live(app, channel_id)` reads label map == "live"; skips `wdb.send_message` + skips TTL `tokio::spawn`; still pushes `session_messages` + emits "message" |
| Both send paths | `socketio/messages.rs::on_message` (registered `wiring.rs` `socket.on("message")` — the `#[allow(dead_code)]` is only a lint suppress, it IS live) AND REST `api/messages.rs::send_message` |
| Settings | `wiring_handlers.rs` `update-channel-settings`: `autoDeleteAfter == "live"` branch clears ms map, sets label "live", drops durable retention (upsert days=0) |
| Wire field | reuses `autoDeleteAfter`: send `"live"` / preset / `null` |
| Contract test | `tests/live_session_room_contract.rs`: scan temp data_dir recursively, assert canary bytes ABSENT for live, PRESENT for control (proves "never written", not just "not listed") |

### Frontend (shared/ import + type)
- `MessageRetentionDuration` is a **generated protocol type** (`packages/wabi-protocol/.../generated`). Do NOT edit it to add 'live'. Add a plain `LIVE_RETENTION = 'live'` const + `isLiveRetention()` helper to `shared/messageRetention.ts` AND the `.js` twin.
- In components use a local `type RetentionChoice = MessageRetentionDuration | null | 'live'` and cast at the dispatch boundary; guard row badges with `isLiveRetention(channel.autoDeleteAfter)` (direct `=== 'live'` fails typecheck: no overlap).
- `effectiveAutoDelete`: live stays live; undefined→24h; null→forever.
- LIVE pill on `TextChannelList.svelte`; `.live-tag` style beside `.nsfw-tag` in `sidebar-core-part1.css`.
- History load-more is already gated on `persistMessages === true`, so Live channels don't fetch durable history — no extra guard needed.

### Deferred (in plan, not built)
Block/ephemeral attachments in Live rooms; create-form Live dropdown option. Plan: `docs/plans/2026-07-17-live-session-rooms-no-disk.md`.

### OpenCode dispatch pitfall (this session)
The frontend worker referenced `shared/` as `frontend/../../shared/messageRetention.ts` — OpenCode resolved that OUTSIDE the workdir and auto-rejected (`external_directory`), so it stalled with ZERO edits. `shared/` is at `wabi/shared/` (workdir root). Either dispatch from repo root and give shared's real path, or (as done here) just do the small bounded UI directly — faster than re-dispatching. Verify workers made real changes with `git status --short` before trusting the self-report.

## Honesty for product claims

- Ephemeral here means **TTL + scheduled delete**, not pure RAM-only (messages still write WabiDB then reaper/timer).
- Turning chat ephemeral ≠ quiet `RUST_LOG` / no TraceLayer.
- Sub-day timers still mostly live in in-memory map; multi-day survive restart via retention days (pre-existing limitation).

## UI copy

- Prefer “Keep forever (opt-in)” over “Never”
- Purge = clear-channel-messages (owner/admin); confirm destructive
- Leaving forever → timed: offer purge existing history
