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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

    /// What `wabi-sync link` does to a folder: it writes the link file,
    /// and decides what becomes of the folder's sync state. `owner` is what
    /// the next round will sync with (the server the client talks to, and
    /// this channel).
    ///
    /// - A state recorded for `owner`, or one with no owner recorded found
    ///   with this very link, stays and is used.
    /// - Any other state is moved aside to `.wabi-sync/state.json.previous-link`
    ///   (then `.2`, `.3`, …; none is ever written over), and the next round
    ///   starts as a fresh link: with no baseline nothing is deleted on
    ///   either side, and a file that differs is kept as a conflict copy.
    /// - With `keep_state` it stays instead and is recorded for `owner`: the
    ///   user's word that this is the same repository under another address.
    ///
    /// A link that changes nothing is not written again. While another
    /// wabi-sync process works the folder, `link` waits for nothing and fails.
    pub fn link(&self, folder: &Path, owner: &StateOwner, keep_state: bool) -> anyhow::Result<Linked> {
        let previous = Self::load(folder).ok();
        let _lock = if folder.join(STATE_DIR).exists() { Some(FolderLock::acquire(folder)?) } else { None };
        let same_link = previous.as_ref().is_some_and(|p| {
            p.channel_id == self.channel_id && normalize_server_url(&p.server_url) == normalize_server_url(&self.server_url)
        });
        let state_path = SyncState::path_for(folder);
        let mut outcome = None;
        if state_path.exists() {
            let state = SyncState::load(folder).ok();
            let recorded = match state.as_ref().and_then(|s| s.owner.clone()) {
                Some(recorded) => Some(recorded),
                // An older build's state belongs to the link it is found with.
                None if state.is_some() => previous.as_ref().map(|p| StateOwner::new(&p.server_url, p.channel_id)),
                None => None,
            };
            let belongs = match &recorded {
                Some(recorded) => recorded.same(owner),
                None => state.is_some() && same_link,
            };
            match (belongs, keep_state, state) {
                (true, _, _) => {}
                (false, true, Some(mut state)) => {
                    state.owner = Some(owner.clone());
                    state.save(folder)?;
                    outcome = Some(Linked::KeptState { previous: recorded.unwrap_or_else(|| owner.clone()) });
                }
                // Another link's, or not readable: out of the way, whole.
                (false, _, _) => {
                    let moved = move_aside(&state_path)?;
                    outcome = Some(Linked::Replaced { previous: previous.clone(), state_moved_to: Some(moved) });
                }
            }
        }
        if previous.as_ref() != Some(self) {
            self.save(folder)?;
        }
        Ok(match outcome {
            Some(outcome) => outcome,
            None if previous.as_ref() == Some(self) => Linked::Unchanged,
            None if previous.is_some() && state_path.exists() => {
                Linked::Replaced { previous, state_moved_to: None }
            }
            None => Linked::New,
        })
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

/// Move the state file at `path` to the first free name of
/// `state.json.previous-link`, `state.json.previous-link.2`, …
fn move_aside(path: &Path) -> anyhow::Result<PathBuf> {
    for n in 1u32.. {
        let name = if n == 1 { "state.json.previous-link".to_string() } else { format!("state.json.previous-link.{n}") };
        let target = path.with_file_name(name);
        if target.symlink_metadata().is_err() {
            std::fs::rename(path, &target)
                .map_err(|e| anyhow::anyhow!("cannot move {} aside to {}: {e}", path.display(), target.display()))?;
            return Ok(target);
        }
    }
    unreachable!("u32 names run out")
}

/// What `LinkConfig::link` found and did.
#[derive(Debug, PartialEq, Eq)]
pub enum Linked {
    /// The folder had no link, or had one and no sync state.
    New,
    /// The folder was already linked to this server and channel.
    Unchanged,
    /// The link changed. When the folder had state for another link, it was
    /// moved to `state_moved_to` and the next round starts as a fresh link.
    Replaced { previous: Option<LinkConfig>, state_moved_to: Option<PathBuf> },
    /// The state was recorded for another address of the same repository
    /// and now belongs to this link (`--keep-state`).
    KeptState { previous: StateOwner },
}

/// The server and channel a state file describes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StateOwner {
    /// The server the client talks to, without a trailing slash.
    pub server_url: String,
    pub channel_id: i64,
}

/// A server address in the one spelling used to compare owners: scheme and
/// host in lower case, no default port, no trailing slash. Two spellings of
/// one address are one owner; two addresses of one machine (`127.0.0.1` and
/// `localhost`) are not, and only the user can say they are the same.
pub fn normalize_server_url(url: &str) -> String {
    let url = url.trim();
    match reqwest::Url::parse(url) {
        Ok(parsed) if parsed.host_str().is_some() => {
            // `Url` already lower-cases the scheme and host and drops a
            // port that is the scheme's default.
            let mut out = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or_default());
            if let Some(port) = parsed.port() {
                out.push_str(&format!(":{port}"));
            }
            out.push_str(parsed.path().trim_end_matches('/'));
            out
        }
        _ => url.trim_end_matches('/').to_string(),
    }
}

impl StateOwner {
    pub fn new(server_url: &str, channel_id: i64) -> Self {
        Self { server_url: normalize_server_url(server_url), channel_id }
    }

    /// The same server and channel, however the address is spelled.
    pub fn same(&self, other: &StateOwner) -> bool {
        self.channel_id == other.channel_id
            && normalize_server_url(&self.server_url) == normalize_server_url(&other.server_url)
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
    /// The server and channel the baselines below were synced with. Read
    /// against any other repo they say "every file was deleted on the
    /// server", so a state with another owner is not used (`for_owner`).
    /// Missing in state files written before this field existed; such a
    /// file belongs to the link it is found with, and gets its owner on the
    /// next save. A build without this field drops it again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<StateOwner>,
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
    /// Report lines for conflicts that are settled in the folder (the file
    /// holds the server's version, the user's is in a conflict copy) and
    /// that no report has carried to the user yet, because the round failed
    /// or was killed after settling them. Emptied when a report takes them.
    /// Optional on read and left out when empty, like the two maps above; a
    /// build without this field drops it, and with it only the notice.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unreported_conflicts: Vec<String>,
    /// Files the server refused to store, by path. A refused file is not
    /// sent again until it changes (its whole body would go up each round
    /// to get the same answer); the report says each round that it is still
    /// refused and why. `wabi-sync resubmit <path>` forgets the entry.
    /// Optional on read and left out when empty; a build without this field
    /// drops it and goes back to sending refused files every round.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub refused_uploads: BTreeMap<String, RefusedUpload>,
}

/// One refused upload: which version of the file, and the server's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefusedUpload {
    /// The local etag the file had when it was refused.
    pub etag: String,
    pub status: u16,
    /// The refusal as the report words it.
    pub said: String,
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

    /// Stop treating `path` as waiting for review. The client cannot see a
    /// rejection, so after one the user says so with `wabi-sync resubmit`.
    /// The file then differs from its baseline with nothing recorded as
    /// sent, and the next push uploads it again. Returns false when the path
    /// was not waiting.
    pub fn forget_review(&mut self, path: &str) -> bool {
        if self.pending_review.remove(path).is_none() {
            return false;
        }
        // While a path waits for review its fingerprint describes the bytes
        // that were sent, not the baseline.
        self.local_fingerprints.remove(path);
        true
    }

    /// Record the local etag of the file just synced as `server_etag`.
    pub fn record_local(&mut self, path: &str, local_etag: &str, server_etag: &str) {
        if local_etag == server_etag {
            self.local_fingerprints.remove(path);
        } else {
            self.local_fingerprints.insert(path.to_string(), local_etag.to_string());
        }
    }

    pub fn path_for(folder: &Path) -> PathBuf {
        folder.join(STATE_DIR).join("state.json")
    }

    /// The state of `folder` for a round with `owner`.
    ///
    /// A state recorded for another owner is never used and never replaced
    /// here: the round would read its baselines against another repo (every
    /// file deleted there) or, if it started afresh, put back what others
    /// deleted and undo the user's own deletions. It is an error that names
    /// both owners and the `wabi-sync link` that settles it.
    ///
    /// A state with no owner recorded comes from a build before owners
    /// existed, and is this link's: only `link` changes a folder's link,
    /// and it moves another link's state aside. (A build that old has a
    /// `link` that rewrites the link file and leaves the state as it is;
    /// see the mass-deletion guard for what stops that state emptying the
    /// folder.) Its owner is recorded on the next save.
    pub fn for_owner(folder: &Path, owner: StateOwner) -> anyhow::Result<Self> {
        let mut state = Self::load(folder)?;
        if let Some(recorded) = &state.owner {
            if !recorded.same(&owner) {
                anyhow::bail!(
                    "the sync state in this folder ({}) was recorded for {} channel {}, and this folder now syncs \
                     with {} channel {}. Nothing has been changed. If that is the same server under another \
                     address, run `wabi-sync link {} {} --keep-state` to go on with this state. If it is another \
                     server or repository, run `wabi-sync link {} {}`: the state is moved aside to \
                     .wabi-sync/state.json.previous-link and the folder starts as newly linked (nothing is \
                     deleted on either side; a file that differs is kept as a conflict copy)",
                    Self::path_for(folder).display(),
                    recorded.server_url,
                    recorded.channel_id,
                    owner.server_url,
                    owner.channel_id,
                    owner.channel_id,
                    folder.display(),
                    owner.channel_id,
                    folder.display(),
                );
            }
        }
        state.owner = Some(owner);
        Ok(state)
    }

    /// The state of `folder`, or an empty one when the folder has never been
    /// synced. A state file that is there and cannot be read is an error and
    /// never "nothing was synced": without its baselines an old local file
    /// counts as new work and a file someone else deleted is put back.
    pub fn load(folder: &Path) -> anyhow::Result<Self> {
        let path = Self::path_for(folder);
        let unusable = |why: String| {
            anyhow::anyhow!(
                "{} cannot be read as wabi-sync's state ({why}). wabi-sync will not run without what it \
                 recorded there. To start this folder as a fresh link instead, move it aside (rename it, \
                 for example to state.json.unreadable) and run again: files that differ from the server's \
                 are then kept as conflict copies, and files deleted on the server since the last sync \
                 are uploaded again",
                path.display()
            )
        };
        let raw = match std::fs::read(&path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(e) => return Err(unusable(e.to_string())),
        };
        serde_json::from_slice(&raw).map_err(|e| unusable(e.to_string()))
    }

    pub fn save(&self, folder: &Path) -> anyhow::Result<()> {
        let path = Self::path_for(folder);
        std::fs::create_dir_all(path.parent().unwrap_or(folder))?;
        // Written beside the state file and renamed over it: a crash leaves
        // the old state or the new one, never half a file. The temporary
        // name is this writer's own (process id and a counter), so two
        // writers never rename each other's half-written file.
        let temporary = temporary_path(&path);
        let written = std::fs::write(&temporary, serde_json::to_string_pretty(self)?)
            .and_then(|()| std::fs::rename(&temporary, &path));
        if written.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        Ok(written?)
    }
}

/// Where a save of `path` writes before it renames: a name of this writer's
/// own (process id and a counter), so that two writers never rename each
/// other's half-written file.
fn temporary_path(path: &Path) -> PathBuf {
    static SAVES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        SAVES.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
}

/// Name of the lock file inside the state directory.
pub const LOCK_FILE: &str = "lock";

/// One wabi-sync process at a time works a folder: `watch`, `sync`, `push`,
/// `pull` and `resubmit` each hold this for as long as they read and write
/// the folder's state.
///
/// It is an advisory lock from the operating system on
/// `.wabi-sync/lock`, the pattern WabiDB uses for its data directory. The
/// system releases it when the process ends, however it ends, so a killed
/// process leaves nothing to clear. The file is never removed, by this
/// program or (please) by hand: its presence means nothing, and removing it
/// while a process holds it would let a second one in. The process id
/// written in it is there for the error message only.
#[derive(Debug)]
pub struct FolderLock {
    file: std::fs::File,
}

impl Drop for FolderLock {
    fn drop(&mut self) {
        // Said out loud, not left to the file being closed: a child process
        // forked while the lock was held shares the open file until it
        // starts its own program, and the lock would last as long.
        let _ = self.file.unlock();
    }
}

impl FolderLock {
    pub fn acquire(folder: &Path) -> anyhow::Result<Self> {
        use std::io::Write;
        let path = folder.join(STATE_DIR).join(LOCK_FILE);
        std::fs::create_dir_all(folder.join(STATE_DIR))?;
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| anyhow::anyhow!("cannot open the lock file {}: {e}", path.display()))?;
        match file.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                let holder = std::fs::read_to_string(&path).unwrap_or_default();
                let holder = match holder.trim() {
                    "" => String::new(),
                    pid => format!(" (process {pid})"),
                };
                anyhow::bail!(
                    "another wabi-sync{holder} is working on this folder and holds {}. Wait for it to finish, \
                     or stop it (`wabi-sync watch` runs until stopped), and run again. There is nothing to \
                     clear by hand: the lock ends with the process that holds it, and deleting the file \
                     does not release it",
                    path.display()
                );
            }
            // A file system with no locks (some network mounts): go on
            // without one, as every build before this did.
            Err(std::fs::TryLockError::Error(_)) => return Ok(Self { file }),
        }
        let _ = file.set_len(0);
        let _ = writeln!(file, "{}", std::process::id());
        Ok(Self { file })
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

    fn owner(url: &str, channel_id: i64) -> StateOwner {
        StateOwner::new(url, channel_id)
    }

    fn saved_state(dir: &Path, owner: Option<StateOwner>) -> String {
        let mut state = SyncState::default();
        state.owner = owner;
        state.baselines.insert("a.txt".into(), Some("etag".into()));
        state.save(dir).unwrap();
        state_json(dir)
    }

    /// H2. One server, spelled as a person may type it: the same owner.
    #[test]
    fn server_urls_are_compared_as_addresses() {
        for (a, b) in [
            ("http://example.com", "HTTP://Example.COM/"),
            ("http://example.com", "http://example.com:80"),
            ("https://example.com/wabi", "https://EXAMPLE.com:443/wabi/"),
            ("http://127.0.0.1:3001", "http://127.0.0.1:3001///"),
        ] {
            assert_eq!(normalize_server_url(a), normalize_server_url(b), "{a} / {b}");
            assert_eq!(owner(a, 1), owner(b, 1));
        }
        for (a, b) in [
            ("http://127.0.0.1:3001", "http://localhost:3001"),
            ("http://example.com", "https://example.com"),
            ("http://example.com:8080", "http://example.com"),
            ("http://example.com/a", "http://example.com/b"),
        ] {
            assert_ne!(normalize_server_url(a), normalize_server_url(b), "{a} / {b}");
        }
        assert_ne!(owner("http://example.com", 1), owner("http://example.com", 2));
    }

    /// H2. A state recorded for another owner is never replaced by a round:
    /// the round refuses and says how to go on, and the file is untouched.
    #[test]
    fn a_state_of_another_owner_is_refused_not_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let saved = saved_state(dir.path(), Some(owner("http://127.0.0.1:3001", 7)));
        assert_eq!(SyncState::for_owner(dir.path(), owner("HTTP://127.0.0.1:3001/", 7)).unwrap().baselines.len(), 1);
        for other in [owner("http://localhost:3001", 7), owner("http://127.0.0.1:3001", 8)] {
            let error = format!("{:#}", SyncState::for_owner(dir.path(), other.clone()).expect_err("used another owner's state"));
            assert!(error.contains("http://127.0.0.1:3001 channel 7"), "{error}");
            assert!(error.contains(&format!("{} channel {}", other.server_url, other.channel_id)), "{error}");
            assert!(error.contains("wabi-sync link") && error.contains("--keep-state"), "{error}");
            assert_eq!(state_json(dir.path()), saved);
        }
    }

    /// H3, and H2 the other way: a state with no owner (an older build's) is
    /// this link's, whatever the files' times say. Only `link` changes the
    /// link without moving the state aside, and it does not leave one
    /// without an owner.
    #[test]
    fn a_state_with_no_owner_is_adopted() {
        let dir = tempfile::tempdir().unwrap();
        LinkConfig { server_url: "http://one".into(), channel_id: 1 }.save(dir.path()).unwrap();
        let mut state = SyncState::default();
        state.baselines.insert("a.txt".into(), Some("etag".into()));
        state.save(dir.path()).unwrap();
        assert!(!state_json(dir.path()).contains("owner"));
        let at = |path: PathBuf, seconds| {
            let when = std::time::SystemTime::now() + std::time::Duration::from_secs(seconds);
            std::fs::File::options().write(true).open(path).unwrap().set_modified(when).unwrap()
        };
        for (link_at, state_at) in [(20, 10), (10, 10), (10, 20)] {
            at(dir.path().join(LINK_FILE), link_at);
            at(SyncState::path_for(dir.path()), state_at);
            let adopted = SyncState::for_owner(dir.path(), owner("http://one", 1)).unwrap();
            assert_eq!(adopted.baselines.len(), 1, "link at {link_at}, state at {state_at}");
            assert_eq!(adopted.owner, Some(owner("http://one", 1)));
        }
    }

    /// H2, H3. `link` decides what happens to the state, from its owner.
    #[test]
    fn link_moves_another_links_state_aside() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path();
        let link = |url: &str, channel_id| LinkConfig { server_url: url.into(), channel_id };
        let aside = |name: &str| folder.join(STATE_DIR).join(name);
        assert_eq!(link("http://one", 1).link(folder, &owner("http://one", 1), false).unwrap(), Linked::New);
        let first = saved_state(folder, Some(owner("http://one", 1)));

        // The same link, however it is spelled: nothing is written.
        let written = std::fs::metadata(folder.join(LINK_FILE)).unwrap().modified().unwrap();
        assert_eq!(link("http://one", 1).link(folder, &owner("HTTP://ONE/", 1), false).unwrap(), Linked::Unchanged);
        assert_eq!(std::fs::metadata(folder.join(LINK_FILE)).unwrap().modified().unwrap(), written);
        assert_eq!(state_json(folder), first);

        // Another channel: the state goes to state.json.previous-link.
        let linked = link("http://one", 2).link(folder, &owner("http://one", 2), false).unwrap();
        assert_eq!(
            linked,
            Linked::Replaced { previous: Some(link("http://one", 1)), state_moved_to: Some(aside("state.json.previous-link")) }
        );
        assert!(!SyncState::path_for(folder).exists());
        assert_eq!(std::fs::read_to_string(aside("state.json.previous-link")).unwrap(), first);
        assert_eq!(LinkConfig::load(folder).unwrap(), link("http://one", 2));

        // And again: an earlier one is never written over.
        let second = saved_state(folder, Some(owner("http://one", 2)));
        let linked = link("http://one", 1).link(folder, &owner("http://one", 1), false).unwrap();
        assert!(matches!(linked, Linked::Replaced { state_moved_to: Some(ref to), .. } if *to == aside("state.json.previous-link.2")));
        assert_eq!(std::fs::read_to_string(aside("state.json.previous-link")).unwrap(), first);
        assert_eq!(std::fs::read_to_string(aside("state.json.previous-link.2")).unwrap(), second);

        // The link file did not change but the login did (H2): `link` with
        // the new address moves the state aside, unless told to keep it.
        saved_state(folder, Some(owner("http://one", 1)));
        let kept = link("http://one", 1).link(folder, &owner("http://localhost", 1), true).unwrap();
        assert_eq!(kept, Linked::KeptState { previous: owner("http://one", 1) });
        let state = SyncState::for_owner(folder, owner("http://localhost", 1)).unwrap();
        assert_eq!(state.baselines.len(), 1);
        saved_state(folder, Some(owner("http://one", 1)));
        let moved = link("http://one", 1).link(folder, &owner("http://localhost", 1), false).unwrap();
        assert!(matches!(moved, Linked::Replaced { state_moved_to: Some(_), .. }), "{moved:?}");
        assert!(!SyncState::path_for(folder).exists());

        // A state with no owner belongs to the link file it was found with.
        saved_state(folder, None);
        assert_eq!(link("http://one", 1).link(folder, &owner("http://one", 1), false).unwrap(), Linked::Unchanged);
        assert!(SyncState::path_for(folder).exists());
        let moved = link("http://one", 3).link(folder, &owner("http://one", 3), false).unwrap();
        assert!(matches!(moved, Linked::Replaced { state_moved_to: Some(_), .. }), "{moved:?}");
        assert!(!SyncState::path_for(folder).exists());
    }

    /// Item 6. The temporary name is the writer's own.
    #[test]
    fn temporary_names_are_unique() {
        let path = Path::new("/folder/.wabi-sync/state.json");
        let (a, b) = (temporary_path(path), temporary_path(path));
        assert_ne!(a, b);
        for name in [&a, &b] {
            let name = name.file_name().unwrap().to_str().unwrap();
            assert!(name.starts_with(&format!("state.json.tmp.{}.", std::process::id())), "{name}");
        }
    }

    /// The child of `the_lock_holds_across_processes`: holds the lock of the
    /// folder it is given until it is killed.
    #[test]
    #[ignore = "run by the_lock_holds_across_processes"]
    fn lock_holder_child() {
        let Some(folder) = std::env::var_os("WABI_SYNC_TEST_LOCK_FOLDER") else { return };
        let _lock = FolderLock::acquire(Path::new(&folder)).unwrap();
        println!("LOCKED");
        use std::io::Write;
        std::io::stdout().flush().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(60));
    }

    /// Item 6. Another process holds the folder: refused, naming it. Killed,
    /// it leaves nothing to clear.
    #[test]
    fn the_lock_holds_across_processes() {
        use std::io::BufRead;
        let dir = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "config::tests::lock_holder_child", "--ignored", "--nocapture", "--test-threads=1"])
            .env("WABI_SYNC_TEST_LOCK_FOLDER", dir.path())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut lines = std::io::BufReader::new(child.stdout.take().unwrap()).lines();
        assert!(lines.any(|line| line.unwrap().contains("LOCKED")), "the child did not take the lock");
        let error = format!("{:#}", FolderLock::acquire(dir.path()).expect_err("two processes hold one folder"));
        assert!(error.contains(&format!("process {}", child.id())), "{error}");
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(dir.path().join(STATE_DIR).join(LOCK_FILE).exists());
        FolderLock::acquire(dir.path()).expect("a killed process still holds the folder");
    }

    /// B2. A state file that cannot be read is an error that names the file
    /// and says how to go on without it; it is not "nothing was synced".
    #[test]
    fn unreadable_state_file_is_an_error_that_names_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(STATE_DIR).join("state.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        for half in [&br#"{"cursor": 7, "baselines": {"a.txt": "et"#[..], b"", b"\xff\xfe"] {
            std::fs::write(&path, half).unwrap();
            let error = format!("{:#}", SyncState::load(dir.path()).expect_err("loaded half a file"));
            assert!(error.contains(&path.display().to_string()), "{error}");
            assert!(error.contains("move it aside"), "{error}");
        }
        // No file at all is a folder that was never synced.
        std::fs::remove_file(&path).unwrap();
        assert!(SyncState::load(dir.path()).unwrap().baselines.is_empty());
    }

    /// B2. Two writers (`watch` and a manual `sync`) saving at once: every
    /// save succeeds and the file is whole after each of them.
    #[test]
    fn concurrent_saves_leave_a_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = SyncState::default();
        for n in 0..2000 {
            state.baselines.insert(format!("some/long/path/to/file-{n}.txt"), Some("e".repeat(64)));
        }
        state.save(dir.path()).unwrap();
        let writers: Vec<_> = (0..2)
            .map(|_| {
                let (state, folder) = (state.clone(), dir.path().to_path_buf());
                std::thread::spawn(move || -> Result<(), String> {
                    for _ in 0..150 {
                        state.save(&folder).map_err(|e| format!("save: {e}"))?;
                        let loaded = SyncState::load(&folder).map_err(|e| format!("load: {e}"))?;
                        if loaded.baselines.len() != 2000 {
                            return Err(format!("{} baselines", loaded.baselines.len()));
                        }
                    }
                    Ok(())
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap().unwrap();
        }
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
