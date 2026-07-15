# 💾 Wabi Persistence Model

**Version:** 1.0.0  
**Date:** April 29, 2026  
**Status:** Design

---

## Philosophy

**"Signal + Self-Host Flexibility"**

Wabi defaults to client-side storage (like Signal), but server operators can opt into varying levels of persistence per channel. Self-host means **their data, their rules, their risk**.

---

## Storage Tiers

| Tier | Default | Who Controls | Purpose |
|------|---------|--------------|---------|
| **Client (IndexedDB)** | ✅ Always | User | Personal history, offline access |
| **Server (STDB memory)** | ✅ Always | Server admin | Real-time sync, active sessions |
| **Server (disk files)** | ❌ Opt-in | Server admin | Compliance, audit, backup |
| **server-auditor addon** | ❌ Opt-in | Server admin | Structured archival + retention |

---

## Persistence Modes

### 1. Ephemeral (Default)

Messages exist only in STDB memory. Deleted after TTL (default: 5 minutes).

**Use cases:**
- Temporary coordination channels
- Privacy-focused conversations
- High-churn chat rooms

**Config:**
```toml
[channels."#temp"]
persistence = "ephemeral"
ttl_minutes = 5
```

### 2. Session-Only

Messages persist until server restart. No disk writes.

**Use cases:**
- Daily standup channels
- Event coordination
- Testing/development

**Config:**
```toml
[channels."#standup"]
persistence = "session"
```

### 3. Persistent (Disk)

Messages written to `.jsonl` files on disk. Retention policies apply.

**Use cases:**
- Community servers with compliance needs
- Project coordination (audit trail)
- Servers wanting backup capability

**Config:**
```toml
[channels."#general"]
persistence = "persistent"
retention_days = 365
```

---

## File Format

### Location
```
~/.wabi/data/{server_id}/channels/{channel_id}/messages.jsonl
```

### Structure
```jsonl
{"ts":"2026-04-29T13:00:00.000Z","user_id":"usr_abc123","content":"hello world","edited":false}
{"ts":"2026-04-29T13:00:05.000Z","user_id":"usr_def456","content":"hi there","edited":false}
{"ts":"2026-04-29T13:01:00.000Z","user_id":"usr_abc123","content":"edited message","edited":true}
```

### Why JSONL?
- Append-only (no read-modify-write)
- Line-based (easy to stream, grep, tail)
- Human-readable (can inspect with cat/head)
- Backup-friendly (rsync, tar, etc.)
- Recovery possible even if server crashes mid-write

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Client (Browser/Tauri)                  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ IndexedDB (wabi-chat-db)                              │  │
│  │ - All messages (encrypted optional)                   │  │
│  │ - Compressed storage                                  │  │
│  │ - User controls retention                             │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            ↓ WebSocket
┌─────────────────────────────────────────────────────────────┐
│                    Server (wabi-server)                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ STDB (in-memory)                                      │  │
│  │ - Active session state                                │  │
│  │ - Real-time message routing                           │  │
│  │ - Channel/user presence                               │  │
│  └───────────────────────────────────────────────────────┘  │
│                            ↓                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ persistence-disk addon (optional)                     │  │
│  │ - Watches message events                              │  │
│  │ - Writes to .jsonl files                              │  │
│  │ - Applies retention policies                          │  │
│  │ - Handles rotation/archival                           │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                    Filesystem                                │
│  ~/.wabi/data/{server_id}/channels/                        │
│  ├── general/                                              │
│  │   └── messages.jsonl                                    │
│  ├── random/                                               │
│  │   └── messages.jsonl                                    │
│  └── ...                                                   │
└─────────────────────────────────────────────────────────────┘
```

---

## STDB Tables

### ChannelConfig (new)
```rust
#[spacetimedb(table)]
pub struct ChannelConfig {
    pub channel_id: String,
    pub persistence: String, // "ephemeral" | "session" | "persistent"
    pub ttl_minutes: Option<u32>,
    pub retention_days: Option<u32>,
    pub created_at: u64,
    pub updated_at: u64,
}
```

### PersistenceStats (new)
```rust
#[spacetimedb(table)]
pub struct PersistenceStats {
    pub channel_id: String,
    pub total_messages: u64,
    pub disk_size_bytes: u64,
    pub oldest_message_ts: Option<u64>,
    pub newest_message_ts: Option<u64>,
    pub last_rotation_ts: Option<u64>,
}
```

---

## Addon: persistence-disk

**Location:** `addons/compliance/persistence-disk/`

**Responsibilities:**
1. Subscribe to message events from STDB
2. Write messages to `.jsonl` files (append-only)
3. Apply retention policies (delete old messages)
4. Rotate files (daily/weekly/monthly)
5. Report stats to STDB

**Implementation:**
```rust
// Core writer trait
pub trait MessageWriter {
    async fn write(&self, channel_id: &str, message: &Message) -> Result<()>;
    async fn rotate(&self, channel_id: &str) -> Result<()>;
    async fn prune(&self, channel_id: &str, before: DateTime<Utc>) -> Result<usize>;
}

// JSONL implementation
pub struct JsonlWriter {
    base_path: PathBuf,
    buffer: Arc<Mutex<HashMap<String, BufWriter<File>>>>,
}
```

**Config:**
```toml
[persistence-disk]
enabled = true
base_path = "~/.wabi/data"
flush_interval_seconds = 10
rotation = "daily"  # daily | weekly | monthly
max_file_size_mb = 100
```

---

## Privacy & Legal

### User Visibility

Users MUST know when joining a channel what the persistence mode is:

```
┌────────────────────────────────────────────────┐
│ Joining #general                               │
│                                                │
│ ⚠️ This channel has PERSISTENT storage         │
│ Messages are saved to disk by the server       │
│ Retention: 365 days                            │
│                                                │
│ [Join Anyway]  [Cancel]                        │
└────────────────────────────────────────────────┘
```

### Server Admin Responsibilities

Document clearly in admin guide:

1. **Legal compliance** — They're responsible for their jurisdiction
2. **User notification** — Must inform users of persistence
3. **Data requests** — They handle deletion/export requests
4. **Security** — They secure the filesystem

### Wabi Legal Protection

Wabi is **infrastructure only**:
- We don't mandate persistence
- We don't access stored data
- Server operators control all settings
- Publish design openly (like BitTorrent)

---

## Migration Path

### From Client-Only to Server Persistence

1. Server admin enables `persistence-disk` addon
2. Set channel config to `persistent`
3. New messages written to disk
4. Old messages remain in client IndexedDB
5. Optional: backfill from client exports

### From Server Persistence to Client-Only

1. Disable `persistence-disk` addon
2. Set channel config to `ephemeral`
3. Server stops writing to disk
4. Existing files remain (admin deletes manually)
5. Clients continue storing locally

---

## Implementation Plan

### Phase 1: Core Infrastructure
- [ ] Add `ChannelConfig` table to STDB
- [ ] Add persistence mode enum + validation
- [ ] Create `persistence-disk` addon skeleton

### Phase 2: Disk Writer
- [ ] Implement `JsonlWriter` (append-only)
- [ ] Add buffering + flush interval
- [ ] Implement file rotation (daily)
- [ ] Add retention policy enforcement

### Phase 3: UI Integration
- [ ] Channel settings → Persistence tab
- [ ] Mode selector (ephemeral/session/persistent)
- [ ] Retention config UI
- [ ] User warning modal on join

### Phase 4: Stats + Monitoring
- [ ] Add `PersistenceStats` table
- [ ] Periodic stats updates
- [ ] Admin dashboard widget
- [ ] Disk usage alerts

---

## Open Questions

1. **Encryption at rest?** — Server-side encryption adds complexity. Default: no (their server, their choice). Addon could add it.

2. **Backfill from clients?** — Let admins request historical data from connected clients. Tricky, maybe later.

3. **Compression?** — `.jsonl.gz` saves space but complicates recovery. Default: uncompressed (can pipe through gzip for backup).

4. **Multi-node sync?** — Mesh addon would need to replicate files. Out of scope for Phase 1.

---

## Related Docs

- `docs/addons/local-first.md` — Client-side storage model
- `docs/addons/server-auditor.md` — Structured archival addon
- `docs/admin/persistence.md` — Admin configuration guide (TODO)
