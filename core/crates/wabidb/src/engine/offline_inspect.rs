//! Bounded offline verification of a complete frozen engine history.
//! No sequencer, dispatcher task, replication, manifest update or snapshot write
//! is started. The only filesystem mutation is creating a missing persistent
//! advisory lock; its existing contents and inode are preserved.
use super::locks::{ProjectionContentFingerprint, ProjectionState};
use crate::crypto::stream_key_registry::StreamKeyRegistry;
use crate::error::{Result, WabiError};
use crate::projections::barrier::LinearizabilityBarrier;
use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct InspectionLimits {
    pub max_entries: u64,
    pub max_file_bytes: u64,
    pub max_snapshot_bytes: u64,
    pub timeout: Duration,
}
impl Default for InspectionLimits {
    fn default() -> Self {
        Self {
            max_entries: 10_000,
            max_file_bytes: 64 * 1024 * 1024,
            max_snapshot_bytes: 4 * 1024 * 1024,
            timeout: Duration::from_secs(60),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionReceipt {
    pub applied_commit_seq: u64,
    pub commit_prefix_fingerprint: String,
    pub projection: ProjectionContentFingerprint,
    pub indexed_commits: u64,
    pub observed_high_sequence: u64,
    pub full_history_replayed: bool,
    pub persisted_projection_matches: bool,
}

/// Rebuilt view for typed read assertions. It has no durable mutation handle.
pub struct OfflineInspection {
    state: Arc<ProjectionState>,
    pub receipt: InspectionReceipt,
}
impl OfflineInspection {
    pub fn projection_state(&self) -> &ProjectionState {
        &self.state
    }
}

fn refused(reason: &str) -> WabiError {
    WabiError::Validation {
        command: "offline_frozen_inspection".into(),
        reason: reason.into(),
    }
}

fn check_time(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        return Err(refused("inspection deadline elapsed"));
    }
    Ok(())
}

#[derive(PartialEq, Eq)]
enum InventoryEntry {
    Directory,
    File { size: u64, digest: [u8; 32] },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedView {
    watermark: u64,
    indexes: Vec<(String, Vec<SavedEntry>)>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedEntry {
    key: String,
    value: String,
}

fn read_saved_view(root: &Path, limits: &InspectionLimits) -> Result<ProjectionState> {
    let path = root.join("projections/snapshot.json");
    let mut bytes = Vec::new();
    File::open(path)?
        .take(limits.max_snapshot_bytes + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limits.max_snapshot_bytes {
        return Err(refused("inspection snapshot budget exceeded"));
    }
    let saved: SavedView = serde_json::from_slice(&bytes)
        .map_err(|_| refused("invalid inspection projection schema"))?;
    let mut names = std::collections::HashSet::new();
    let state = ProjectionState::new();
    let mut entries = 0u64;
    let mut record_bytes = 0u64;
    for (name, rows) in saved.indexes {
        if name.is_empty() || !names.insert(name.clone()) {
            return Err(refused("duplicate or invalid inspection index"));
        }
        let mut keys = std::collections::HashSet::new();
        for row in rows {
            let key =
                hex::decode(row.key).map_err(|_| refused("invalid inspection projection key"))?;
            let value = hex::decode(row.value)
                .map_err(|_| refused("invalid inspection projection value"))?;
            entries += 1;
            record_bytes += (key.len() + value.len()) as u64;
            if entries > limits.max_entries || record_bytes > limits.max_file_bytes {
                return Err(refused("inspection decoded projection budget exceeded"));
            }
            if !keys.insert(key.clone()) {
                return Err(refused("duplicate inspection projection key"));
            }
            state.insert(&name, key, value, saved.watermark);
        }
    }
    state.set_applied_commit_seq(saved.watermark);
    Ok(state)
}

// Reject symlinks/special files before replay's ordinary readers can traverse
// them. Private stopped roots are still required; unrelated writers must obey
// that contract. Two complete inventories detect changes during inspection.
fn inventory(
    root: &Path,
    limits: &InspectionLimits,
    deadline: Instant,
) -> Result<BTreeMap<PathBuf, InventoryEntry>> {
    let mut entries = BTreeMap::new();
    let mut bytes = 0u64;
    let mut path_bytes = 0u64;
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    let mut buffer = [0u8; 65536];
    while let Some((directory, depth)) = pending.pop() {
        check_time(deadline)?;
        if depth > 64 {
            return Err(refused("inspection directory depth exceeded"));
        }
        for item in fs::read_dir(directory)? {
            check_time(deadline)?;
            let item = item?;
            let path = item.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| refused("unsafe inspection path"))?;
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
                return Err(refused("unsupported inspection entry"));
            }
            #[cfg(unix)]
            if metadata.is_file() {
                use std::os::unix::fs::MetadataExt;
                if metadata.nlink() != 1 {
                    return Err(refused("linked inspection file"));
                }
            }
            if relative == Path::new(".lock") {
                if !metadata.is_file() {
                    return Err(refused("unsafe process lock"));
                }
                continue;
            }
            path_bytes = path_bytes
                .checked_add(relative.as_os_str().len() as u64)
                .ok_or_else(|| refused("inspection path budget exceeded"))?;
            if entries.len() as u64 >= limits.max_entries || path_bytes > 4 * 1024 * 1024 {
                return Err(refused("inspection inventory budget exceeded"));
            }
            if metadata.is_dir() {
                entries.insert(relative.to_path_buf(), InventoryEntry::Directory);
                pending.push((path, depth + 1));
            } else {
                bytes = bytes
                    .checked_add(metadata.len())
                    .ok_or_else(|| refused("inspection byte budget exceeded"))?;
                if bytes > limits.max_file_bytes {
                    return Err(refused("inspection byte budget exceeded"));
                }
                if relative == Path::new("projections/snapshot.json")
                    && metadata.len() > limits.max_snapshot_bytes
                {
                    return Err(refused("inspection snapshot budget exceeded"));
                }
                let mut file = File::open(&path)?;
                let mut hash = blake3::Hasher::new();
                let mut read_bytes = 0u64;
                loop {
                    check_time(deadline)?;
                    let count = file.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    read_bytes += count as u64;
                    if read_bytes > metadata.len() {
                        return Err(refused("inspection tree changed"));
                    }
                    hash.update(&buffer[..count]);
                }
                if read_bytes != metadata.len() {
                    return Err(refused("inspection tree changed"));
                }
                entries.insert(
                    relative.to_path_buf(),
                    InventoryEntry::File {
                        size: read_bytes,
                        digest: *hash.finalize().as_bytes(),
                    },
                );
            }
        }
    }
    Ok(entries)
}

/// Verify every indexed event against a full replay from an empty view, then
/// compare with the saved projection at exactly the requested checkpoint.
/// Histories pruned below a required indexed record refuse this support profile.
/// Keys are supplied by the protected bundle, never read from ambient env.
pub async fn inspect_frozen(
    data_dir: &Path,
    bootstrap_key: &[u8; 32],
    expected_seq: u64,
    expected_prefix: &str,
    limits: InspectionLimits,
) -> Result<OfflineInspection> {
    if fs::symlink_metadata(data_dir)?.file_type().is_symlink() || !data_dir.is_dir() {
        return Err(refused("unsafe inspection root"));
    }
    let lock_path = data_dir.join(".lock");
    match fs::symlink_metadata(&lock_path) {
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => {
            return Err(refused("unsafe process lock"))
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(&lock_path)?;
    inspect_frozen_locked(
        data_dir,
        bootstrap_key,
        expected_seq,
        expected_prefix,
        limits,
        &lock,
    )
    .await
}

/// Inspect while a containing whole-instance operation owns this engine's
/// exact advisory-lock descriptor. The descriptor must match this root; the
/// caller retains it across its sidecar/upload/key checks. It is never unlocked
/// or rewritten here.
pub async fn inspect_frozen_locked(
    data_dir: &Path,
    bootstrap_key: &[u8; 32],
    expected_seq: u64,
    expected_prefix: &str,
    limits: InspectionLimits,
    lock: &File,
) -> Result<OfflineInspection> {
    if limits.max_entries == 0
        || limits.max_entries > 100_000
        || limits.max_file_bytes == 0
        || limits.max_file_bytes > 256 * 1024 * 1024
        || limits.max_snapshot_bytes == 0
        || limits.max_snapshot_bytes > 16 * 1024 * 1024
        || limits.timeout.is_zero()
        || limits.timeout > Duration::from_secs(300)
        || expected_prefix.len() != 64
        || hex::decode(expected_prefix).is_err()
    {
        return Err(refused("invalid inspection limits or expected prefix"));
    }
    let deadline = Instant::now()
        .checked_add(limits.timeout)
        .ok_or_else(|| refused("invalid inspection deadline"))?;
    if fs::symlink_metadata(data_dir)?.file_type().is_symlink() || !data_dir.is_dir() {
        return Err(refused("unsafe inspection root"));
    }
    let root = fs::canonicalize(data_dir)?;
    let lock_path = root.join(".lock");
    let current = fs::symlink_metadata(&lock_path)?;
    if !current.is_file() || current.file_type().is_symlink() {
        return Err(refused("unsafe process lock"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let held = lock.metadata()?;
        if (current.dev(), current.ino()) != (held.dev(), held.ino()) || held.nlink() != 1 {
            return Err(refused("inspection descriptor does not own this tree"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if current.creation_time() != lock.metadata()?.creation_time() {
            return Err(refused("inspection descriptor does not own this tree"));
        }
    }
    if !FileExt::try_lock_exclusive(lock)? {
        return Err(refused("engine is running"));
    }
    let before = inventory(&root, &limits, deadline)?;
    if !before.contains_key(Path::new("storage-manifest.json")) {
        return Err(refused("inspection manifest is missing"));
    }
    let indexed =
        crate::commit_index::batcher::read_all_entries(&root.join("global/commit-index"))?;
    if indexed
        .windows(2)
        .any(|pair| pair[0].commit_seq >= pair[1].commit_seq)
        || indexed.first().is_some_and(|entry| entry.commit_seq == 0)
        || indexed.last().map_or(0, |entry| entry.commit_seq) != expected_seq
        || crate::replication::commit_prefix_fingerprint(&indexed, expected_seq) != expected_prefix
    {
        return Err(refused(
            "inspection committed prefix differs from expected checkpoint",
        ));
    }
    // The existing reader stops at the first missing numbered file; do not let
    // a later disconnected index file be silently omitted from this audit.
    let mut index_names = Vec::new();
    for path in before
        .keys()
        .filter(|path| path.parent() == Some(Path::new("global/commit-index")))
    {
        if path.extension().is_some_and(|ext| ext == "widx") {
            index_names.push(path.file_name().unwrap().to_string_lossy().into_owned());
        }
    }
    index_names.sort();
    for (number, name) in index_names.iter().enumerate() {
        if name != &format!("{number:08}.widx") {
            return Err(refused("inspection index files are discontinuous"));
        }
    }
    let saved = read_saved_view(&root, &limits)?;
    let watermark = saved.applied_commit_seq();
    if watermark != expected_seq {
        return Err(refused(
            "inspection snapshot watermark differs from checkpoint",
        ));
    }
    let saved_fingerprint = saved.content_fingerprint(limits.max_entries, limits.max_file_bytes)?;
    let state = Arc::new(ProjectionState::new());
    let barrier = LinearizabilityBarrier::new(state.clone());
    let registry = tokio::sync::Mutex::new(StreamKeyRegistry::new());
    let types = super::build_type_registry()?;
    check_time(deadline)?;
    let high = tokio::time::timeout(
        deadline.saturating_duration_since(Instant::now()),
        super::replay::replay_projections(
            &root,
            &registry,
            bootstrap_key,
            &state,
            types.dispatch_table(),
            &barrier,
            0,
        ),
    )
    .await
    .map_err(|_| refused("inspection replay deadline elapsed"))??;
    let rebuilt = state.content_fingerprint(limits.max_entries, limits.max_file_bytes)?;
    if rebuilt != saved_fingerprint || barrier.current() != expected_seq {
        return Err(refused(
            "inspection replay differs from persisted projection",
        ));
    }
    if before != inventory(&root, &limits, deadline)? {
        return Err(refused("inspection tree changed"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let current = fs::symlink_metadata(&lock_path)?;
        let held = lock.metadata()?;
        if (current.dev(), current.ino()) != (held.dev(), held.ino()) || held.nlink() != 1 {
            return Err(refused("inspection process lock changed"));
        }
    }
    Ok(OfflineInspection {
        state,
        receipt: InspectionReceipt {
            applied_commit_seq: expected_seq,
            commit_prefix_fingerprint: expected_prefix.to_owned(),
            projection: rebuilt,
            indexed_commits: indexed.len() as u64,
            observed_high_sequence: high,
            full_history_replayed: true,
            persisted_projection_matches: true,
        },
    })
}

#[cfg(test)]
mod tests;
