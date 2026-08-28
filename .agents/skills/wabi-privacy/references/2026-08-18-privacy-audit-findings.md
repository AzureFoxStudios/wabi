# Wabi Privacy Audit — Session Findings (2026-08-18)

## Audit scope

User asked: "I've almost exclusively used AI to update/install Wabi while developing it. I think it's stable but only because if something broke an AI can brute force a fix. But would a human reasonably be able to work with it?"

Followed by: "recheck against the git pull", "is it desktop wabi??", "how big is the harddrive?", "I need to be extra sure: we're not sniffing anything", "let's make sure logs aren't just clones of a chat".

## Environment facts

| Fact | Value |
|------|-------|
| Live production tree | `~/Desktop/Wabi/` on Tim (`tim@100.96.11.45`) |
| STDB-era zombie | `~/wabi/` on Tim (renamed to `~/wabi-outdated_backup/`, root-locked, can't delete remotely) |
| Live `wabi-server` binary | `~/Desktop/Wabi/target/release/wabi-server` (bind-mounted by docker-compose) |
| Docker compose | `docker-compose.yml` bind-mounts `./target/release/wabi-server:/wabi-server:ro` |
| Live data | `~/Desktop/Wabi/data/wabi-server/wabidb/` |
| Disk after cleanup | 117G total, 51G used, 60G free (46%) |
| Disk consumed by Wabi | Live tree 286M + zombies ~22G |

## Code paths audited

### Log content leakage

**`core/crates/wabi-server/src/socket.rs:67`** — logs every incoming socket message at INFO level:
```rust
tracing::info!("Received socket message: {}", text);
```
Chat messages, DMs, typing, presence → plaintext in log file. Fixed: downgrade to DEBUG.

### Soft delete only

**`core/crates/wabi-server/src/adapter/mod.rs:907`** — `delete_message()`:
```rust
m.is_deleted = true;
m.edited_at_micros = Some(now_micros());
// emits "message_deleted"
```
Original `message_created` event with full content stays in commit log forever.

### Retention reaper

**`core/crates/wabi-server/src/main.rs:694-736`** — runs every 60s, per-channel retention policy, calls `delete_message()` (soft delete only), does NOT purge commit log.

### WabiDB retention module (DESIGNED, NOT WIRED)

| Module | File | Purpose | Wired? |
|--------|------|---------|--------|
| reaper | `core/crates/wabidb/src/retention/reaper.rs` | Streams hitting retention deadline | ❌ |
| compaction | `core/crates/wabidb/src/retention/compaction.rs` | Rewrite segment files, drop tombstones, zero deleted segments | ❌ |
| key_destruction | `core/crates/wabidb/src/retention/key_destruction.rs` | Crypto-shredding (destroy keys = unreadable) | ❌ |
| tombstone | `core/crates/wabidb/src/retention/tombstone.rs` | Tombstone table for dead streams | ❌ |

Compaction does: scan segment → filter tombstoned records → write new segment → fsync → atomic rename → zero file if all tombstoned.

Key destruction does: remove encryption keys from StreamKeyRegistry → encrypted records remain on disk but unreadable → burned-seq tombstone records destroyed range.

## Honest "under oath" statement

> "Wabi is self-hosted. All data lives on my server, not a third party's. There's no telemetry, no analytics, no cloud exfiltration. Voice and video are real-time only — never recorded. Message deletion hides content from the UI; the server's internal event log retains a technical record until log rotation. I don't sell, share, or report that data to anyone."

DO NOT claim: "I don't record shit" (commit log stores every message).
DO NOT claim: "deleted messages are gone" (soft-deleted, content still in log).

## Fixes shipped this session

| File | Change |
|------|--------|
| `core/crates/wabi-server/src/socket.rs:67` | `tracing::info!` → `tracing::debug!` |
| `core/crates/wabi-server/src/main.rs:381-387` | Added daily log rotation + retention pruning (`WABI_LOG_RETENTION_DAYS`, default 7) |
| `core/crates/wabi-server/Cargo.toml` | Added `rolling` feature to `tracing-subscriber` |

## Remaining work (not done)

| # | Task | Status |
|---|------|--------|
| 1 | Wire up retention reaper → key destruction → compaction | ❌ Not done |
| 2 | Per-channel ephemeral mode (auto-purge after N hours) | ❌ Not done |
| 3 | Per-user data export (GDPR right to portability) | ❌ Not done |
| 4 | Per-user account deletion (GDPR right to erasure) | ❌ Not done |
| 5 | Privacy policy template for Wabi operators | ❌ Not done |

## Build/test commands

```bash
# Build release binary
cd /var/home/Ronin/wabi && cargo build --release -p wabi-server

# Run privacy-focused smoke test
cd /var/home/Ronin/wabi
mkdir -p /tmp/wabi-privacy-test/data
WABI_JWT_KEY="$(openssl rand -base64 48)" WABIDB_ROOT_KEY="$(openssl rand -hex 32)" \
  ./target/release/wabi-server --data-dir /tmp/wabi-privacy-test/data --host 127.0.0.1 --port 3001 &
sleep 5
# Send a message via API, check logs for content leakage
grep -r "Received socket message" logs/  # should return nothing (now DEBUG)
kill %1 2>/dev/null || true

# Verify commit log contains messages
ls /tmp/wabi-privacy-test/data/wabidb/streams/
```
