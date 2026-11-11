//! Local state: global credentials, per-folder link, and the sync baseline.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Name of the per-folder link file written by `wabi-sync link`.
pub const LINK_FILE: &str = ".wabi-sync.json";
/// Directory (inside the synced folder) holding mutable sync state.
pub const STATE_DIR: &str = ".wabi-sync";

fn global_config_path() -> anyhow::Result<PathBuf> {
    let dir = if let Ok(x) = std::env::var("XDG_CONFIG_HOME") {
        PathBuf::from(x)
    } else {
        let home = std::env::var("HOME")
            .map_err(|_| anyhow::anyhow!("HOME not set; set XDG_CONFIG_HOME"))?;
        PathBuf::from(home).join(".config")
    };
    Ok(dir.join("wabi-sync").join("config.json"))
}

/// Global credentials (`wabi-sync login`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalConfig {
    pub server_url: String,
    /// A connect token (`wblore_…`) or a full user JWT.
    pub token: String,
}

impl GlobalConfig {
    pub fn load() -> anyhow::Result<Self> {
        let path = global_config_path()?;
        let raw = std::fs::read_to_string(&path)
            .map_err(|_| anyhow::anyhow!("not logged in — run `wabi-sync login <serverUrl>` (config at {})", path.display()))?;
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn save(&self) -> anyhow::Result<()> {
        let path = global_config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, serde_json::to_string_pretty(self)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }
}

/// The per-folder link file (`.wabi-sync.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LinkConfig {
    pub server_url: String,
    /// Numeric channel id (canonical form; hex `ch_…` ids are normalized on link).
    pub channel_id: i64,
}

impl LinkConfig {
    pub fn load(folder: &Path) -> anyhow::Result<Self> {
        let path = folder.join(LINK_FILE);
        let raw = std::fs::read_to_string(&path).map_err(|_| {
            anyhow::anyhow!(
                "folder is not linked — run `wabi-sync link <channel> <folder>` (expected {})",
                path.display()
            )
        })?;
        Ok(serde_json::from_str(&raw)?)
    }

    pub fn save(&self, folder: &Path) -> anyhow::Result<()> {
        std::fs::write(folder.join(LINK_FILE), serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    /// Accept `ch_<hex>`, `0x<hex>`, or decimal; normalize to the decimal id.
    pub fn normalize_channel_id(input: &str) -> anyhow::Result<i64> {
        let input = input.trim();
        if let Some(hex) = input.strip_prefix("ch_") {
            return i64::from_str_radix(hex, 16)
                .map_err(|_| anyhow::anyhow!("invalid channel id '{input}'"));
        }
        if let Some(hex) = input.strip_prefix("0x") {
            return i64::from_str_radix(hex, 16)
                .map_err(|_| anyhow::anyhow!("invalid channel id '{input}'"));
        }
        input
            .parse::<i64>()
            .map_err(|_| anyhow::anyhow!("invalid channel id '{input}'"))
    }
}

/// Mutable sync state: the last-synced etag per path (the three-way baseline)
/// plus the change-feed cursor. None = the file did not exist remotely at
/// last sync.
///
/// The file is plain JSON with no version field; unknown keys are ignored on
/// load. `pending_review` is therefore optional on read (state files written
/// before it existed) and left out when empty (so a state file with nothing
/// pending is byte-identical to what older builds write).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncState {
    pub cursor: u64,
    pub baselines: BTreeMap<String, Option<String>>,
    /// Paths whose last upload the server routed to a review branch, with the
    /// etag that was uploaded. The mainline does not have those bytes until
    /// someone approves, so `baselines` keeps the mainline etag (or no entry
    /// for a new file) and this map records what is waiting.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub pending_review: BTreeMap<String, String>,
    /// The local etag a file had when its path was last synced, recorded only
    /// where it differs from the server's etag for the same bytes. That is
    /// the case for files over the full-hash limit: their etag includes the
    /// file's mtime, and the server computes it over its own copy. "Did the
    /// user change this file" is judged against this value, not against the
    /// server's etag. It describes the upload waiting for review when the
    /// path is in `pending_review`, and the baseline otherwise.
    ///
    /// No entry means the local etag equalled the server's, or the state file
    /// comes from a build without this map; both are answered by comparing
    /// with the server's etag. A build without this map ignores the key and
    /// drops the whole map when it saves, so it never leaves a stale entry.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub local_fingerprints: BTreeMap<String, String>,
}

impl SyncState {
    /// Is the local file (with etag `local_etag`) the one last synced with
    /// the mainline baseline of `path`?
    pub fn local_matches_baseline(&self, path: &str, local_etag: &str) -> bool {
        let Some(baseline) = self.baselines.get(path).and_then(|b| b.as_deref()) else {
            return false;
        };
        if !self.pending_review.contains_key(path) {
            if let Some(fingerprint) = self.local_fingerprints.get(path) {
                return fingerprint == local_etag;
            }
        }
        baseline == local_etag
    }

    /// Is the local file the one whose upload is waiting for review?
    pub fn local_matches_pending(&self, path: &str, local_etag: &str) -> bool {
        match (self.pending_review.get(path), self.local_fingerprints.get(path)) {
            (None, _) => false,
            (Some(_), Some(fingerprint)) => fingerprint == local_etag,
            (Some(pending), None) => pending == local_etag,
        }
    }

    /// Record the local etag of the file just synced as `server_etag`.
    pub fn record_local(&mut self, path: &str, local_etag: &str, server_etag: &str) {
        if local_etag == server_etag {
            self.local_fingerprints.remove(path);
        } else {
            self.local_fingerprints.insert(path.to_string(), local_etag.to_string());
        }
    }

    fn path_for(folder: &Path) -> PathBuf {
        folder.join(STATE_DIR).join("state.json")
    }

    pub fn load(folder: &Path) -> anyhow::Result<Self> {
        match std::fs::read_to_string(Self::path_for(folder)) {
            Ok(raw) => Ok(serde_json::from_str(&raw)?),
            Err(_) => Ok(Self::default()),
        }
    }

    pub fn save(&self, folder: &Path) -> anyhow::Result<()> {
        let path = Self::path_for(folder);
        std::fs::create_dir_all(path.parent().unwrap_or(folder))?;
        // Written beside the state file and renamed over it: a crash leaves
        // the old state or the new one, never half a file (which would load
        // as "nothing was ever synced").
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(&temporary, &path)?;
        Ok(())
    }
}

/// The state file as builds before `local_fingerprints` read and wrote it.
#[cfg(test)]
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct StateBeforeFingerprints {
    pub cursor: u64,
    pub baselines: BTreeMap<String, Option<String>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub pending_review: BTreeMap<String, String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_id_normalization() {
        assert_eq!(LinkConfig::normalize_channel_id("ch_e1").unwrap(), 225);
        assert_eq!(LinkConfig::normalize_channel_id("0xe1").unwrap(), 225);
        assert_eq!(LinkConfig::normalize_channel_id("225").unwrap(), 225);
        assert!(LinkConfig::normalize_channel_id("ch_zzz").is_err());
        assert!(LinkConfig::normalize_channel_id("nope").is_err());
    }

    #[test]
    fn state_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = SyncState::default();
        state.cursor = 42;
        state.baselines.insert("a.txt".into(), Some("etag-a".into()));
        state.baselines.insert("b.txt".into(), None);
        state.save(dir.path()).unwrap();
        let loaded = SyncState::load(dir.path()).unwrap();
        assert_eq!(loaded.cursor, 42);
        assert_eq!(loaded.baselines.get("a.txt"), Some(&Some("etag-a".into())));
        assert_eq!(loaded.baselines.get("b.txt"), Some(&None));
    }

    #[test]
    fn state_file_without_pending_review_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(STATE_DIR)).unwrap();
        std::fs::write(
            dir.path().join(STATE_DIR).join("state.json"),
            r#"{"cursor": 7, "baselines": {"a.txt": "etag-a"}}"#,
        )
        .unwrap();
        let loaded = SyncState::load(dir.path()).unwrap();
        assert_eq!(loaded.cursor, 7);
        assert!(loaded.pending_review.is_empty());

        // Nothing pending → the key is not written at all.
        loaded.save(dir.path()).unwrap();
        let raw = std::fs::read_to_string(dir.path().join(STATE_DIR).join("state.json")).unwrap();
        assert!(!raw.contains("pending_review"));
    }

    #[test]
    fn pending_review_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = SyncState::default();
        state.pending_review.insert("a.txt".into(), "etag-new".into());
        state.save(dir.path()).unwrap();
        let loaded = SyncState::load(dir.path()).unwrap();
        assert_eq!(loaded.pending_review.get("a.txt").map(String::as_str), Some("etag-new"));
    }

    fn state_json(dir: &Path) -> String {
        std::fs::read_to_string(dir.join(STATE_DIR).join("state.json")).unwrap()
    }

    /// Older build → this build: no `local_fingerprints` key. Every path is
    /// then judged against the server's etag, as before.
    #[test]
    fn state_file_without_fingerprints_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(STATE_DIR)).unwrap();
        std::fs::write(
            dir.path().join(STATE_DIR).join("state.json"),
            r#"{"cursor": 7, "baselines": {"a.txt": "etag-a"}, "pending_review": {"b.txt": "etag-b"}}"#,
        )
        .unwrap();
        let loaded = SyncState::load(dir.path()).unwrap();
        assert!(loaded.local_fingerprints.is_empty());
        assert!(loaded.local_matches_baseline("a.txt", "etag-a"));
        assert!(!loaded.local_matches_baseline("a.txt", "other"));
        assert!(loaded.local_matches_pending("b.txt", "etag-b"));
        assert!(!loaded.local_matches_pending("b.txt", "other"));

        // Nothing recorded → the key is not written, so the file keeps the
        // shape older builds write.
        loaded.save(dir.path()).unwrap();
        assert!(!state_json(dir.path()).contains("local_fingerprints"));
    }

    /// This build → older build: the older build ignores the new key, keeps
    /// everything it knows, and drops the whole map when it saves. After that
    /// this build is back to comparing with the server's etag.
    #[test]
    fn older_build_reads_a_state_file_with_fingerprints() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = SyncState::default();
        state.cursor = 3;
        state.baselines.insert("big.bin".into(), Some("q-server".into()));
        state.baselines.insert("gone.txt".into(), None);
        state.pending_review.insert("new.bin".into(), "q-review".into());
        state.record_local("big.bin", "q-local", "q-server");
        state.record_local("new.bin", "q-local-new", "q-review");
        state.save(dir.path()).unwrap();
        assert!(state_json(dir.path()).contains("local_fingerprints"));

        let old: StateBeforeFingerprints = serde_json::from_str(&state_json(dir.path())).unwrap();
        assert_eq!(old.cursor, 3);
        assert_eq!(old.baselines, state.baselines);
        assert_eq!(old.pending_review, state.pending_review);

        std::fs::write(
            dir.path().join(STATE_DIR).join("state.json"),
            serde_json::to_string_pretty(&old).unwrap(),
        )
        .unwrap();
        let back = SyncState::load(dir.path()).unwrap();
        assert!(back.local_fingerprints.is_empty());
        assert_eq!(back.baselines, state.baselines);
        assert_eq!(back.pending_review, state.pending_review);
    }

    #[test]
    fn fingerprint_decides_when_present() {
        let mut state = SyncState::default();
        state.baselines.insert("big.bin".into(), Some("q-server".into()));
        state.record_local("big.bin", "q-local", "q-server");
        assert!(state.local_matches_baseline("big.bin", "q-local"));
        assert!(!state.local_matches_baseline("big.bin", "q-local-edited"));
        assert!(!state.local_matches_pending("big.bin", "q-local"));

        // While an upload waits for review the fingerprint describes that
        // upload, not the baseline.
        state.pending_review.insert("big.bin".into(), "q-review".into());
        state.record_local("big.bin", "q-local-edit", "q-review");
        assert!(state.local_matches_pending("big.bin", "q-local-edit"));
        assert!(!state.local_matches_baseline("big.bin", "q-local-edit"));

        // Equal etags need no entry; a fingerprint without a baseline is not
        // taken for "unchanged".
        state.record_local("small.txt", "same", "same");
        assert!(!state.local_fingerprints.contains_key("small.txt"));
        state.record_local("stray.bin", "q-x", "q-y");
        assert!(!state.local_matches_baseline("stray.bin", "q-x"));
    }
}
