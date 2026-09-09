//! User-defined Lore role tiers (GitHub-custom-roles model).
//!
//! Roles are data, not code: named bundles of toggleable [`LoreCapability`]
//! strings persisted in `<data_dir>/lore_roles.json`, plus a configurable
//! default policy (`"view"` | `"open"`) for roleless/unknown-role users.
//!
//! `owner` / `admin` are the un-lockable base: the owner id is fully locked
//! (cannot be edited or deleted) and the admin id cannot have its capability
//! set reduced below [`ALL_CAPABILITIES`]. Only admin-gated socket handlers
//! (see `socketio/wiring_handlers.rs`) may mutate the store.
//!
//! The store uses `std::sync::RwLock` (not tokio's) so the synchronous
//! `server_role_catalog()` — also called from `presence.rs`, which is out of
//! scope for the roles migration — can read it without blocking the runtime.
//! All critical sections only clone small maps; file I/O happens outside the
//! locks.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, RwLock};

use serde::{Deserialize, Serialize};

// ─── Capabilities ────────────────────────────────────────────────────────────

pub const CAP_VIEW: &str = "lore.view";
pub const CAP_STAGE: &str = "lore.stage";
pub const CAP_COMMIT: &str = "lore.commit";
pub const CAP_APPROVE: &str = "lore.approve";
pub const CAP_LOCK: &str = "lore.lock";
pub const CAP_MANAGE_BINDING: &str = "lore.manage-binding";
pub const CAP_ADMIN: &str = "lore.admin";

/// Canonical capability order (also the seed order for owner/admin).
pub const ALL_CAPABILITIES: [&str; 7] = [
    CAP_VIEW,
    CAP_STAGE,
    CAP_COMMIT,
    CAP_APPROVE,
    CAP_LOCK,
    CAP_MANAGE_BINDING,
    CAP_ADMIN,
];

pub fn is_known_capability(cap: &str) -> bool {
    ALL_CAPABILITIES.contains(&cap)
}

// ─── Role definition ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LoreRoleDef {
    /// Lowercase slug `^[a-z0-9-]{1,32}$` (e.g. `"developer"`).
    pub id: String,
    /// Display name (e.g. `"Developer"`), non-empty, ≤ 40 chars.
    pub name: String,
    pub description: String,
    /// Subset of [`ALL_CAPABILITIES`].
    #[serde(default)]
    pub capabilities: Vec<String>,
}

/// On-disk shape: `{ "roles": [...], "defaultPolicy": "view" | "open" }`.
#[derive(Debug, Serialize, Deserialize)]
struct LoreRolesFile {
    #[serde(default)]
    roles: Vec<LoreRoleDef>,
    #[serde(
        rename = "defaultPolicy",
        alias = "default_policy",
        default = "default_policy_view"
    )]
    default_policy: String,
}

fn default_policy_view() -> String {
    "view".to_string()
}

// ─── Store ───────────────────────────────────────────────────────────────────

pub struct LoreRoleStore {
    path: PathBuf,
    roles: RwLock<HashMap<String, LoreRoleDef>>,
    default_policy: RwLock<String>,
}

impl LoreRoleStore {
    /// Open (or seed) the store at `<data_dir>/lore_roles.json` and publish
    /// it to the process-global handle read by `server_role_catalog()`.
    pub fn open(data_dir: &str) -> Arc<Self> {
        let store = Self::load(PathBuf::from(data_dir).join("lore_roles.json"));
        publish_lore_roles(store.clone());
        store
    }

    /// Load from an explicit path; seeds defaults (and persists them) only
    /// when the file is missing. A present-but-corrupt file is NOT
    /// overwritten — it loads empty so the failure stays visible instead of
    /// silently resetting admin-configured tiers.
    pub fn load(path: PathBuf) -> Arc<Self> {
        match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<LoreRolesFile>(&bytes) {
                Ok(file) => {
                    let roles = file
                        .roles
                        .into_iter()
                        .map(|r| (r.id.clone(), r))
                        .collect::<HashMap<_, _>>();
                    Arc::new(Self {
                        path,
                        roles: RwLock::new(roles),
                        default_policy: RwLock::new(normalize_policy(&file.default_policy)),
                    })
                }
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "lore_roles.json corrupt; starting empty (file left untouched)");
                    Arc::new(Self {
                        path,
                        roles: RwLock::new(HashMap::new()),
                        default_policy: RwLock::new("view".to_string()),
                    })
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let store = Arc::new(Self {
                    path,
                    roles: RwLock::new(seed_roles()),
                    default_policy: RwLock::new("view".to_string()),
                });
                if let Err(e) = store.save() {
                    tracing::warn!(error = %e, "failed to persist seeded lore_roles.json");
                }
                store
            }
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "cannot read lore_roles.json; starting empty");
                Arc::new(Self {
                    path,
                    roles: RwLock::new(HashMap::new()),
                    default_policy: RwLock::new("view".to_string()),
                })
            }
        }
    }

    /// Atomic-ish persist: write temp + rename (mirrors `PolicyStore`).
    pub fn save(&self) -> std::io::Result<()> {
        use std::io::Write;
        let file = LoreRolesFile {
            roles: self.list_roles(),
            default_policy: self.default_policy(),
        };
        let bytes = serde_json::to_vec_pretty(&file)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let parent = self.path.parent().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "role path has no parent")
        })?;
        let temporary = parent.join(format!(".lore-roles-{}.tmp", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut f = options.open(&temporary)?;
        let outcome = (|| -> std::io::Result<()> {
            f.write_all(&bytes)?;
            f.sync_all()?;
            drop(f);
            std::fs::rename(&temporary, &self.path)?;
            Ok(())
        })();
        if outcome.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        outcome
    }

    /// Resolve a stored workspace-role id (lowercase slug) to its capability
    /// bundle. Returns `None` for unknown ids (caller falls back to the
    /// default policy) and for `None` (roleless users).
    pub fn capabilities_for(&self, role_id: Option<&str>) -> Option<Vec<String>> {
        let id = role_id?;
        self.roles
            .read()
            .ok()?
            .get(id)
            .map(|r| r.capabilities.clone())
    }

    /// Sorted snapshot for list/catalog emits.
    pub fn list_roles(&self) -> Vec<LoreRoleDef> {
        let mut roles: Vec<LoreRoleDef> = self
            .roles
            .read()
            .map(|g| g.values().cloned().collect())
            .unwrap_or_default();
        roles.sort_by(|a, b| a.id.cmp(&b.id));
        roles
    }

    pub fn get_role(&self, id: &str) -> Option<LoreRoleDef> {
        self.roles.read().ok()?.get(id).cloned()
    }

    pub fn default_policy(&self) -> String {
        self.default_policy
            .read()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "view".to_string())
    }

    pub fn default_policy_is_open(&self) -> bool {
        self.default_policy() == "open"
    }

    /// `{ roles: [...], defaultPolicy }` snapshot for socket emits.
    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "roles": self.list_roles(),
            "defaultPolicy": self.default_policy(),
        })
    }

    /// Validate + insert/update a role, enforcing built-in protections:
    /// - `owner` is fully locked (cannot be edited at all).
    /// - `admin` cannot have its capability set reduced below ALL.
    /// Persists on success. Returns a human-readable error for
    /// `lore-roles-error` responses.
    pub fn upsert(&self, mut def: LoreRoleDef) -> Result<LoreRoleDef, String> {
        validate_role_def(&def)?;
        // Canonicalize capability order + dedupe.
        let mut caps: Vec<String> = def
            .capabilities
            .iter()
            .filter(|c| is_known_capability(c))
            .cloned()
            .collect();
        caps.sort_by_key(|c| ALL_CAPABILITIES.iter().position(|k| k == c));
        caps.dedup();
        def.capabilities = caps;

        if def.id == "owner" {
            return Err("The owner role is locked and cannot be edited".to_string());
        }
        if def.id == "admin"
            && !ALL_CAPABILITIES
                .iter()
                .all(|k| def.capabilities.iter().any(|c| c == k))
        {
            return Err("The admin role must keep all capabilities".to_string());
        }
        {
            let mut guard = self.roles.write().map_err(|_| "role store unavailable".to_string())?;
            guard.insert(def.id.clone(), def.clone());
        }
        self.save()
            .map_err(|e| format!("Failed to persist lore roles: {e}"))?;
        Ok(def)
    }

    /// Delete a custom role. Built-ins (`owner`, `admin`) are refused.
    /// Assignments pointing at a deleted id are NOT scanned per-user (too
    /// expensive); affected users simply fall back to the default policy
    /// (see `capabilities_for` returning `None` for unknown ids).
    pub fn delete(&self, id: &str) -> Result<(), String> {
        if id == "owner" || id == "admin" {
            return Err(format!("The {id} role cannot be deleted"));
        }
        let removed = {
            let mut guard = self.roles.write().map_err(|_| "role store unavailable".to_string())?;
            guard.remove(id).is_some()
        };
        if !removed {
            return Err(format!("Unknown role '{id}'"));
        }
        self.save()
            .map_err(|e| format!("Failed to persist lore roles: {e}"))?;
        Ok(())
    }

    pub fn set_default_policy(&self, policy: &str) -> Result<String, String> {
        let normalized = normalize_policy(policy);
        if policy.trim().to_ascii_lowercase() != "view"
            && policy.trim().to_ascii_lowercase() != "open"
        {
            return Err("policy must be \"view\" or \"open\"".to_string());
        }
        {
            let mut guard = self
                .default_policy
                .write()
                .map_err(|_| "role store unavailable".to_string())?;
            *guard = normalized.clone();
        }
        self.save()
            .map_err(|e| format!("Failed to persist lore roles: {e}"))?;
        Ok(normalized)
    }
}

fn normalize_policy(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "open" => "open".to_string(),
        _ => "view".to_string(),
    }
}

fn all_caps() -> Vec<String> {
    ALL_CAPABILITIES.iter().map(|s| s.to_string()).collect()
}

pub(crate) fn seed_roles() -> HashMap<String, LoreRoleDef> {
    [
        LoreRoleDef {
            id: "owner".into(),
            name: "Owner".into(),
            description: "Server owner. All capabilities.".into(),
            capabilities: all_caps(),
        },
        LoreRoleDef {
            id: "admin".into(),
            name: "Admin".into(),
            description: "Server administrator. All capabilities.".into(),
            capabilities: all_caps(),
        },
        LoreRoleDef {
            id: "developer".into(),
            name: "Developer".into(),
            description: "Full edit access to repositories (stage, commit, approve, lock)."
                .into(),
            capabilities: vec![
                CAP_VIEW.into(),
                CAP_STAGE.into(),
                CAP_COMMIT.into(),
                CAP_APPROVE.into(),
                CAP_LOCK.into(),
            ],
        },
        LoreRoleDef {
            id: "artist".into(),
            name: "Artist".into(),
            description: "Asset-write access (stage and lock artwork assets).".into(),
            capabilities: vec![CAP_VIEW.into(), CAP_STAGE.into(), CAP_LOCK.into()],
        },
        LoreRoleDef {
            id: "member".into(),
            name: "Member".into(),
            description: "Read-only repository access by default.".into(),
            capabilities: vec![CAP_VIEW.into()],
        },
    ]
    .into_iter()
    .map(|r| (r.id.clone(), r))
    .collect()
}

/// Payload validation for `lore-roles-upsert` (`id?`, `name`, `description`,
/// `capabilities`). Shared by the socket handler so unit tests cover the
/// contract without a socket.
pub fn validate_role_def(def: &LoreRoleDef) -> Result<(), String> {
    if def.id.is_empty()
        || def.id.len() > 32
        || !def
            .id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("id must match ^[a-z0-9-]{1,32}$".to_string());
    }
    let name = def.name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err("name must be non-empty and at most 40 characters".to_string());
    }
    if let Some(bad) = def.capabilities.iter().find(|c| !is_known_capability(c)) {
        return Err(format!("unknown capability '{bad}'"));
    }
    Ok(())
}

/// Derive a valid slug id from a display name (used when upsert omits `id`).
pub fn slugify_name(name: &str) -> String {
    let mut slug: String = name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c
            } else if c == '-' || c == '_' || c == ' ' {
                '-'
            } else {
                '\0'
            }
        })
        .filter(|c| *c != '\0')
        .collect();
    // Collapse runs of '-' and trim edges.
    let mut collapsed = String::with_capacity(slug.len());
    let mut prev_dash = false;
    for c in slug.drain(..) {
        if c == '-' {
            if !prev_dash {
                collapsed.push(c);
            }
            prev_dash = true;
        } else {
            collapsed.push(c);
            prev_dash = false;
        }
    }
    collapsed.trim_matches('-').to_string()
}

// ─── Process-global handle ───────────────────────────────────────────────────
// Same OnceLock pattern as `CONNECTED_USERS` in socketio/shared.rs: the sync
// `server_role_catalog()` (also called from presence.rs) reads the store
// without a state handle.

static SHARED_LORE_ROLES: OnceLock<Arc<LoreRoleStore>> = OnceLock::new();

pub fn publish_lore_roles(store: Arc<LoreRoleStore>) {
    let _ = SHARED_LORE_ROLES.set(store);
}

pub fn shared_lore_roles() -> Option<Arc<LoreRoleStore>> {
    SHARED_LORE_ROLES.get().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_defaults_match_spec() {
        let roles = seed_roles();
        assert_eq!(roles.len(), 5);
        assert_eq!(roles["owner"].capabilities, all_caps());
        assert_eq!(roles["admin"].capabilities, all_caps());
        assert_eq!(
            roles["developer"].capabilities,
            vec!["lore.view", "lore.stage", "lore.commit", "lore.approve", "lore.lock"]
        );
        assert_eq!(
            roles["artist"].capabilities,
            vec!["lore.view", "lore.stage", "lore.lock"]
        );
        assert_eq!(roles["member"].capabilities, vec!["lore.view"]);
    }

    #[test]
    fn capabilities_for_unknown_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope").join("lore_roles.json");
        // Missing parent dir: seed in memory, persist fails silently.
        let store = LoreRoleStore::load(missing);
        assert!(store.capabilities_for(None).is_none());
        assert!(store.capabilities_for(Some("nope")).is_none());
        assert_eq!(
            store.capabilities_for(Some("developer")).unwrap(),
            vec!["lore.view", "lore.stage", "lore.commit", "lore.approve", "lore.lock"]
        );
    }

    #[test]
    fn seed_persists_and_reloads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lore_roles.json");
        let first = LoreRoleStore::load(path.clone());
        assert!(path.exists());
        assert_eq!(first.default_policy(), "view");
        let second = LoreRoleStore::load(path);
        assert_eq!(second.list_roles().len(), 5);
    }

    #[test]
    fn builtin_protections() {
        let dir = tempfile::tempdir().unwrap();
        let store = LoreRoleStore::load(dir.path().join("lore_roles.json"));
        // owner fully locked
        let owner = store.get_role("owner").unwrap();
        assert!(store.upsert(owner).is_err());
        // admin reduced below ALL refused
        let mut admin = store.get_role("admin").unwrap();
        admin.capabilities = vec!["lore.view".into()];
        assert!(store.upsert(admin).is_err());
        // admin full-set edit allowed
        let admin = store.get_role("admin").unwrap();
        assert!(store.upsert(admin).is_ok());
        // built-in delete refused
        assert!(store.delete("owner").is_err());
        assert!(store.delete("admin").is_err());
        // validation
        let bad = LoreRoleDef {
            id: "Bad_Id!".into(),
            name: "x".into(),
            description: String::new(),
            capabilities: vec![],
        };
        assert!(store.upsert(bad).is_err());
        let bad_cap = LoreRoleDef {
            id: "custom".into(),
            name: "Custom".into(),
            description: String::new(),
            capabilities: vec!["lore.fly".into()],
        };
        assert!(store.upsert(bad_cap).is_err());
    }

    #[test]
    fn custom_role_roundtrip_and_delete_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        let store = LoreRoleStore::load(dir.path().join("lore_roles.json"));
        let def = LoreRoleDef {
            id: "reviewer".into(),
            name: "Reviewer".into(),
            description: "Can approve.".into(),
            capabilities: vec!["lore.approve".into(), "lore.view".into()],
        };
        let saved = store.upsert(def).unwrap();
        // Canonical order follows ALL_CAPABILITIES.
        assert_eq!(saved.capabilities, vec!["lore.view", "lore.approve"]);
        store.delete("reviewer").unwrap();
        assert!(store.capabilities_for(Some("reviewer")).is_none());
        assert!(store.delete("reviewer").is_err());
    }

    #[test]
    fn default_policy_accepts_only_view_or_open() {
        let dir = tempfile::tempdir().unwrap();
        let store = LoreRoleStore::load(dir.path().join("lore_roles.json"));
        assert_eq!(store.set_default_policy("open").unwrap(), "open");
        assert!(store.default_policy_is_open());
        assert_eq!(store.set_default_policy("view").unwrap(), "view");
        assert!(store.set_default_policy("everything").is_err());
    }

    #[test]
    fn slugify_name_behaves() {
        assert_eq!(slugify_name("Level Designer"), "level-designer");
        assert_eq!(slugify_name("  QA--Lead__X  "), "qa-lead-x");
        assert_eq!(slugify_name("!!!"), "");
    }
}
