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

use std::path::Path;

const WEAK_JWT_DEFAULT: &str = "dev-secret-change-in-production";

/// Resolve the JWT signing secret.
///
/// Priority: `WABI_JWT_KEY` env > `JWT_SECRET` env (legacy alias) >
/// persisted `<data_dir>/jwt_secret` > freshly generated + persisted.
/// We never fall back to a hardcoded weak default, because a known secret
/// lets anyone forge tokens for any user (including the owner).
pub fn resolve_jwt_secret(data_dir: &str) -> String {
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
) -> String {
    for value in [wabi_key, legacy_key].into_iter().flatten() {
        if value == WEAK_JWT_DEFAULT {
            tracing::warn!("[security] JWT key is set to the weak built-in default; set a strong secret");
            return value;
        }
        return value;
    }
    let path = Path::new(data_dir).join("jwt_secret");
    if let Ok(s) = std::fs::read_to_string(&path) {
        let t = s.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    let secret = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
    if let Err(e) = std::fs::write(&path, &secret) {
        tracing::warn!("[security] failed to persist jwt_secret: {e}");
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        tracing::info!("[security] generated and persisted a new jwt_secret to {path:?}");
    }
    secret
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

fn resolve_root_key_with(env_value: Option<&str>, data_dir: &Path) -> wabidb::error::Result<[u8; 32]> {
    if let Some(env) = env_value {
        return decode_root_key_hex(env).map_err(|e| wabidb::error::WabiError::Validation {
            command: "resolve_root_key".into(),
            reason: format!("invalid {}: {e}", wabidb::crypto::bootstrap::ENV_VAR_NAME),
        });
    }
    let path = data_dir.join("root_key");
    if let Ok(s) = std::fs::read_to_string(&path) {
        let t = s.trim();
        if t.is_empty() {
            return Err(wabidb::error::WabiError::Validation {
                command: "resolve_root_key".into(),
                reason: format!(
                    "root key file {path:?} is empty; delete it to regenerate (existing encrypted data will be unreadable) or restore it from backup"
                ),
            });
        }
        return decode_root_key_hex(t).map_err(|e| {
            wabidb::error::WabiError::Validation {
                command: "resolve_root_key".into(),
                reason: format!(
                    "root key file {path:?} is corrupt ({e}); restore it from backup — regenerating would make existing data unreadable"
                ),
            }
        });
    }
    let mut key = [0u8; 32];
    use rand::RngCore;
    rand::thread_rng().fill_bytes(&mut key);
    std::fs::create_dir_all(data_dir)?;
    std::fs::write(&path, format!("{}\n", hex::encode(key)))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    tracing::warn!(
        "[security] generated a new WabiDB root key at {path:?}. BACK THIS UP: it is required to read this server's data and is NOT recoverable from anywhere else"
    );
    Ok(key)
}

fn decode_root_key_hex(value: &str) -> Result<[u8; 32], String> {
    let bytes = hex::decode(value).map_err(|e| e.to_string())?;
    if bytes.len() != 32 {
        return Err(format!("expected 64 hex chars (32 bytes), got {} bytes", bytes.len()));
    }
    let arr: [u8; 32] = bytes.try_into().expect("length checked above");
    Ok(arr)
}

#[cfg(test)]
mod tests {
    use super::*;

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
            ),
            "wabi-secret"
        );
        assert_eq!(
            resolve_jwt_secret_with(None, Some("legacy-secret".into()), dir.path().to_str().unwrap()),
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
            ),
            WEAK_JWT_DEFAULT
        );
    }

    #[test]
    fn jwt_falls_back_to_file_then_generates_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        std::fs::write(dir.path().join("jwt_secret"), "file-secret\n").unwrap();
        assert_eq!(resolve_jwt_secret_with(None, None, data_dir), "file-secret");

        let fresh = tempfile::tempdir().unwrap();
        let fresh_dir = fresh.path().to_str().unwrap();
        let generated = resolve_jwt_secret_with(None, None, fresh_dir);
        assert!(!generated.is_empty());
        assert_eq!(resolve_jwt_secret_with(None, None, fresh_dir), generated, "must be stable across boots");
    }

    #[test]
    fn root_key_env_wins_over_file() {
        let dir = tempfile::tempdir().unwrap();
        let key = [7u8; 32];
        std::fs::write(dir.path().join("root_key"), hex_key([1u8; 32])).unwrap();
        assert_eq!(resolve_root_key_with(Some(&hex_key(key)), dir.path()).unwrap(), key);
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
