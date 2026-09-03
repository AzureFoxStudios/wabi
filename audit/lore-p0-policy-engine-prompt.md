# P0: Policy Engine Foundation — OpenCode Dispatch

## Context

You are building the policy engine foundation for Wabi's Lore/coding workspace. This is the critical path — everything else (browser UX, citations, review, editor) depends on this.

**Wabi** is a self-hosted team HQ (Discord alternative) built as ONE Rust binary. It uses WabiDB (event-sourced, append-only) with projections as in-memory materialized views. The Lore addon shells out to Epic Games Lore CLI for VCS operations.

**Existing role system:** `UserRole` enum in `crates/wabi-core/src/auth.rs` has Owner/Admin/Mod/Contributor/Viewer with hierarchy levels. `get_user_role()` in WabiStore trait returns a String role name from the AuditProjection.

**Existing Lore API:** `core/crates/wabi-server/src/api/lore.rs` has basic role gates (`can_edit_lore`, `can_asset_write_lore`) that check `UserRole` but are coarse-grained (no path or ref policy).

## What to Build

### P0.1 — Capability Vocabulary

Create a new module `crates/wabi-core/src/lore/capability.rs` with:

```rust
/// Fine-grained capabilities for Lore workspace operations.
/// These are NOT the same as UserRole — a single role can map to many capabilities.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum LoreCapability {
    /// Push to any branch
    RefPush,
    /// Merge branches (into protected refs)
    RefMerge,
    /// Force push to a branch
    RefForcePush,
    /// Delete a branch
    RefDelete,
    /// Write to any path in the repo
    PathWriteAll,
    /// Write to a specific path pattern (stored as string, checked at runtime)
    PathWritePattern,
    /// Create/modify file locks
    Lock,
    /// Approve review changes
    ReviewApprove,
    /// Edit policy rules
    PolicyEdit,
    /// Pause workspace egress (incident response)
    EgressPause,
    /// View audit log
    AuditView,
}
```

Also create `LoreCapabilitySet` (bitflags-style HashSet wrapper) with `contains()`, `union()`, `intersection()`.

### P0.2 — Ref Policy

Create `crates/wabi-core/src/lore/ref_policy.rs`:

```rust
/// Policy rules for a specific branch or ref pattern.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct RefPolicy {
    /// Branch name or glob pattern (e.g., "main", "release/*")
    pub ref_pattern: String,
    /// Who can push to this ref
    pub push_capabilities: Vec<LoreCapability>,
    /// Who can merge into this ref
    pub merge_capabilities: Vec<LoreCapability>,
    /// Require N approvals before merge (None = no requirement)
    pub required_approvals: Option<u32>,
    /// Allow force push (default false)
    pub allow_force_push: bool,
    /// Allow branch deletion (default true)
    pub allow_delete: bool,
    /// Break-glass: these roles can override (with audit)
    pub break_glass_roles: Vec<String>,
}

/// Repository-level ref policy collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct RefPolicySet {
    pub policies: Vec<RefPolicy>,
    /// Default policy when no pattern matches
    pub default_policy: RefPolicy,
}
```

Implement `RefPolicySet::matching_policy(&self, branch_name: &str) -> &RefPolicy` using glob matching (use `globset` crate, add to `Cargo.toml`).

### P0.3 — Path Policy

Create `crates/wabi-core/src/lore/path_policy.rs`:

```rust
/// Policy rules for file paths in the repo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct PathPolicy {
    /// Glob pattern for paths (e.g., "assets/**", "src/net/**")
    pub path_pattern: String,
    /// Roles/capabilities that can write to this path
    pub write_roles: Vec<String>,
    /// Require lock before edit (default false)
    pub require_lock: bool,
    /// Read-only for all (override write_roles)
    pub read_only: bool,
}

/// Repository-level path policy collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct PathPolicySet {
    pub policies: Vec<PathPolicy>,
    /// Default policy when no pattern matches
    pub default_policy: PathPolicy,
}
```

Implement `PathPolicySet::effective_policy(&self, path: &str) -> &PathPolicy` using glob matching.

### P0.4 — Role → Capability Mapping

Create `crates/wabi-core/src/lore/role_mapping.rs`:

```rust
/// Maps UserRole → LoreCapability set.
/// This is the bridge between Wabi's existing role system and Lore capabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct RoleCapabilityMap {
    /// Role name (e.g., "owner", "admin", "developer", "artist", "viewer")
    pub role: String,
    /// Capabilities granted to this role
    pub capabilities: Vec<LoreCapability>,
}

/// Repository-level role→capability mapping.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct RoleCapabilityMapSet {
    pub mappings: Vec<RoleCapabilityMap>,
}
```

Implement:
- `RoleCapabilityMapSet::capabilities_for_role(&self, role: &str) -> Vec<LoreCapability>`
- Default mappings:
  - Owner: ALL capabilities
  - Admin: all except EgressPause (optional)
  - Developer: RefPush, RefMerge, PathWriteAll, Lock, ReviewApprove
  - Artist: PathWritePattern (assets/**), Lock
  - Viewer: nothing write, AuditView

### P0.5 — Unified Policy Check

Create `crates/wabi-core/src/lore/mod.rs` that exports all submodules and provides:

```rust
/// Check if a user with the given role can perform the action on the target.
pub fn check_policy(
    role: &str,
    capability_map: &RoleCapabilityMapSet,
    ref_policy: &RefPolicySet,
    path_policy: &PathPolicySet,
    action: &str, // "push", "merge", "write", "lock", "delete_branch"
    branch: &str,
    path: Option<&str>,
) -> PolicyResult {
    // 1. Get capabilities for role
    // 2. Check ref policy if action is ref-related
    // 3. Check path policy if action is path-related
    // 4. Return Allow/Deny with reason
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum PolicyResult {
    Allow,
    Deny { reason: String },
}
```

### P0.6 — Fetch Quotas

Create `crates/wabi-core/src/lore/fetch_quota.rs`:

```rust
/// Per-user fetch quotas for Lore blobs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct FetchQuota {
    /// Max concurrent file transfers per user
    pub max_concurrent: u32,
    /// Max bytes per day per user (0 = unlimited)
    pub daily_bytes: u64,
    /// Max bytes per single export job (0 = unlimited)
    pub max_export_bytes: u64,
}

/// Workspace-level fetch ceiling.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct WorkspaceFetchCeiling {
    /// Total concurrent transfers across all users
    pub max_concurrent: u32,
    /// Total bytes per day across all users
    pub daily_bytes: u64,
}
```

### P0.7 — Audit Events

Create `crates/wabi-core/src/lore/audit.rs`:

```rust
/// Audit event types for Lore workspace operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum LoreAuditEventType {
    PolicyChanged,
    EgressPaused,
    EgressResumed,
    BreakGlassUsed,
    TokenRevoked,
    RefPolicyUpdated,
    PathPolicyUpdated,
    RoleCapabilityUpdated,
}

/// Audit log entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct LoreAuditEntry {
    pub timestamp: u64,
    pub user_id: u64,
    pub event_type: LoreAuditEventType,
    pub description: String,
    pub details: serde_json::Value,
}
```

## Files to Modify

1. `crates/wabi-core/Cargo.toml` — add `globset` dependency
2. `crates/wabi-core/src/lore/mod.rs` — NEW, export all submodules
3. `crates/wabi-core/src/lore/capability.rs` — NEW
4. `crates/wabi-core/src/lore/ref_policy.rs` — NEW
5. `crates/wabi-core/src/lore/path_policy.rs` — NEW
6. `crates/wabi-core/src/lore/role_mapping.rs` — NEW
7. `crates/wabi-core/src/lore/fetch_quota.rs` — NEW
8. `crates/wabi-core/src/lore/audit.rs` — NEW
9. `crates/wabi-core/src/lib.rs` — add `pub mod lore;`
10. `crates/wabi-core/tests/lore_policy.rs` — NEW, unit tests for policy checks

## Constraints

- **Svelte 5 runes only** in frontend (not relevant here, backend only)
- **ts-rs codegen**: all types with `#[cfg_attr(feature = "ts", derive(TS))]` and `#[cfg_attr(feature = "ts", ts(export))]`
- **serde camelCase** for all wire types
- **non_exhaustive** on enums that will grow
- **No postcard encoding** for these types (they're policy, not domain records)
- **globset** for pattern matching (add to Cargo.toml)

## Verification

```bash
cd /var/home/Ronin/wabi
cargo check -p wabi-core 2>&1 | tail -20
cargo test -p wabi-core --features ts 2>&1 | tail -40
```

## Output

Write a report to `/var/home/Ronin/wabi/audit/lore-p0-policy-engine-report.md` with:
- What was implemented
- File list with line counts
- Test results
- Known gaps / next steps