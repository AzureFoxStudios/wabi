# WabiDB Storage Architecture Correction (2026-06-19)

> Source: User correction to the "fully custom" answer. Verdict: pull is correct, but the previous answer overclaimed in three specific ways.

## The pull is correct

Wabi should own the storage format. The privacy, retention, and replay stories need custom storage. SQLite is gone.

## The three corrections

### Correction 1: "No WabiStore trait" was wrong

Even with one substrate, a clean storage API boundary is the architectural seam. Commands shouldn't know about segment files, offsets, fsync, manifests, index compaction. The seam matters:

```rust
ctx.storage.append_commit(commit)?;
ctx.storage.get_channel_messages(channel_id, before, limit)?;
ctx.storage.get_whiteboard_snapshot(board_id)?;
ctx.storage.get_events_after(topic, seq, limit)?;
```

The interface doesn't have to be a Rust trait. It can be a concrete struct with domain methods. But the boundary is essential.

### Correction 2: "Event log collapses with WAL" was wrong without per-stream boundaries

A single global log holding mixed event types breaks the privacy/deletion story. When Alice-Bob DM retention expires, you can't drop the segment because it also contains retained channel messages.

The correct design: per-stream payload logs + global commit index.

```
global/commit-index/0001.widx          ← global ordering for subscriptions
streams/channel/ch_01J.../events/...   ← per-stream payload segments
streams/dm/dm_01J.../events/...        ← per-stream, with its own key
streams/whiteboard/wb_01J.../patches/...
streams/whiteboard/wb_01J.../snapshots/...
blobs/ab/abcd....bin
manifests/storage-manifest.json
```

### Correction 3: "Parallel writers" and "per-stream deletion is clean" were overclaimed

- Parallel per-stream writers are not automatic. Global commit_seq needs a global sequencer.
- Per-stream deletion is only clean if the file layout is per-stream. With a global mixed log, deletion requires scanning and splitting.

## The corrected architecture (11 components)

```
WabiDB
├── command executor          (validates ACL/idempotency, creates commit object)
├── commit sequencer          (assigns global commit_seq)
├── stream log manager        (per-stream segments, fsync, rotation, checksums, stream keys)
├── global commit index       (commit_seq → stream refs)
├── projection engine         (applies events to materialized state, fixed indexes, rebuildable)
├── snapshot manager          (object snapshots, trims replay window)
├── retention/compaction      (compacts streams, drops expired segments, destroys keys)
├── subscription engine       (live fanout, replay from commit index, snapshot barriers)
├── ephemeral bus             (memory-only events)
├── blob store                (content-addressed immutable files)
└── storage CLI               (check, inspect, recover, backup, rebuild-indexes)
```

## Load-bearing invariants

### Storage invariants

- Every committed mutation has exactly one entry in the global commit index, mapping to exactly one stream segment record
- Stream segment records are append-only; never modified after fsync
- A stream segment is valid iff its header magic, version, and CRC32C checksums match
- Recovery scans segments, truncates at first invalid record, replays from last valid snapshot
- Only records reachable from a valid global commit index entry are committed
- Orphaned stream records (no commit index entry) are ignored
- Commit index entries pointing to missing/corrupt stream records are repairable from backup

### Retention invariants

- Retention policy is enforced per-stream, never per-global-segment
- A stream's segments are encrypted with that stream's key
- Dropping a stream destroys its key, not just its bytes
- The commit index retains tombstones for dropped streams for audit purposes

### Subscription invariants

- Every durable event appears in the global commit index exactly once
- Replay uses the commit index, not the stream segments directly
- Snapshot barrier is the commit_seq at the moment the subscription was registered
- Live fanout delivers events with commit_seq > barrier

### Projection invariants

- Projections are derived, never canonical
- Projections can be rebuilt from snapshots + post-snapshot commit index
- Projection corruption does not corrupt the log

## Honest v1 scope revision

Previous estimate: 2,000-3,000 LOC, 1-2 weeks. With per-stream + global index: **3,500-5,500 LOC, 4-6 weeks of focused Rust work.** That's real work, not 1 weekend.

The first vertical slice is still small in feature scope (storage layer + event log + commit sequencer + one command + one subscription + 10 crash/resume tests), but the storage layer itself is the bulk of the work.

## What still holds

- Wabi owns the storage format (not SQLite)
- The event log is central; projections are derived
- Ephemeral events structurally cannot hit disk
- Encryption, ACL, idempotency, snapshot barriers, retention — all in v1, no version splits
- First vertical slice: small in feature scope, big in storage layer scope

## What changes in the end-state doc

- Section 5 (subscriptions): now per-stream log with global index, not single log
- Section 6 (encryption): per-stream keys, key destruction on retention
- Section 11 (storage): entire section rewritten — per-stream segment log + global commit index + projection engine + snapshot manager + retention/compaction
- New section: storage CLI design (sqlite3 equivalents: check, inspect, recover, backup, rebuild-indexes)
- New section: "per-stream vs global log" design fork and why Option B
- Backup section: manifest-based, unified restore point
- Migration section: data export from STDB no longer has SQL as stable intermediate

Estimated revision: ~5,000-7,000 words of new content plus edits throughout.

## Final answer (from correction)

> Yes, the correction is pointing in a real direction.
>
> But I would not say "SQLite is outdated, therefore build a database from scratch."
>
> I would say: "Wabi's real database is an event/object/retention engine. SQLite can host that, but it will never be native to it. If Wabi wants the cleanest long-term architecture, own the Wabi storage format."
>
> The north star: per-stream log-structured storage, global commit index, rebuildable projections, retention-aware compaction, and memory-only ephemeral events.
>
> That is not SQLite. That is not STDB. That is WabiDB.
