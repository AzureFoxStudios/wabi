//! Stopped-copy snapshots. Secrets are part of the backup; no live-copy claims.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, String>;
const MAX_FILES: usize = 100_000;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub version: u32,
    pub files: BTreeMap<String, String>,
}

pub fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    if !fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("Private storage must be a real directory, not a symbolic link".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}
fn digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut buf = [0_u8; 64 * 1024];
    loop {
        let len = file.read(&mut buf).map_err(|e| e.to_string())?;
        if len == 0 {
            break;
        }
        hash.update(&buf[..len]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn runtime_coordination_file(path: &Path) -> bool {
    [
        ".lock",
        "wabidb/.lock",
        ".wabi-secret-publication.lock",
        "wabidb/.wabi-secret-publication.lock",
    ]
    .iter()
    .any(|candidate| path == Path::new(candidate))
}
fn walk(
    root: &Path,
    relative: &Path,
    files: &mut BTreeMap<String, String>,
    target: Option<&Path>,
) -> Result<()> {
    let here = root.join(relative);
    if !fs::symlink_metadata(&here)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("Backup data must be a real directory, not a symbolic link".into());
    }
    if let Some(target) = target {
        private_dir(&target.join(relative))?;
    }
    for entry in fs::read_dir(here).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let child = relative.join(entry.file_name());
        if kind.is_dir() {
            walk(root, &child, files, target)?;
        } else if kind.is_file() {
            // Exact canonical coordination paths only; uploaded names remain data.
            if runtime_coordination_file(&child) {
                continue;
            }
            if files.len() >= MAX_FILES {
                return Err("Snapshot exceeds supported file count".into());
            }
            let name = child
                .to_str()
                .ok_or("Backup contains a non-UTF-8 filename")?
                .replace('\\', "/");
            let hash = digest(&entry.path())?;
            if let Some(target) = target {
                let dest = target.join(&child);
                let mut source = fs::File::open(entry.path()).map_err(|e| e.to_string())?;
                let mut opts = fs::OpenOptions::new();
                opts.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    opts.mode(0o600);
                }
                let mut out = opts.open(&dest).map_err(|e| e.to_string())?;
                std::io::copy(&mut source, &mut out)
                    .and_then(|_| out.sync_all())
                    .map_err(|e| e.to_string())?;
                if digest(&dest)? != hash {
                    return Err("Snapshot copy verification failed".into());
                }
            }
            if files.insert(name, hash).is_some() {
                return Err("Ambiguous backup filename".into());
            }
        } else {
            return Err("Snapshots reject symbolic links and special files".into());
        }
    }
    Ok(())
}
/// Own WabiDB's persistent advisory lock throughout a stopped operation.
/// Diagnostic PID bytes are never used as ownership and the inode is never
/// unlinked. Older root PID locks require explicit operator resolution.
struct SnapshotLease {
    data: PathBuf,
    lock: fs::File,
}
fn refuse_legacy_lock(data: &Path) -> Result<()> {
    match fs::symlink_metadata(data.join(".lock")) {
        Ok(_) => Err("A legacy Authority lock exists. Stop every old Wabi process and resolve only data/.lock before continuing; do not remove wabidb/.lock.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}
impl SnapshotLease {
    fn acquire(data: &Path) -> Result<Self> {
        refuse_legacy_lock(data)?;
        for dir in [data.to_path_buf(), data.join("wabidb")] {
            let metadata = fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("Community data must use real directories, not symbolic links".into());
            }
        }
        let path = data.join("wabidb/.lock");
        match fs::symlink_metadata(&path) {
            Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
                return Err("Authority process lock must be a regular file".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(path).map_err(|e| e.to_string())?;
        lock.try_lock().map_err(|_| "The Authority is running or safe locking is unavailable. Stop other Wabi processes; no data was copied or moved.".to_string())?;
        let lease = Self {
            data: data.to_owned(),
            lock,
        };
        lease.verify()?;
        Ok(lease)
    }
    fn verify(&self) -> Result<()> {
        refuse_legacy_lock(&self.data)?;
        let current =
            fs::symlink_metadata(self.data.join("wabidb/.lock")).map_err(|e| e.to_string())?;
        if !current.is_file() || current.file_type().is_symlink() {
            return Err("Authority process lock is no longer a regular file".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let held = self.lock.metadata().map_err(|e| e.to_string())?;
            if (held.dev(), held.ino()) != (current.dev(), current.ino()) {
                return Err(
                    "Authority process lock inode changed during the stopped operation".into(),
                );
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if self
                .lock
                .metadata()
                .map_err(|e| e.to_string())?
                .creation_time()
                != current.creation_time()
            {
                return Err("Authority process lock changed during the stopped operation".into());
            }
        }
        Ok(())
    }
    fn relocated(&mut self, from: &Path, to: &Path) -> Result<()> {
        let relative = self.data.strip_prefix(from).map_err(|e| e.to_string())?;
        self.data = to.join(relative);
        self.verify()
    }
}
impl Drop for SnapshotLease {
    fn drop(&mut self) {
        // Closing a handle releases ownership, including after a crash. Unlock
        // explicitly too, avoiding an inherited descriptor delaying release.
        let _ = self.lock.unlock();
    }
}

pub fn snapshot(data: &Path, destination: &Path) -> Result<()> {
    let lease = SnapshotLease::acquire(data)?;
    // Exclusive creation avoids merging with or removing another process's data.
    fs::create_dir(destination).map_err(|e| format!("Cannot create snapshot: {e}"))?;
    private_dir(destination)?;
    let result = (|| {
        let mut files = BTreeMap::new();
        walk(
            data,
            Path::new(""),
            &mut files,
            Some(&destination.join("data")),
        )?;
        for key in ["jwt_secret", "wabidb/root_key"] {
            if !files.contains_key(key) {
                return Err(format!(
                    "Cannot snapshot: missing durable identity file {key}"
                ));
            }
        }
        lease.verify()?;
        let manifest = Manifest { version: 1, files };
        write_private(
            &destination.join("manifest.json"),
            &serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
        )?;
        lease.verify()
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(destination);
    }
    result
}
fn verified_manifest(snapshot: &Path) -> Result<Manifest> {
    let metadata =
        fs::symlink_metadata(snapshot.join("manifest.json")).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 32 * 1024 * 1024 {
        return Err("Invalid snapshot manifest".into());
    }
    let mut manifest: Manifest = serde_json::from_slice(
        &fs::read(snapshot.join("manifest.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    if manifest.version != 1 {
        return Err("Unsupported snapshot version".into());
    }
    // Earlier version-1 snapshots may list secret-publication coordination
    // files. They contain no community data and must not be restored as leases.
    // Normalize only the same four exact runtime paths excluded from the walk.
    manifest
        .files
        .retain(|path, _| !runtime_coordination_file(Path::new(path)));
    let mut actual = BTreeMap::new();
    walk(&snapshot.join("data"), Path::new(""), &mut actual, None)?;
    if actual != manifest.files {
        return Err("Snapshot is damaged or has unlisted files; nothing was restored".into());
    }
    if !actual.contains_key("jwt_secret") || !actual.contains_key("wabidb/root_key") {
        return Err("Snapshot is missing community identity keys".into());
    }
    Ok(manifest)
}
pub fn validate(snapshot: &Path) -> Result<()> {
    verified_manifest(snapshot).map(|_| ())
}
fn copy_verified(snapshot: &Path, staging: &Path, manifest: &Manifest) -> Result<()> {
    // Own staging only after exclusive creation succeeds.
    fs::create_dir(staging).map_err(|e| format!("Cannot create restore staging: {e}"))?;
    let result = (|| {
        private_dir(staging)?;
        let mut files = BTreeMap::new();
        walk(
            &snapshot.join("data"),
            Path::new(""),
            &mut files,
            Some(staging),
        )?;
        // A consistent copy is not enough: compare with the original manifest.
        if files != manifest.files {
            return Err("Snapshot changed while restoring; original data was not replaced".into());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}
pub fn restore_copy(snapshot: &Path, staging: &Path) -> Result<()> {
    let manifest = verified_manifest(snapshot)?;
    copy_verified(snapshot, staging, &manifest)
}

/// Keep current and replacement advisory leases held through tree publication.
/// A restore never renames a possibly live community or removes its original.
pub fn install_restore(
    snapshot: &Path,
    data: &Path,
    staging: &Path,
    original: &Path,
) -> Result<bool> {
    if original.exists() {
        return Err("The restore preservation folder already exists".into());
    }
    let had_data = data.exists();
    let mut lease = if had_data {
        Some(SnapshotLease::acquire(data)?)
    } else {
        None
    };
    restore_copy(snapshot, staging)?;
    // Hold the replacement's own inode before publishing it at the live path.
    let mut staged_lease = SnapshotLease::acquire(staging)?;
    if had_data {
        lease.as_ref().unwrap().verify()?;
        fs::rename(data, original).map_err(|e| {
            format!(
                "Could not preserve the current community; copied backup is kept at {}: {e}",
                staging.display()
            )
        })?;
        lease.as_mut().unwrap().relocated(data, original)?;
    }
    staged_lease.verify()?;
    if let Err(error) = fs::rename(staging, data) {
        if had_data {
            fs::rename(original, data).map_err(|rollback| format!("Restore failed ({error}); the original is kept at {} and the backup copy at {}. Could not move the original back: {rollback}", original.display(), staging.display()))?;
            lease.as_mut().unwrap().relocated(original, data)?;
        }
        return Err(format!(
            "Restore could not be installed; the original community was kept. {error}"
        ));
    }
    staged_lease.relocated(staging, data)?;
    if let Some(lease) = &lease {
        lease.verify()?;
    }
    Ok(had_data)
}

/// Undo a failed restore only after owning both trees' actual advisory locks.
/// A live owner or unresolved legacy root lock prevents any data relocation.
pub fn rollback_restore(data: &Path, original: &Path, failed: &Path, had_data: bool) -> Result<()> {
    if failed.exists() {
        return Err("The failed-restore preservation folder already exists".into());
    }
    let mut restored_lease = SnapshotLease::acquire(data)?;
    let mut original_lease = if had_data {
        Some(SnapshotLease::acquire(original)?)
    } else {
        None
    };
    restored_lease.verify()?;
    if let Some(lease) = &original_lease {
        lease.verify()?;
    }
    fs::rename(data, failed).map_err(|e| e.to_string())?;
    restored_lease.relocated(data, failed)?;
    if had_data {
        fs::rename(original, data).map_err(|e| {
            format!(
                "The original is still preserved at {}: {e}",
                original.display()
            )
        })?;
        original_lease.as_mut().unwrap().relocated(original, data)?;
    }
    Ok(())
}
pub fn checked_snapshot(root: &Path, id: &str) -> Result<PathBuf> {
    if id.is_empty() || id.len() > 80 || !id.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return Err("Invalid snapshot identifier".into());
    }
    let path = root.join(id);
    if !fs::symlink_metadata(&path)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("Snapshot is not a directory".into());
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temporary(PathBuf);
    impl Temporary {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "wabi-snapshot-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            private_dir(&path).unwrap();
            Self(path)
        }
        fn data(&self) -> PathBuf {
            let data = self.0.join("data");
            private_dir(&data.join("wabidb")).unwrap();
            write_private(&data.join("jwt_secret"), b"jwt-identity").unwrap();
            write_private(&data.join("wabidb/root_key"), b"root-identity").unwrap();
            data
        }
    }
    impl Drop for Temporary {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn snapshot_restores_identity_and_rejects_tampering() {
        let t = Temporary::new();
        let data = t.data();
        let backup = t.0.join("1");
        snapshot(&data, &backup).unwrap();
        assert!(!data.join(".lock").exists());
        assert!(!backup.join("data/wabidb/.lock").exists());
        let dest = t.0.join("restore");
        restore_copy(&backup, &dest).unwrap();
        assert_eq!(fs::read(dest.join("jwt_secret")).unwrap(), b"jwt-identity");
        assert_eq!(
            fs::read(dest.join("wabidb/root_key")).unwrap(),
            b"root-identity"
        );
        fs::write(backup.join("data/wabidb/root_key"), b"damaged").unwrap();
        assert!(validate(&backup).is_err());
        assert!(restore_copy(&backup, &t.0.join("untouched")).is_err());
        assert!(!t.0.join("untouched").exists());
    }
    #[test]
    fn refuses_os_owned_writer_and_unsafe_ids() {
        let t = Temporary::new();
        let data = t.data();
        write_private(&data.join("wabidb/.lock"), b"diagnostic-only").unwrap();
        let writer = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(data.join("wabidb/.lock"))
            .unwrap();
        writer.try_lock().unwrap();
        assert!(snapshot(&data, &t.0.join("1")).is_err());
        assert!(!t.0.join("1").exists());
        assert!(!data.join(".lock").exists());
        assert!(checked_snapshot(&t.0, "../data").is_err());
        assert!(checked_snapshot(&t.0, "").is_err());
    }
    #[test]
    fn stopped_persistent_lock_is_preserved_with_diagnostic_bytes() {
        let t = Temporary::new();
        let data = t.data();
        let path = data.join("wabidb/.lock");
        let diagnostic = std::process::id().to_string();
        write_private(&path, diagnostic.as_bytes()).unwrap();
        #[cfg(unix)]
        let before = {
            use std::os::unix::fs::MetadataExt;
            let metadata = fs::metadata(&path).unwrap();
            (metadata.dev(), metadata.ino())
        };
        snapshot(&data, &t.0.join("1")).unwrap();
        snapshot(&data, &t.0.join("2")).unwrap();
        assert_eq!(fs::read(&path).unwrap(), diagnostic.as_bytes());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let metadata = fs::metadata(&path).unwrap();
            assert_eq!((metadata.dev(), metadata.ino()), before);
        }
        // Neither diagnostic PID text nor file presence means a live owner.
        let writer = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        writer.try_lock().unwrap();
    }
    #[test]
    fn lease_blocks_competing_writer_and_keeps_ownership_after_relocation() {
        let t = Temporary::new();
        let data = t.data();
        let mut lease = SnapshotLease::acquire(&data).unwrap();
        let contender = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(data.join("wabidb/.lock"))
            .unwrap();
        assert!(contender.try_lock().is_err());
        let original = t.0.join("original");
        fs::rename(&data, &original).unwrap();
        lease.relocated(&data, &original).unwrap();
        assert!(contender.try_lock().is_err());
        let moved_contender = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(original.join("wabidb/.lock"))
            .unwrap();
        assert!(moved_contender.try_lock().is_err());
        drop(lease);
        assert!(original.join("wabidb/.lock").is_file());
        moved_contender.try_lock().unwrap();
    }
    #[test]
    fn legacy_root_lock_refuses_snapshot_restore_and_is_never_removed() {
        let t = Temporary::new();
        let data = t.data();
        let backup = t.0.join("1");
        snapshot(&data, &backup).unwrap();
        write_private(&data.join(".lock"), b"unresolved-legacy-pid").unwrap();
        assert!(snapshot(&data, &t.0.join("2")).is_err());
        assert!(
            install_restore(&backup, &data, &t.0.join("staging"), &t.0.join("original")).is_err()
        );
        assert_eq!(
            fs::read(data.join(".lock")).unwrap(),
            b"unresolved-legacy-pid"
        );
        assert!(!t.0.join("2").exists());
        assert!(!t.0.join("staging").exists());
        assert!(!t.0.join("original").exists());
    }
    #[cfg(unix)]
    #[test]
    fn lease_verification_refuses_changed_inode_without_unlinking_either() {
        use std::os::unix::fs::MetadataExt;
        let t = Temporary::new();
        let data = t.data();
        let lease = SnapshotLease::acquire(&data).unwrap();
        let path = data.join("wabidb/.lock");
        let inode = fs::metadata(&path).unwrap().ino();
        let moved = data.join("wabidb/displaced-lock");
        fs::rename(&path, &moved).unwrap();
        write_private(&path, b"replacement").unwrap();
        assert!(lease.verify().is_err());
        drop(lease);
        assert_eq!(fs::metadata(&moved).unwrap().ino(), inode);
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
    }
    #[cfg(unix)]
    #[test]
    fn engine_lock_symlink_is_rejected_without_touching_its_target() {
        let t = Temporary::new();
        let data = t.data();
        let target = t.0.join("unrelated");
        write_private(&target, b"untouched").unwrap();
        std::os::unix::fs::symlink(&target, data.join("wabidb/.lock")).unwrap();
        assert!(snapshot(&data, &t.0.join("1")).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"untouched");
        assert!(fs::symlink_metadata(data.join("wabidb/.lock"))
            .unwrap()
            .file_type()
            .is_symlink());
    }
    #[test]
    fn rollback_refuses_live_restored_or_original_tree_without_moving_either() {
        let t = Temporary::new();
        let data = t.data();
        let backup = t.0.join("1");
        snapshot(&data, &backup).unwrap();
        let original = t.0.join("original");
        install_restore(&backup, &data, &t.0.join("staging"), &original).unwrap();
        let failed = t.0.join("failed");
        for root in [&data, &original] {
            let writer = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(root.join("wabidb/.lock"))
                .unwrap();
            writer.try_lock().unwrap();
            assert!(rollback_restore(&data, &original, &failed, true).is_err());
            assert!(data.join("jwt_secret").is_file());
            assert!(original.join("jwt_secret").is_file());
            assert!(!failed.exists());
        }
        rollback_restore(&data, &original, &failed, true).unwrap();
        assert!(data.join("wabidb/.lock").is_file());
        assert!(failed.join("wabidb/.lock").is_file());
    }
    #[test]
    fn changed_source_during_restore_is_rejected_and_cleaned_up() {
        let t = Temporary::new();
        let data = t.data();
        let backup = t.0.join("1");
        snapshot(&data, &backup).unwrap();
        let manifest = verified_manifest(&backup).unwrap();
        fs::write(
            backup.join("data/wabidb/root_key"),
            b"changed-after-validation",
        )
        .unwrap();
        let staging = t.0.join("staging");
        assert!(copy_verified(&backup, &staging, &manifest).is_err());
        assert!(!staging.exists());
        assert_eq!(
            fs::read(data.join("wabidb/root_key")).unwrap(),
            b"root-identity"
        );
    }
    #[test]
    fn existing_destinations_are_never_overwritten_or_removed() {
        let t = Temporary::new();
        let data = t.data();
        let backup = t.0.join("1");
        snapshot(&data, &backup).unwrap();
        let manifest = fs::read(backup.join("manifest.json")).unwrap();
        assert!(snapshot(&data, &backup).is_err());
        assert_eq!(fs::read(backup.join("manifest.json")).unwrap(), manifest);
        let staging = t.0.join("staging");
        private_dir(&staging).unwrap();
        fs::write(staging.join("keep"), b"unrelated").unwrap();
        assert!(restore_copy(&backup, &staging).is_err());
        assert_eq!(fs::read(staging.join("keep")).unwrap(), b"unrelated");
    }
    #[test]
    fn uploaded_lock_filenames_are_data_not_runtime_leases() {
        let t = Temporary::new();
        let data = t.data();
        let backup = t.0.join("1");
        private_dir(&data.join("uploads")).unwrap();
        write_private(&data.join("uploads/.lock"), b"user-upload").unwrap();
        write_private(
            &data.join("uploads/.wabi-secret-publication.lock"),
            b"user-upload-publication-name",
        )
        .unwrap();
        write_private(
            &data.join(".wabi-secret-publication.lock"),
            b"runtime-publication-lock",
        )
        .unwrap();
        write_private(
            &data.join("wabidb/.wabi-secret-publication.lock"),
            b"runtime-db-publication-lock",
        )
        .unwrap();
        snapshot(&data, &backup).unwrap();
        restore_copy(&backup, &t.0.join("restore")).unwrap();
        assert_eq!(
            fs::read(t.0.join("restore/uploads/.lock")).unwrap(),
            b"user-upload"
        );
        assert_eq!(
            fs::read(t.0.join("restore/uploads/.wabi-secret-publication.lock")).unwrap(),
            b"user-upload-publication-name"
        );
        assert!(!t.0.join("restore/.wabi-secret-publication.lock").exists());
        assert!(!t
            .0
            .join("restore/wabidb/.wabi-secret-publication.lock")
            .exists());
        assert!(data.join(".wabi-secret-publication.lock").is_file());
        assert!(data.join("wabidb/.wabi-secret-publication.lock").is_file());
    }
    #[test]
    fn older_v1_publication_lock_entries_are_readable_but_not_restored() {
        let t = Temporary::new();
        let data = t.data();
        let backup = t.0.join("1");
        snapshot(&data, &backup).unwrap();
        let manifest_path = backup.join("manifest.json");
        let mut manifest: Manifest =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        for name in [
            ".wabi-secret-publication.lock",
            "wabidb/.wabi-secret-publication.lock",
        ] {
            write_private(&backup.join("data").join(name), b"legacy-runtime-metadata").unwrap();
            manifest.files.insert(
                name.into(),
                digest(&backup.join("data").join(name)).unwrap(),
            );
        }
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let restore = t.0.join("restore");
        restore_copy(&backup, &restore).unwrap();
        assert_eq!(
            fs::read(restore.join("jwt_secret")).unwrap(),
            b"jwt-identity"
        );
        assert!(!restore.join(".wabi-secret-publication.lock").exists());
        assert!(!restore
            .join("wabidb/.wabi-secret-publication.lock")
            .exists());
    }
    #[test]
    fn restore_preserves_original_and_rollback_keeps_failed_tree() {
        let t = Temporary::new();
        let data = t.data();
        let backup = t.0.join("1");
        snapshot(&data, &backup).unwrap();
        fs::write(data.join("keep-original"), b"new-content").unwrap();
        let original = t.0.join("original");
        assert!(install_restore(&backup, &data, &t.0.join("staging"), &original).unwrap());
        assert!(original.join("keep-original").is_file());
        assert!(!data.join("keep-original").exists());
        assert!(!original.join(".lock").exists());
        let failed = t.0.join("failed");
        rollback_restore(&data, &original, &failed, true).unwrap();
        assert!(data.join("keep-original").is_file());
        assert!(failed.join("jwt_secret").is_file());
        assert!(data.join("wabidb/.lock").is_file());
    }
    #[test]
    fn restore_does_not_move_live_data_even_after_backup_validation() {
        let t = Temporary::new();
        let data = t.data();
        let backup = t.0.join("1");
        snapshot(&data, &backup).unwrap();
        validate(&backup).unwrap();
        fs::write(data.join("wabidb/.lock"), b"another-process").unwrap();
        let writer = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(data.join("wabidb/.lock"))
            .unwrap();
        writer.try_lock().unwrap();
        let original = t.0.join("original");
        let staging = t.0.join("staging");
        assert!(install_restore(&backup, &data, &staging, &original).is_err());
        assert!(data.join("jwt_secret").is_file());
        assert!(!original.exists());
        assert!(!staging.exists());
        assert_eq!(
            fs::read(data.join("wabidb/.lock")).unwrap(),
            b"another-process"
        );
    }
    #[cfg(unix)]
    #[test]
    fn private_storage_rejects_directory_symlinks() {
        let t = Temporary::new();
        let real = t.0.join("real");
        private_dir(&real).unwrap();
        let link = t.0.join("alias");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(private_dir(&link).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_without_following_it() {
        let t = Temporary::new();
        let data = t.data();
        std::os::unix::fs::symlink("/etc/passwd", data.join("escape")).unwrap();
        assert!(snapshot(&data, &t.0.join("1")).is_err());
        assert!(!t.0.join("1").exists());
        assert!(data.join("wabidb/.lock").is_file());
    }
}
