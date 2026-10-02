//! First-boot secret resolution.
//!
//! Wabi boots with zero required configuration: any missing secret is
//! generated on first boot and persisted inside the data directory so a
//! plain `wabi-server` (or `docker compose up`) starts turnkey. Explicit
//! environment variables always win over persisted files, so operators who
//! manage secrets externally keep full control.
//!
//! Resolution order for both secrets: environment variable > persisted file
//! in the data dir > freshly generated + persisted. A persisted file that
//! exists but is corrupt is a hard error — silently regenerating a key would
//! make existing encrypted data permanently unreadable.

use std::io::{self, Write};
use std::path::Path;

const WEAK_JWT_DEFAULT: &str = "dev-secret-change-in-production";

/// Resolve the JWT signing secret.
///
/// Priority: `WABI_JWT_KEY` env > `JWT_SECRET` env (legacy alias) >
/// persisted `<data_dir>/jwt_secret` > freshly generated + persisted.
/// We never fall back to a hardcoded weak default, because a known secret
/// lets anyone forge tokens for any user (including the owner).
pub fn resolve_jwt_secret(data_dir: &str) -> io::Result<String> {
    let read_env = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    resolve_jwt_secret_with(read_env("WABI_JWT_KEY"), read_env("JWT_SECRET"), data_dir)
}

fn resolve_jwt_secret_with(
    wabi_key: Option<String>,
    legacy_key: Option<String>,
    data_dir: &str,
) -> io::Result<String> {
    resolve_jwt_secret_with_policy(wabi_key, legacy_key, data_dir, cfg!(debug_assertions))
}

fn validate_jwt_secret(value: &str, allow_development_default: bool) -> io::Result<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "jwt_secret is empty; restore it or configure an explicit signing key",
        ));
    }
    if !allow_development_default && value.len() < 32 {
        return Err(io::Error::new(io::ErrorKind::InvalidData,
            "JWT signing keys must contain at least 32 bytes outside debug builds; configure a strong WABI_JWT_KEY"));
    }
    if value == WEAK_JWT_DEFAULT {
        if !allow_development_default {
            return Err(io::Error::new(io::ErrorKind::InvalidData,
                "The known development JWT key is refused outside debug builds; configure a strong WABI_JWT_KEY"));
        }
        tracing::warn!("[security] JWT key is the known development default; use only for disposable development");
    }
    Ok(value.to_string())
}

fn resolve_jwt_secret_with_policy(
    wabi_key: Option<String>,
    legacy_key: Option<String>,
    data_dir: &str,
    allow_development_default: bool,
) -> io::Result<String> {
    if let Some(value) = wabi_key.or(legacy_key) {
        return validate_jwt_secret(&value, allow_development_default);
    }
    let secret_path = Path::new(data_dir).join("jwt_secret");
    if let Err(error) = std::fs::symlink_metadata(&secret_path) {
        if error.kind() != io::ErrorKind::NotFound {
            return Err(error);
        }
        let database = Path::new(data_dir).join("wabidb");
        match std::fs::read_dir(database) {
            Ok(files) => {
                for file in files {
                    let file = file?;
                    if !crate::bootstrap_guard::is_first_boot_coordination_file(
                        &file.file_name(),
                        &file.file_type()?,
                    ) {
                        return Err(io::Error::new(io::ErrorKind::InvalidData,
                            "Existing community is missing jwt_secret. Restore the original file; no replacement secret was generated."));
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    let secret = read_or_create_secret(&secret_path, || {
        format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4())
    })?;
    validate_jwt_secret(&secret, allow_development_default)
}

/// Never overwrite an unreadable/existing key or boot with an unpersisted one.
/// Exclusive creation also prevents two first boots from replacing each other's keys.
fn read_or_create_secret(path: &Path, generate: impl FnOnce() -> String) -> io::Result<String> {
    read_or_create_secret_with_link(path, generate, |source, destination| {
        std::fs::hard_link(source, destination)
    })
}

// The injected link operation exercises unsupported filesystems without changing
// production error handling or relying on the test host's filesystem features.
fn read_or_create_secret_with_link(
    path: &Path,
    generate: impl FnOnce() -> String,
    link: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<String> {
    match std::fs::read_to_string(path) {
        Ok(value) => return Ok(value),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "secret has no parent directory",
        )
    })?;
    std::fs::create_dir_all(parent)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let temporary = parent.join(format!(".wabi-secret-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = options.open(&temporary)?;
        let value = generate();
        file.write_all(value.as_bytes())?;
        file.sync_all()?;
        // All publishers hold the same stable lock inode, including hard-link
        // publishers. Readers see either no file or complete, synced bytes.
        let mut lock_options = std::fs::OpenOptions::new();
        lock_options
            .read(true)
            .write(true)
            .create(true)
            .truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            lock_options.mode(0o600);
        }
        let publication_lock = lock_options.open(parent.join(".wabi-secret-publication.lock"))?;
        fs4::fs_std::FileExt::lock_exclusive(&publication_lock)?;
        match std::fs::symlink_metadata(path) {
            Ok(_) => return std::fs::read_to_string(path),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        // Prefer exclusive hard-link publication. Filesystems without links
        // can atomically rename within this directory under the publication lock.
        match link(&temporary, path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return std::fs::read_to_string(path)
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Unsupported | io::ErrorKind::PermissionDenied
                ) =>
            {
                std::fs::rename(&temporary, path)?;
            }
            Err(error) => return Err(error),
        }
        #[cfg(unix)]
        std::fs::File::open(parent)?.sync_all()?;
        Ok(value)
    })();
    let _ = std::fs::remove_file(&temporary);
    let value = result?;
    tracing::info!(
        "[security] persisted a first-boot secret at {path:?}; include it in protected backups"
    );
    Ok(value)
}

/// Resolve the WabiDB root (bootstrap) key: the key all engine stream keys
/// are derived from.
///
/// Priority: `WABIDB_ROOT_KEY` env (64 hex chars) > persisted
/// `<data_dir>/root_key` > freshly generated + persisted (mode 0600).
///
/// The persisted file lives next to the encrypted data, so it only protects
/// against the data being copied without it — operators wanting stronger
/// guarantees set the env var instead. Losing the key loses the data, which
/// is why generation logs a backup warning.
pub fn resolve_root_key(data_dir: &Path) -> wabidb::error::Result<[u8; 32]> {
    let env_value = std::env::var(wabidb::crypto::bootstrap::ENV_VAR_NAME)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    resolve_root_key_with(env_value.as_deref(), data_dir)
}

fn resolve_root_key_with(
    env_value: Option<&str>,
    data_dir: &Path,
) -> wabidb::error::Result<[u8; 32]> {
    crate::bootstrap_guard::check(data_dir, env_value.is_some())?;
    if let Some(env) = env_value {
        return decode_root_key_hex(env).map_err(|e| wabidb::error::WabiError::Validation {
            command: "resolve_root_key".into(),
            reason: format!("invalid {}: {e}", wabidb::crypto::bootstrap::ENV_VAR_NAME),
        });
    }
    let path = data_dir.join("root_key");
    let persisted = read_or_create_secret(&path, || {
        let mut key = [0u8; 32];
        use rand::RngCore;
        rand::thread_rng().fill_bytes(&mut key);
        format!("{}\n", hex::encode(key))
    })?;
    decode_root_key_hex(persisted.trim()).map_err(|error| wabidb::error::WabiError::Validation {
        command: "resolve_root_key".into(),
        reason: format!("root key file {path:?} is invalid ({error}); restore it from backup; existing data requires its original key"),
    })
}

fn decode_root_key_hex(value: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(value).map_err(|e| e.to_string())?;
    if bytes.len() != 32 {
        return Err(format!(
            "expected 64 hex chars (32 bytes), got {} bytes",
            bytes.len()
        ));
    }
    let arr: [u8; 32] = bytes.try_into().expect("length checked above");
    Ok(arr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_boot_creates_missing_directories_and_reuses_keys() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("new/community");
        let first = resolve_jwt_secret_with(None, None, data.to_str().unwrap()).unwrap();
        assert_eq!(
            resolve_jwt_secret_with(None, None, data.to_str().unwrap()).unwrap(),
            first
        );
        let root = resolve_root_key_with(None, &data.join("wabidb")).unwrap();
        assert_eq!(
            resolve_root_key_with(None, &data.join("wabidb")).unwrap(),
            root
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(data.join("jwt_secret"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn concurrent_first_boots_publish_one_complete_key() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("key");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|index| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    read_or_create_secret(&path, || {
                        barrier.wait();
                        format!("complete-key-{index}")
                    })
                    .unwrap()
                })
            })
            .collect();
        let values: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(values[0], values[1]);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), values[0]);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2);
    }

    #[test]
    fn invalid_or_unreadable_keys_are_never_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        std::fs::write(data.join("jwt_secret"), "").unwrap();
        assert!(resolve_jwt_secret_with(None, None, data.to_str().unwrap()).is_err());
        assert_eq!(std::fs::read(data.join("jwt_secret")).unwrap(), b"");
        std::fs::create_dir(data.join("root_key")).unwrap();
        assert!(resolve_root_key_with(None, data).is_err());
        assert!(data.join("root_key").is_dir());
        std::fs::remove_dir(data.join("root_key")).unwrap();
        std::fs::write(data.join("root_key"), [0xff, 0xfe]).unwrap();
        assert!(resolve_root_key_with(None, data).is_err());
        assert_eq!(std::fs::read(data.join("root_key")).unwrap(), [0xff, 0xfe]);
        let file = data.join("not-a-directory");
        std::fs::write(&file, "keep").unwrap();
        assert!(resolve_jwt_secret_with(None, None, file.to_str().unwrap()).is_err());
        assert_eq!(std::fs::read_to_string(file).unwrap(), "keep");
    }

    fn hex_key(bytes: [u8; 32]) -> String {
        hex::encode(bytes)
    }

    #[test]
    fn jwt_env_wabi_beats_legacy_and_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("jwt_secret"),
            "file-signing-secret-for-tests-at-least-32-bytes",
        )
        .unwrap();
        assert_eq!(
            resolve_jwt_secret_with(
                Some("wabi-signing-secret-for-tests-at-least-32-bytes".into()),
                Some("legacy-signing-secret-for-tests-at-least-32-bytes".into()),
                dir.path().to_str().unwrap()
            )
            .unwrap(),
            "wabi-signing-secret-for-tests-at-least-32-bytes"
        );
        assert_eq!(
            resolve_jwt_secret_with(
                None,
                Some("legacy-signing-secret-for-tests-at-least-32-bytes".into()),
                dir.path().to_str().unwrap()
            )
            .unwrap(),
            "legacy-signing-secret-for-tests-at-least-32-bytes"
        );
    }

    #[test]
    fn jwt_uses_weak_default_with_warning_when_set() {
        let dir = tempfile::tempdir().unwrap();
        // weak value must win over the persisted file, matching the old behavior
        std::fs::write(
            dir.path().join("jwt_secret"),
            "file-signing-secret-for-tests-at-least-32-bytes",
        )
        .unwrap();
        assert_eq!(
            resolve_jwt_secret_with_policy(
                Some(WEAK_JWT_DEFAULT.into()),
                None,
                dir.path().to_str().unwrap(),
                true
            )
            .unwrap(),
            WEAK_JWT_DEFAULT
        );
    }

    #[test]
    fn jwt_falls_back_to_file_then_generates_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        std::fs::write(
            dir.path().join("jwt_secret"),
            "file-signing-secret-for-tests-at-least-32-bytes\n",
        )
        .unwrap();
        assert_eq!(
            resolve_jwt_secret_with(None, None, data_dir).unwrap(),
            "file-signing-secret-for-tests-at-least-32-bytes"
        );

        let fresh = tempfile::tempdir().unwrap();
        let fresh_dir = fresh.path().to_str().unwrap();
        let generated = resolve_jwt_secret_with(None, None, fresh_dir).unwrap();
        assert!(!generated.is_empty());
        assert_eq!(
            resolve_jwt_secret_with(None, None, fresh_dir).unwrap(),
            generated,
            "must be stable across boots"
        );
    }

    #[test]
    fn missing_jwt_in_existing_community_does_not_regenerate() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("wabidb")).unwrap();
        std::fs::write(dir.path().join("wabidb/root_key"), "original").unwrap();
        assert!(resolve_jwt_secret_with(None, None, dir.path().to_str().unwrap()).is_err());
        assert!(!dir.path().join("jwt_secret").exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("wabidb/root_key")).unwrap(),
            "original"
        );
    }

    #[test]
    fn jwt_retry_accepts_only_regular_first_boot_coordination_files() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("wabidb");
        std::fs::create_dir(&database).unwrap();
        for name in [
            ".lock",
            ".wabi-secret-publication.lock",
            ".wabi-secret-unpublished.tmp",
        ] {
            std::fs::write(database.join(name), "unchanged").unwrap();
        }
        let key = resolve_jwt_secret_with(None, None, dir.path().to_str().unwrap()).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("jwt_secret")).unwrap(),
            key
        );
        assert_eq!(
            std::fs::read_to_string(database.join(".lock")).unwrap(),
            "unchanged"
        );

        for name in [".lock", ".wabi-secret-publication.lock", "unknown-state"] {
            let fresh = tempfile::tempdir().unwrap();
            let database = fresh.path().join("wabidb");
            std::fs::create_dir(&database).unwrap();
            // A coordination-shaped directory is not a coordination file.
            std::fs::create_dir(database.join(name)).unwrap();
            assert!(resolve_jwt_secret_with(None, None, fresh.path().to_str().unwrap()).is_err());
            assert!(!fresh.path().join("jwt_secret").exists());
            assert!(database.join(name).is_dir());
        }
    }

    #[cfg(unix)]
    #[test]
    fn jwt_retry_refuses_symlinked_coordination_files() {
        let fresh = tempfile::tempdir().unwrap();
        let database = fresh.path().join("wabidb");
        std::fs::create_dir(&database).unwrap();
        let target = fresh.path().join("original");
        std::fs::write(&target, "unchanged").unwrap();
        std::os::unix::fs::symlink(&target, database.join(".lock")).unwrap();
        assert!(resolve_jwt_secret_with(None, None, fresh.path().to_str().unwrap()).is_err());
        assert!(!fresh.path().join("jwt_secret").exists());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "unchanged");
    }

    #[test]
    fn root_key_env_wins_over_file() {
        let dir = tempfile::tempdir().unwrap();
        let key = [7u8; 32];
        std::fs::write(dir.path().join("root_key"), hex_key([1u8; 32])).unwrap();
        assert_eq!(
            resolve_root_key_with(Some(&hex_key(key)), dir.path()).unwrap(),
            key
        );
    }

    #[test]
    fn root_key_invalid_env_is_a_hard_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_root_key_with(Some("not-hex"), dir.path()).is_err());
        assert!(resolve_root_key_with(Some(&hex::encode([1u8; 16])), dir.path()).is_err());
        // and nothing was persisted as a side effect
        assert!(!dir.path().join("root_key").exists());
    }

    #[test]
    fn root_key_generates_persists_and_reuses() {
        let dir = tempfile::tempdir().unwrap();
        let first = resolve_root_key_with(None, dir.path()).unwrap();
        let persisted = std::fs::read_to_string(dir.path().join("root_key")).unwrap();
        assert_eq!(persisted.trim(), hex_key(first));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("root_key"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let second = resolve_root_key_with(None, dir.path()).unwrap();
        assert_eq!(first, second, "must be stable across boots");
    }

    #[test]
    fn root_key_corrupt_file_is_a_hard_error() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("root_key"), "zzzz").unwrap();
        assert!(resolve_root_key_with(None, dir.path()).is_err());
        // empty file is equally fatal
        std::fs::write(dir.path().join("root_key"), "").unwrap();
        assert!(resolve_root_key_with(None, dir.path()).is_err());
    }

    #[test]
    fn production_policy_refuses_development_key_from_env_or_file() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("jwt_secret"), WEAK_JWT_DEFAULT).unwrap();
        for (primary, legacy) in [
            (Some(WEAK_JWT_DEFAULT.into()), None),
            (None, Some(WEAK_JWT_DEFAULT.into())),
            (None, None),
        ] {
            assert!(resolve_jwt_secret_with_policy(primary, legacy, data, false).is_err());
        }
        assert_eq!(
            std::fs::read_to_string(dir.path().join("jwt_secret")).unwrap(),
            WEAK_JWT_DEFAULT
        );
        assert_eq!(
            resolve_jwt_secret_with_policy(
                Some("explicit-operator-signing-key-at-least-32-bytes".into()),
                None,
                data,
                false
            )
            .unwrap(),
            "explicit-operator-signing-key-at-least-32-bytes"
        );
    }

    #[test]
    fn production_policy_refuses_short_keys_without_replacing_existing_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().to_str().unwrap();
        let thirty_one_bytes = "x".repeat(31);
        for value in ["", "short-operator-key", thirty_one_bytes.as_str()] {
            assert!(value.len() < 32);
            assert!(resolve_jwt_secret_with_policy(Some(value.into()), None, data, false).is_err());
            std::fs::write(dir.path().join("jwt_secret"), value).unwrap();
            assert!(resolve_jwt_secret_with_policy(None, None, data, false).is_err());
            assert_eq!(
                std::fs::read_to_string(dir.path().join("jwt_secret")).unwrap(),
                value
            );
        }
    }

    #[test]
    fn unsupported_hard_links_publish_one_complete_key_concurrently() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("key");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
        let handles: Vec<_> = (0..4)
            .map(|index| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    read_or_create_secret_with_link(
                        &path,
                        || {
                            barrier.wait();
                            format!("fallback-key-{index}")
                        },
                        |_, _| Err(io::Error::from(io::ErrorKind::Unsupported)),
                    )
                    .unwrap()
                })
            })
            .collect();
        let keys: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert!(keys.iter().all(|key| key == &keys[0]));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), keys[0]);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn publication_io_errors_do_not_fall_back_or_leave_an_unpersisted_key() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("key");
        assert!(read_or_create_secret_with_link(
            &path,
            || "never-published".into(),
            |_, _| Err(io::Error::from(io::ErrorKind::Other))
        )
        .is_err());
        assert!(!path.exists());
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }
}
