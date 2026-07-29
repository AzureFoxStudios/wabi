> **Historical note (2026-06-22):** This document predates the STDB → Wabidb rip. STDB/SpacetimeDB/wabi-node references are historical. The current architecture is wabi-server with embedded Wabidb. See PROJECT_DOCS/01-architecture/ARCHITECTURE.md for the current state.


# Config-in-DB Design

## Goal
All runtime configuration loaded from SpacetimeDB so changes apply without server restart.

---

## Current Flow
```
Env vars → ServerConfig (struct) → AppState.config (immutable after startup)
```

## Target Flow
```
Env vars (defaults only) 
    → Startup Bootstrap (upsert to STDB if missing) 
    → STDB app_setting table (source of truth) 
    → AppState.config (cached, hot-reloadable)
    → Background poller / Socket.IO event → refresh cache
```

---

## STDB Table: `app_setting`

| Column | Type | Description |
|--------|------|-------------|
| `key` | STRING (PK) | Config key, e.g. `max_body_size` |
| `value` | STRING | Serialized value |
| `value_type` | STRING | `u64`, `i64`, `bool`, `string`, `json` |
| `description` | STRING | Human-readable |
| `updated_at` | INT64 | Unix ms |
| `updated_by` | INT64 | User ID who changed it |

---

## Reducer: `ingest_wabi_event` (entity: `app_setting`)

```rust
// Operations: upsert, delete
{
  "entity": "app_setting",
  "operation": "upsert",
  "payload": {
    "row": {
      "key": "max_body_size",
      "value": "53687091200",
      "value_type": "u64",
      "description": "Max request body size in bytes",
      "updated_at": 1717680000000,
      "updated_by": 1
    }
  }
}
```

---

## Implementation Phases

### Phase 1: Bootstrap + Load (No Hot-Reload Yet)
1. Add `app_setting` table to STDB module
2. On startup: for each known config key, read env → if STDB missing, upsert default
3. Load all settings from STDB into `ServerConfig` (override env)
4. Add `ConfigStore` to `AppState` with typed getters

### Phase 2: Admin API + Hot-Reload
1. `GET /api/admin/settings` — list all (auth: owner/admin)
2. `PUT /api/admin/settings/{key}` — update single (auth: owner/admin)
3. Background task: poll STDB every 30s, refresh `AppState.config` on change
4. Or: Socket.IO event `config:updated` from admin API → immediate refresh

### Phase 3: Migrate All Config
Move every env var to DB-backed:
- `JWT_SECRET` (sensitive — encrypt at rest?)
- `WABI_STDB_SERVER`, `WABI_STDB_DATABASE`
- `WABI_MAX_BODY_SIZE`
- `WABI_TURN_*`
- `WABI_MESH_*`
- `WABI_ADMIN_USER_IDS`
- etc.

---

## Code Sketch

```rust
// In state.rs
pub struct ConfigStore {
    inner: RwLock<HashMap<String, ConfigValue>>,
    stdb: StdbClient,
}

#[derive(Clone, Debug)]
pub enum ConfigValue {
    U64(u64),
    I64(i64),
    Bool(bool),
    String(String),
    Json(serde_json::Value),
}

impl ConfigStore {
    pub async fn load_from_stdb(&self) -> Result<()> { ... }
    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> { ... }
    pub async fn set(&self, key: &str, value: ConfigValue, user_id: i64) -> Result<()> { ... }
    
    // Hot-reload
    pub async fn start_watcher(&self) { ... }
}
```

```rust
// In main.rs startup
let config = ServerConfig::from_env_with_stdb_overrides(&state.stdb).await?;
let state = Arc::new(AppState::new(config));
state.config_store.start_watcher().await;
```

---

## Security Notes
- **Sensitive values** (JWT_SECRET, TURN_SECRET): encrypt before storing? Or keep in env only?
- **Admin-only writes**: `PUT /api/admin/settings` requires owner/admin role
- **Audit trail**: `updated_by` + `updated_at` tracks who changed what
- **Rollback**: `DELETE` operation restores env default

---

## Migration Strategy
1. Add table + bootstrap (Phase 1) — zero config changes for users
2. Deploy, verify loads correctly
3. Add admin API (Phase 2) — opt-in UI for config changes
4. Gradually migrate keys from env → DB
5. Eventually: env vars only for bootstrap defaults + secrets

---

## Open Questions
1. **Secrets in DB?** JWT_SECRET, TURN_SECRET — encrypt with age? Or keep in env only?
2. **Validation on write?** Reject invalid values (e.g., negative max_body_size)?
3. **Type coercion?** Env vars are strings; DB stores typed — handle parse errors gracefully?
4. **Cluster-aware?** Multiple wabi-server instances — all watch same STDB table, all hot-reload.