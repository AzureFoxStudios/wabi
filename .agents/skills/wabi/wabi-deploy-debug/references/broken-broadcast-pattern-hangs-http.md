# Broken `tokio::sync::broadcast` Pattern Hangs HTTP Handlers

## Symptom

HTTP API endpoints hang indefinitely — the client never receives a response, the handler never completes. No error is logged. The endpoint appears to "work" from the outside (the server doesn't crash) but the HTTP request just spins until it times out. Affected endpoints: emote upload (`POST /api/emoji/upload`), channel deletion, bot message send, avatar upload, steam join events.

## Root Cause

A `broadcast::channel(1)` was used as a one-shot mechanism to distribute the `SocketIo` handle from the wiring layer to API handlers:

```rust
// state.rs
let (sio_broadcast_tx, _) = broadcast::channel(1);  // capacity 1, receiver dropped immediately

// wiring.rs — runs at startup
let _ = app_for_broadcast.sio_broadcast_tx.send(io.clone());  // ← send with ZERO receivers

// api/emoji.rs — runs per HTTP request
let mut sio_rx = state.sio_broadcast_tx.subscribe();          // ← subscribes AFTER the send
if let Ok(io) = sio_rx.recv().await {                          // ← blocks FOREVER
    let _ = io.broadcast().emit(...).await;
}
```

Why it breaks:

1. `send(io)` at startup has **zero active receivers** (the `_` receiver was dropped at channel creation). `tokio::sync::broadcast::send()` returns `Err` when there are no receivers — the value is silently dropped (`let _ =` ignores the error).
2. API handlers `subscribe()` after the send. In `tokio::sync::broadcast`, a receiver only sees values sent **after** it subscribes — it never sees the pre-subscription value.
3. `recv().await` blocks forever waiting for a value that is never sent.
4. The HTTP handler never completes. The client sees a hanging request (no response, no error).

## The Correct Pattern

The `AppState` already stores the handle directly:

```rust
pub sio: RwLock<Option<socketioxide::SocketIo>>,  // set in wiring.rs:21-23
```

Use it directly:

```rust
if let Some(io) = state.sio.read().await.clone() {
    let _ = io.broadcast().emit("emojis-list", &json!(emotes)).await;
}
```

This is the exact pattern already used in `main.rs:733` (live-reaper task) — it just wasn't applied consistently.

## Detection

- Any HTTP endpoint that "works" (server logs show it was hit) but the client never gets a response.
- The issue affects broadcasts only — the underlying business logic (DB writes, etc.) may succeed or hang depending on whether the broadcast is the last step.
- Check with `curl -v` — you'll see the request hang after headers are sent (if streaming) or hang entirely.
- No error log because `recv().await` doesn't fail — it just waits.

## Fix (applied 2026-08-16)

Replaced the broken pattern in all 5 affected API handlers + 2 spawn tasks:

| File | Line | Pattern |
|---|---|---|
| `api/emoji.rs` | ~141 | `sio_broadcast_tx.subscribe()` → `state.sio.read().await.clone()` |
| `api/channels.rs` | ~435 | same |
| `api/messages.rs` | ~55 | same |
| `api/bots.rs` | ~198 | same |
| `api/upload.rs` | ~516 | same |
| `main.rs` (live-reaper) | ~624 | same |
| `main.rs` (subscription bridge) | ~822 | same (with retry loop) |

Also cleaned up the now-dead `sio_broadcast_tx` field from `AppState` (state.rs), its initialization, and the no-op `send()` in `wiring.rs`.

## Lesson

`broadcast::channel(N)` is for streaming many values to many concurrent subscribers — NOT for one-shot "give me the handle" patterns. For a handle that's set once at startup and read many times, use `RwLock<Option<T>>` directly. If you MUST use broadcast for a one-shot, the receiver must subscribe BEFORE the sender sends (e.g., subscribe in `main.rs` before spawning the wiring task, then pass the receiver to handlers via closures).