//! Stopped-copy snapshots. Secrets are part of the backup; no live-copy claims.
use std::{collections::BTreeMap, fs, io::{Read, Write}, path::{Path, PathBuf}};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

type Result<T> = std::result::Result<T, String>;
const MAX_FILES: usize = 100_000;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest { pub version: u32, pub files: BTreeMap<String, String> }

pub fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())
}
fn digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new(); let mut buf = [0_u8; 64 * 1024];
    loop {
        let len = file.read(&mut buf).map_err(|e| e.to_string())?;
        if len == 0 { break; }
        hash.update(&buf[..len]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn walk(root: &Path, relative: &Path, files: &mut BTreeMap<String, String>, target: Option<&Path>) -> Result<()> {
    let here = root.join(relative);
    if !fs::symlink_metadata(&here).map_err(|e| e.to_string())?.is_dir() {
        return Err("Backup data must be a real directory, not a symbolic link".into());
    }
    if let Some(target) = target { private_dir(&target.join(relative))?; }
    for entry in fs::read_dir(here).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let child = relative.join(entry.file_name());
        if kind.is_dir() { walk(root, &child, files, target)?; }
        else if kind.is_file() {
            // Process locks are runtime leases, not durable community data.
            if entry.file_name() == ".lock" { continue; }
            if files.len() >= MAX_FILES { return Err("Snapshot exceeds supported file count".into()); }
            let name = child.to_str().ok_or("Backup contains a non-UTF-8 filename")?.replace('\\', "/");
            let hash = digest(&entry.path())?;
            if let Some(target) = target {
                let dest = target.join(&child);
                let mut source = fs::File::open(entry.path()).map_err(|e| e.to_string())?;
                let mut opts = fs::OpenOptions::new(); opts.write(true).create_new(true);
                #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; opts.mode(0o600); }
                let mut out = opts.open(&dest).map_err(|e| e.to_string())?;
                std::io::copy(&mut source, &mut out).and_then(|_| out.sync_all()).map_err(|e| e.to_string())?;
                if digest(&dest)? != hash { return Err("Snapshot copy verification failed".into()); }
            }
            if files.insert(name, hash).is_some() { return Err("Ambiguous backup filename".into()); }
        } else { return Err("Snapshots reject symbolic links and special files".into()); }
    }
    Ok(())
}
/// Cooperate with WabiDB's create-exclusive PID lease, including CLI hosts.
/// Publish an already-written inode atomically so there is no empty-PID window.
struct SnapshotLease { paths: Vec<PathBuf>, pid: String }
impl SnapshotLease {
    fn acquire(data: &Path) -> Result<Self> {
        let mut lease = Self { paths: Vec::new(), pid: std::process::id().to_string() };
        for dir in [data.to_path_buf(), data.join("wabidb")] {
            if !dir.is_dir() { return Err("Missing community data directory".into()); }
            let temporary = dir.join(format!(".desktop-lock-{}", lease.pid));
            write_private(&temporary, lease.pid.as_bytes())?;
            let path = dir.join(".lock");
            let result = fs::hard_link(&temporary, &path);
            let _ = fs::remove_file(&temporary);
            result.map_err(|_| "Data is locked or this filesystem cannot acquire a safe snapshot lease. Stop other Wabi processes; no snapshot was taken.".to_string())?;
            lease.paths.push(path);
        }
        Ok(lease)
    }
}
impl Drop for SnapshotLease {
    fn drop(&mut self) {
        for path in &self.paths {
            if fs::read_to_string(path).ok().as_deref() == Some(&self.pid) { let _ = fs::remove_file(path); }
        }
    }
}

pub fn snapshot(data: &Path, destination: &Path) -> Result<()> {
    let _lease = SnapshotLease::acquire(data)?;
    if destination.exists() { return Err("Snapshot already exists".into()); }
    private_dir(destination)?;
    let result = (|| {
        let mut files = BTreeMap::new();
        walk(data, Path::new(""), &mut files, Some(&destination.join("data")))?;
        for key in ["jwt_secret", "wabidb/root_key"] {
            if !files.contains_key(key) { return Err(format!("Cannot snapshot: missing durable identity file {key}")); }
        }
        let manifest = Manifest { version: 1, files };
        write_private(&destination.join("manifest.json"), &serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?)
    })();
    if result.is_err() { let _ = fs::remove_dir_all(destination); }
    result
}
pub fn validate(snapshot: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(snapshot.join("manifest.json")).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 32 * 1024 * 1024 { return Err("Invalid snapshot manifest".into()); }
    let manifest: Manifest = serde_json::from_slice(&fs::read(snapshot.join("manifest.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if manifest.version != 1 { return Err("Unsupported snapshot version".into()); }
    let mut actual = BTreeMap::new();
    walk(&snapshot.join("data"), Path::new(""), &mut actual, None)?;
    if actual != manifest.files { return Err("Snapshot is damaged or has unlisted files; nothing was restored".into()); }
    if !actual.contains_key("jwt_secret") || !actual.contains_key("wabidb/root_key") { return Err("Snapshot is missing community identity keys".into()); }
    Ok(())
}
pub fn restore_copy(snapshot: &Path, staging: &Path) -> Result<()> {
    validate(snapshot)?;
    if staging.exists() { return Err("Restore staging directory already exists".into()); }
    let mut files = BTreeMap::new();
    walk(&snapshot.join("data"), Path::new(""), &mut files, Some(staging))
}
pub fn checked_snapshot(root: &Path, id: &str) -> Result<PathBuf> {
    if id.is_empty() || id.len() > 80 || !id.bytes().all(|b| b.is_ascii_digit() || b == b'-') { return Err("Invalid snapshot identifier".into()); }
    let path = root.join(id);
    if !fs::symlink_metadata(&path).map_err(|e| e.to_string())?.is_dir() { return Err("Snapshot is not a directory".into()); }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Temporary(PathBuf);
    impl Temporary {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("wabi-snapshot-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            private_dir(&path).unwrap(); Self(path)
        }
        fn data(&self) -> PathBuf {
            let data=self.0.join("data"); private_dir(&data.join("wabidb")).unwrap();
            write_private(&data.join("jwt_secret"),b"jwt-identity").unwrap();
            write_private(&data.join("wabidb/root_key"),b"root-identity").unwrap(); data
        }
    }
    impl Drop for Temporary { fn drop(&mut self) { let _=fs::remove_dir_all(&self.0); } }
    #[test] fn snapshot_restores_identity_and_rejects_tampering() {
        let t=Temporary::new(); let data=t.data(); let backup=t.0.join("1");
        snapshot(&data,&backup).unwrap(); assert!(!data.join(".lock").exists());
        assert!(!backup.join("data/wabidb/.lock").exists());
        let dest=t.0.join("restore"); restore_copy(&backup,&dest).unwrap();
        assert_eq!(fs::read(dest.join("jwt_secret")).unwrap(),b"jwt-identity");
        assert_eq!(fs::read(dest.join("wabidb/root_key")).unwrap(),b"root-identity");
        fs::write(backup.join("data/wabidb/root_key"),b"damaged").unwrap();
        assert!(validate(&backup).is_err());
        assert!(restore_copy(&backup,&t.0.join("untouched")).is_err());
        assert!(!t.0.join("untouched").exists());
    }
    #[test] fn refuses_existing_lease_and_unsafe_ids() {
        let t=Temporary::new(); let data=t.data();
        write_private(&data.join("wabidb/.lock"),b"someone-else").unwrap();
        assert!(snapshot(&data,&t.0.join("1")).is_err());
        assert!(!t.0.join("1").exists()); assert!(!data.join(".lock").exists());
        assert!(checked_snapshot(&t.0,"../data").is_err());
        assert!(checked_snapshot(&t.0,"").is_err());
    }
    #[cfg(unix)]
    #[test] fn rejects_symlink_without_following_it() {
        let t=Temporary::new(); let data=t.data();
        std::os::unix::fs::symlink("/etc/passwd",data.join("escape")).unwrap();
        assert!(snapshot(&data,&t.0.join("1")).is_err());
        assert!(!t.0.join("1").exists()); assert!(!data.join("wabidb/.lock").exists());
    }
}
