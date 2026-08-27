---
name: wabi-privacy
description: "Audit Wabi data privacy, deletion semantics, and retention."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [wabi, privacy, retention, audit, gdpr, ephemeral, data-deletion]
    related_skills: [wabidb-troubleshooting, wabi-deploy]
---

# Wabi Privacy & Data Retention

Audit and harden Wabi's data privacy posture. Covers what the server stores, what gets logged, how deletion actually works, and the gap between WabiDB's designed retention system and what's actually wired up.

## When to use

- User asks "what data do you store" or "can you guarantee deletion"
- Privacy review, GDPR prep, or "under oath" claims about data handling
- Investigating whether deleted messages are truly gone from disk
- Hardening a production Wabi server for a privacy-sensitive community
- Auditing log files for message content leakage

## Data storage audit

### What lives on disk

| Location | Content | Size on Tim |
|----------|---------|-------------|
| `data/wabi-server/wabidb/` | All persistent state — messages, channels, DMs, users, presence, projections | ~200M |
| `data/wabi-server/wabidb/commit-log/` | Append-only event log (WabiDB source of truth) | Included above |
| `data/wabi-server/wabidb/snapshots/` | Periodic materialized snapshots of projections | Included above |
| `data/uploads/` | User-uploaded files (images, media) | Varies |
| `data/.plugin-storage/` | Plugin crash logs (usually empty) | negligible |
| `data/launch-page.json` | Custom login page branding | 1 file |
| `data/blacklist.txt` | Banned user IDs | 1 file |
| `data/revocations.json` | Revoked JWT user IDs | 1 file |
| Docker container logs | Server runtime logs (info/warn/error tracing) | auto-rotated |

### What's NOT stored

- Voice/video call audio — WebRTC is peer-to-peer or relayed in real-time, never written to disk
- Screen shares — real-time only
- Browsing history, keystrokes, outside-app activity — no telemetry, no analytics, no beacon
- Third-party data sharing — none

## Log content leakage (CRITICAL)

**`core/crates/wabi-server/src/socket.rs:67`** logs every incoming socket message at INFO level:

```rust
tracing::info!("Received socket message: {}", text);
```

This means chat messages, DMs, typing indicators, and presence events are written **verbatim to the server log file**. The log is a plaintext copy of everything users send.

**Fix (shipped):** Downgrade to DEBUG so message content doesn't appear in default info-level logs.

**Remaining concern:** `RUST_LOG=wabi_server=info` or higher still captures message content. Operators should set `RUST_LOG=wabi_server=warn` or rely on the default (which excludes DEBUG).

## Log rotation

Wabi now ships with daily log rotation and retention pruning:

- Logs go to `./logs/wabi-server.log` (configurable via `WABI_LOG_DIR`)
- Daily rotation via `tracing-subscriber` rolling file appender
- Background task prunes files older than `WABI_LOG_RETENTION_DAYS` (default: 7)
- Non-ANSI, compact format to minimize disk usage

## Deletion semantics — soft delete, not hard

**`core/crates/wabi-server/src/adapter/mod.rs:907` — `delete_message()`:**

```rust
m.is_deleted = true;
m.edited_at_micros = Some(now_micros());
// emits "message_deleted" event
```

This is a **soft delete**. The message content stays in the commit log forever, just marked `is_deleted = true`. The projection (materialized view) hides it from queries, but the event log still contains the original `message_created` event with full content.

### Retention reaper (`main.rs:694-736`)

- Runs every 60 seconds
- Per-channel retention policy (default: 1 day)
- Calls `delete_message()` — same soft delete
- Does NOT purge the commit log

### The honest "under oath" statement

> "Wabi is self-hosted. All data lives on my server, not a third party's. There's no telemetry, no analytics, no cloud exfiltration. Voice and video are real-time only — never recorded. Message deletion hides content from the UI; the server's internal event log retains a technical record until log rotation. I don't sell, share, or report that data to anyone."

Do NOT claim "I don't record shit" — the commit log stores every message. Do NOT claim "deleted messages are gone" — they're soft-deleted, content still in log.

## WabiDB retention: designed but NOT wired up

The `core/crates/wabidb/src/retention/` module is a **complete design** that exists on paper but is completely disconnected from the running server:

| Module | Purpose | Wired up? |
|--------|---------|-----------|
| `retention/reaper.rs` | Streams that hit retention deadline | ❌ No |
| `retention/compaction.rs` | Rewrite segment files, drop tombstones | ❌ No |
| `retention/key_destruction.rs` | Crypto-shredding (destroy keys = data unreadable) | ❌ No |
| `retention/tombstone.rs` | Tombstone table for dead streams | ❌ No |
| `main.rs:694-736` (actual active code) | Per-channel retention, soft delete only | ✅ Yes |

### The designed path (not active)

```
Retention deadline → reaper → key destruction → crypto-shred (unreadable)
                                ↓
                         compaction → rewrite segments (gone from disk)
```

### The actual path today

```
User clicks delete → adapter/mod.rs:907 → m.is_deleted = true → emits "message_deleted"
                                                        ↑
                                              Original content STAYS in commit log
```

### What compaction does (when wired)

`retention/compaction.rs` implements segment-level compaction:
1. Scan original segment for valid records
2. Filter out records whose `commit_seq` is in the tombstone set
3. Write kept records to a new segment file
4. fsync the new segment
5. Atomically rename the new segment over the old one
6. If all records are tombstoned: zero the file contents before unlink (forensic defense-in-depth)

### What key destruction does (when wired)

`retention/key_destruction.rs` implements crypto-shredding:
- Removes encryption keys from the `StreamKeyRegistry`
- Encrypted records remain on disk but are permanently unreadable
- Burned-seq tombstone records the destroyed range (Council Review #1 §1.1 invariant)
- Idempotent: second destroy returns Ok with keys_destroyed=0

## Getting to true ephemerality

To honestly claim "data gets erased when it's supposed to," wire up one of:

1. **Key destruction** (instant crypto-shred — data stays on disk but is unreadable)
2. **Compaction** (rewrite segment files after tombstones accumulate)
3. **Both** (compacted segments that were crypto-shredded = truly gone)

### Recommended approach

Wire the retention reaper to:
1. Call `destroy_stream_keys()` on retention deadline (crypto-shred)
2. Mark the stream's commit_seq range in the `TombstoneTable`
3. Trigger `compact_segment()` on segments with high tombstone ratio
4. Compaction drops tombstoned records + zeroes deleted segments

This gives you:
- Immediate unreadability (key destruction)
- Eventual disk reclamation (compaction)
- Defense-in-depth (zeroing before unlink)

## Verification checklist

After deploying privacy fixes, verify:

- [ ] `socket.rs` message logging is DEBUG (not INFO)
- [ ] `WABI_LOG_RETENTION_DAYS` is set (default 7)
- [ ] Log files don't contain message content: `grep -r "Received socket message" logs/` returns nothing
- [ ] Deleted messages don't appear in UI (soft delete works)
- [ ] Commit log compaction is wired (if true ephemerality is required)
- [ ] Key destruction is wired (if crypto-shred is required)

## Related skills

- `wabidb-troubleshooting` — WabiChat deployment and runtime issues
- `wabi-deploy` — Deploy wabi-server to Tim or other hosts
- `wabidb-core-capabilities` — WabiDB engine reference
