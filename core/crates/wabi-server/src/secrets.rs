//! First-boot secret resolution.
//!
//! Wabi boots with zero required configuration: any missing secret is
//! generated for a fresh database and persisted inside the data directory so a
//! plain `wabi-server` (or `docker compose up`) starts turnkey. Explicit
//! environment variables always win over persisted files, so operators who
//! manage secrets externally keep full control.
//!
//! Resolution order for both secrets: environment variable > persisted file
//! in the data dir > freshly generated + persisted. A persisted file that
//! exists but is corrupt is a hard error — silently regenerating a key would
//! make existing encrypted data permanently unreadable. A missing root key or
//! manifest in an existing database is also a hard error, not a new first boot.

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
    for value in [wabi_key, legacy_key].into_iter().flatten() {
        if value == WEAK_JWT_DEFAULT {
            tracing::warn!(
                "[security] JWT key is set to the weak built-in default; set a strong secret"
            );
            return Ok(value);
        }
        return Ok(value);
    }
    let secret = read_or_create_secret(&Path::new(data_dir).join("jwt_secret"), || {
        format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4())
    })?;
    let secret = secret.trim();
    if secret.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "persisted jwt_secret is empty; restore it or configure an explicit signing key",
        ));
    }
    Ok(secret.to_string())
}

/// Never overwrite an unreadable/existing key or boot with an unpersisted one.
/// Exclusive creation also prevents two first boots from replacing each other's keys.
fn read_or_create_secret(path: &Path, generate: impl FnOnce() -> String) -> io::Result<String> {
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
        // Publish only complete bytes, without replacing a concurrent winner.
        // Both paths are in one directory, so this link cannot cross filesystems.
        match std::fs::hard_link(&temporary, path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return std::fs::read_to_string(path)
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
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
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
        std::fs::write(dir.path().join("jwt_secret"), "file-secret").unwrap();
        assert_eq!(
            resolve_jwt_secret_with(
                Some("wabi-secret".into()),
                Some("legacy-secret".into()),
                dir.path().to_str().unwrap()
            )
            .unwrap(),
            "wabi-secret"
        );
        assert_eq!(
            resolve_jwt_secret_with(
                None,
                Some("legacy-secret".into()),
                dir.path().to_str().unwrap()
            )
            .unwrap(),
            "legacy-secret"
        );
    }

    #[test]
    fn jwt_uses_weak_default_with_warning_when_set() {
        let dir = tempfile::tempdir().unwrap();
        // weak value must win over the persisted file, matching the old behavior
        std::fs::write(dir.path().join("jwt_secret"), "file-secret").unwrap();
        assert_eq!(
            resolve_jwt_secret_with(
                Some(WEAK_JWT_DEFAULT.into()),
                None,
                dir.path().to_str().unwrap()
            )
            .unwrap(),
            WEAK_JWT_DEFAULT
        );
    }

    #[test]
    fn jwt_falls_back_to_file_then_generates_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("jwt_secret"), "file-secret\n").unwrap();
        assert_eq!(
            resolve_jwt_secret_with(None, None, data_dir).unwrap(),
            "file-secret"
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
}
