# Event Log Replay & Projection Persistence Plan

## Problem

On restart, `ProjectionState` is created empty. All projection state accumulated
from previous events is lost. Event handlers (message_edited, reaction_added,
etc.) produce no durable side effects.

## Root Cause

The write path in `process_command()` only encrypts `event.plaintext` (the inner
payload bytes). The `event_type` and `stream_id` routing metadata exist only in
the transient `DispatchItem` — they are never written to the `.wseg` segment
files. During replay, after decryption we get raw payload bytes with no way to
route them to the correct handler.

## Implementation Phases

### Phase 1: Payload Envelope (write-path change)

Add a `ReplayEnvelope` struct that wraps the payload before encryption, so the
on-disk record self-describes its `event_type` and `stream_id`.

**Files changed:**
- `core/crates/wabidb/src/sequencer/types.rs` — add `ReplayEnvelope` struct + serde
- `core/crates/wabidb/src/sequencer/mod.rs` — wrap `event.plaintext` in envelope before encrypt
- `core/crates/wabidb/src/sequencer/mod.rs` — update `payload_len` calculation for envelope size

**Write-path diff (mod.rs:230-246):**
```rust
// BEFORE
let payload_len = event.plaintext.len().checked_add(TAG_LEN)...;
let ciphertext = encrypt_record(&key, seq, &header, &event.plaintext)?;

// AFTER
let envelope = serde_json::to_vec(&ReplayEnvelope {
    event_type: &event.event_type,
    stream_id: &event.stream_id,
    payload: &event.plaintext,
})?;
let payload_len = envelope.len().checked_add(TAG_LEN)...;
let ciphertext = encrypt_record(&key, seq, &header, &envelope)?;
```

**No format version bump needed** — the payload bytes are opaque to the
segment reader. Old records (without envelope) are simply ignored during replay.

### Phase 2: Replay Projections (read-path)

New `replay_projections()` function that walks all stream segments, decrypts
each record, unwraps the envelope, and dispatches to the corresponding handler.

**New file:** `core/crates/wabidb/src/engine/replay.rs` (or inline in
`engine/mod.rs`)

**Flow:**
1. Walk `data_dir/streams/{kind_dir}/{stream_id}/events/*.wseg`
2. For each stream, call `get_or_create_stream_key(stream_id)` to ensure key exists
3. Open `SegmentReader::open(path)` → `read_records()`
4. For each `ValidRecord`:
   a. Re-encode header bytes: `record.header.encode()`
   b. Decrypt: `decrypt_record(&key, commit_seq, &header_bytes, &record.payload)`
   c. Try deserialize as `ReplayEnvelope` — skip if fails (old-format record)
   d. Build `DurableEvent` and dispatch: `table.get(&envelope.event_type)?.apply(...)`
5. Advance barrier watermark to `highest_commit_seq`

**Wired in `open()` between step 7 (ProjectionState::new) and step 8 (batcher).**

### Phase 3: 7 Projection-less Handler Stubs

Minimal handlers for event types that currently have no projection. These
currently fall through to the generic "events" index in `run_dispatcher()`.
Adding explicit handlers makes them visible in the dispatch table and
documents the intent that they are projection-less (no-op apply).

**Event types:**
- `message_edited`
- `message_deleted`
- `reaction_added`
- `reaction_removed`
- `member_joined`
- `member_left`
- `channel_renamed`

**File:** `core/crates/wabidb/src/projections/noop.rs` — single file,
one unit struct per event type, `apply` is a log-only no-op.

### Phase 4: Persistence Policy (future)

Three-phase approach documented for later implementation:

1. **Phase 4a: Load-on-read** — read existing projection state from disk on
   startup before replay begins (for handlers that need pre-existing data).
2. **Phase 4b: Persist-on-shutdown** — serialize `ProjectionState` to a
   snapshot file during graceful shutdown.
3. **Phase 4c: Incremental checkpoint** — write checkpoint every N writes
   for faster restart.

## Dependencies

- `crypto/aes_gcm_record::decrypt_record` — EXISTS
- `crypto/stream_key_registry::StreamKeyRegistry::get_active_key` — EXISTS
- `stream_log/segment_reader::SegmentReader` — EXISTS
- `projections/handler::DispatchTable` — EXISTS
- `projections/handler::DurableEvent` — EXISTS
- `serde_json` — available (used throughout the codebase)
- `get_or_create_stream_key` — EXISTS (engine/mod.rs:296)

## Risks

1. **Nonce collision is impossible** — commit_seq is globally monotonic,
   unique per (key, stream) pair. AES-GCM nonce = commit_seq as 12 bytes.
2. **Old records gracefully skipped** — deserialization failure of
   `ReplayEnvelope` simply skips the record (it was written before this
   change and lacks the envelope).
3. **Performance** — full replay reads all segments sequentially. Linear
   in number of records. Acceptable for v1; incremental snapshot will
   optimize later.
