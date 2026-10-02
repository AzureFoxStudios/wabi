//! Fail closed on incomplete existing databases before first-boot key generation.
//! Empty directories, regular coordination files and a key published by an
//! interrupted first boot may precede a new database. We never remove files or
//! locks, or generate replacement keys for existing community data.
use std::{ffi::OsStr, fs, io, path::Path};

/// Runtime coordination is not durable community content. Only exact regular
/// files qualify; symlinks and directories must still fail closed.
pub(crate) fn is_first_boot_coordination_file(name: &OsStr, kind: &fs::FileType) -> bool {
    if !kind.is_file() {
        return false;
    }
    match name.to_str() {
        Some(".wabi-secret-publication.lock" | ".lock") => true,
        Some(name) => name.starts_with(".wabi-secret-") && name.ends_with(".tmp"),
        None => false,
    }
}

pub fn check(data: &Path, external_key: bool) -> io::Result<()> {
    let entries = match fs::read_dir(data) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut key = false;
    let mut manifest = false;
    let mut other = false;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let kind = entry.file_type()?;
        if is_first_boot_coordination_file(&name, &kind) {
            continue;
        }
        match name.to_str() {
            Some("root_key") if kind.is_file() => key = true,
            Some("storage-manifest.json") if kind.is_file() => manifest = true,
            _ => other = true,
        }
    }
    if !key && !external_key && (manifest || other) {
        return Err(io::Error::new(io::ErrorKind::InvalidData,
            "Existing database is missing its root_key. Restore the original key; no replacement key was generated."));
    }
    if !manifest && other {
        return Err(io::Error::new(io::ErrorKind::InvalidData,
            "Existing database is missing storage-manifest.json. Restore the complete database; refusing to initialize over existing files."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "wabi-bootstrap-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self, name: &str) {
            fs::write(self.0.join(name), b"unchanged").unwrap();
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn accepts_fresh_or_key_only_directory() {
        let t = Temp::new();
        check(&t.0.join("missing"), false).unwrap();
        check(&t.0, false).unwrap();
        t.file("root_key");
        check(&t.0, false).unwrap();
    }
    #[test]
    fn missing_key_in_existing_database_never_creates_one() {
        let t = Temp::new();
        t.file("storage-manifest.json");
        assert!(check(&t.0, false).is_err());
        assert!(!t.0.join("root_key").exists());
        assert_eq!(
            fs::read(t.0.join("storage-manifest.json")).unwrap(),
            b"unchanged"
        );
    }
    #[test]
    fn explicit_operator_key_remains_supported() {
        let t = Temp::new();
        t.file("storage-manifest.json");
        check(&t.0, true).unwrap();
    }
    #[test]
    fn missing_manifest_with_storage_is_not_first_boot() {
        let t = Temp::new();
        t.file("root_key");
        fs::create_dir(t.0.join("streams")).unwrap();
        assert!(check(&t.0, false).is_err());
        assert!(check(&t.0, true).is_err());
        assert!(!t.0.join("storage-manifest.json").exists());
    }
    #[test]
    fn persistent_runtime_locks_are_allowed_but_unknown_files_still_fail_closed() {
        let t = Temp::new();
        t.file(".lock");
        t.file(".wabi-secret-publication.lock");
        check(&t.0, false).unwrap();
        t.file("root_key");
        check(&t.0, false).unwrap();
        t.file("unknown-state");
        assert!(check(&t.0, false).is_err());
        assert_eq!(fs::read(t.0.join(".lock")).unwrap(), b"unchanged");
    }
    #[test]
    fn concurrent_first_boot_temporary_file_is_allowed() {
        let t = Temp::new();
        t.file(".wabi-secret-unpublished.tmp");
        check(&t.0, false).unwrap();
    }
}
