//! Persistence for the Tailcat addon.
//!
//! Deliberately NOT event-sourced through wabidb: like `admin_policies.json`
//! (auth policy), these are instance-local operational settings, not domain
//! data that replicates or replays. Hot-apply is provided by the manager
//! (in-memory projection + subprocess bounce), durability by these files, and
//! the audit trail by an append-only JSONL log — the properties the design
//! required (persisted, audited who/what/when, one-step reversible) without
//! touching postcard-encoded records (see AGENTS.md golden rule 5).
//!
//! Files live under `<data_dir>/tailcat/`:
//!   - settings.json  (enabled, pipe_port)
//!   - keys.json      (per-member client public keys)
//!   - audit.jsonl    (append-only: every mutation, actor-tagged)
//!   - addr.txt       (written by the tailcat subprocess via TAILCAT_ADDR_FILE)

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PersistedSettings {
    /// Whether the private-access pipe should run. Persists across restarts;
    /// the listener auto-respawns on boot when true.
    #[serde(default)]
    pub enabled: bool,
    /// Local loopback port the forwarder (and tailcat listener) use.
    /// Defaults to `server_port + 1` when absent.
    #[serde(default)]
    pub pipe_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberKeyRecord {
    pub id: String,
    pub user_id: i64,
    /// Client public key as printed by `tailcat printpub` (nodekey-prefixed
    /// or raw key material; normalized at spawn time for `--allow`).
    pub public_key: String,
    pub label: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub ts: String,
    pub actor: i64,
    pub action: String,
    pub details: Option<String>,
}

pub struct TailcatStore {
    dir: PathBuf,
}

impl TailcatStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("tailcat"),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn settings_path(&self) -> PathBuf {
        self.dir.join("settings.json")
    }

    fn keys_path(&self) -> PathBuf {
        self.dir.join("keys.json")
    }

    fn audit_path(&self) -> PathBuf {
        self.dir.join("audit.jsonl")
    }

    /// Atomic JSON write: temp file + rename so a crash mid-write can never
    /// leave a truncated settings/keys file behind.
    fn write_json_atomic(&self, path: &Path, value: &impl Serialize) -> anyhow::Result<()> {
        let raw = serde_json::to_string_pretty(value)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, raw)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn load_settings(&self) -> PersistedSettings {
        std::fs::read_to_string(self.settings_path())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save_settings(&self, settings: &PersistedSettings) -> anyhow::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        self.write_json_atomic(&self.settings_path(), settings)
    }

    pub fn load_keys(&self) -> Vec<MemberKeyRecord> {
        std::fs::read_to_string(self.keys_path())
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    pub fn save_keys(&self, keys: &[MemberKeyRecord]) -> anyhow::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        self.write_json_atomic(&self.keys_path(), &keys)
    }

    pub fn append_audit(&self, actor: i64, action: &str, details: Option<String>) {
        let _ = std::fs::create_dir_all(&self.dir);
        let entry = AuditEntry {
            ts: chrono::Utc::now().to_rfc3339(),
            actor,
            action: action.to_string(),
            details,
        };
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.audit_path())
        {
            if let Ok(line) = serde_json::to_string(&entry) {
                use std::io::Write;
                let _ = writeln!(file, "{line}");
            }
        }
    }

    pub fn read_audit(&self, limit: usize) -> Vec<AuditEntry> {
        let Ok(raw) = std::fs::read_to_string(self.audit_path()) else {
            return Vec::new();
        };
        let mut out: Vec<AuditEntry> = raw
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        let start = out.len().saturating_sub(limit);
        out.drain(..start);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_and_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        let store = TailcatStore::new(tmp.path());

        // Absent files => safe defaults (disabled).
        assert!(!store.load_settings().enabled);
        assert!(store.load_keys().is_empty());

        let mut s = store.load_settings();
        s.enabled = true;
        s.pipe_port = Some(3102);
        store.save_settings(&s).unwrap();

        let loaded = TailcatStore::new(tmp.path()).load_settings();
        assert!(loaded.enabled);
        assert_eq!(loaded.pipe_port, Some(3102));
    }

    #[test]
    fn keys_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let store = TailcatStore::new(tmp.path());

        let key = MemberKeyRecord {
            id: "k1".into(),
            user_id: 7,
            public_key: "nodekey:abc".into(),
            label: Some("laptop".into()),
            created_at: "2026-09-01T00:00:00Z".into(),
        };
        store.save_keys(&[key]).unwrap();
        let keys = TailcatStore::new(tmp.path()).load_keys();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].user_id, 7);
        assert_eq!(keys[0].public_key, "nodekey:abc");
    }

    #[test]
    fn audit_appends_and_reads_tail() {
        let tmp = tempfile::tempdir().unwrap();
        let store = TailcatStore::new(tmp.path());
        for i in 0..5 {
            store.append_audit(i, "test-action", Some(format!("detail-{i}")));
        }
        let tail = store.read_audit(3);
        assert_eq!(tail.len(), 3);
        assert_eq!(tail[0].actor, 2);
        assert_eq!(tail[2].actor, 4);
    }
}
