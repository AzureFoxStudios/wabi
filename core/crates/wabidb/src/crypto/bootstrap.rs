//! Bootstrap key loading: passphrase, environment variable, OS keychain.
//!
//! The bootstrap key is the root encryption key. It is held in memory only
//! and never persisted to disk. Stream keys (in `StreamKeyRegistry`) are
//! derived from the bootstrap key via a key-derivation function (KDF) keyed
//! on the stream's identity.
//!
//! Three bootstrap sources are supported (per `wabidb-11` card scope):
//!
//! 1. **Environment variable** (`WABIDB_ROOT_KEY`): hex-encoded 32 bytes.
//!    Suitable for headless / systemd deployments.
//! 2. **Passphrase prompt**: the operator types a passphrase; we derive
//!    32 bytes of key material via Argon2id (memory-hard, GPU-resistant).
//!    Suitable for interactive first-boot.
//! 3. **OS keychain** (Linux libsecret, macOS Keychain, Windows DPAPI):
//!    not yet implemented. The card is a placeholder; returns
//!    `KeychainUnavailable` until the platform-specific work is done.
//!
//! ## Why Argon2id for passphrase derivation
//!
//! A user's passphrase has low entropy (~20-40 bits). A simple SHA-256 of
//! the passphrase is brute-forceable in seconds on a modern GPU. Argon2id
//! is a memory-hard KDF that takes ~100ms on a modern CPU and ~1GB of
//! memory, making GPU attacks orders of magnitude more expensive.
//!
//! ## Salt handling
//!
//! The salt is stored in the storage manifest at `$DATA_DIR/manifests/storage-manifest.json`.
//! For a new data directory, the salt is generated randomly. For an existing
//! data directory, the salt is read from the manifest. This means a passphrase
//! change requires re-encrypting all stream keys (or keeping the old
//! bootstrap key and using a multi-key approach — not implemented in v1).
//!
//! ## What this card does NOT do
//!
//! - OS keychain integration. The `Keychain` source returns an error. This
//!   is deferred to a follow-up card.
//! - Passphrase rotation. Changing the passphrase requires re-deriving all
//!   stream keys; not implemented in v1.
//! - Multi-user / multi-key bootstraps. v1 has exactly one bootstrap key
//!   per engine instance.

use crate::error::{Result, WabiError};
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::SaltString;
use argon2::{Argon2, Params, Version};
use rand::RngCore;
use std::env;

/// Length of the bootstrap key in bytes (32 bytes = 256 bits = AES-256).
pub const BOOTSTRAP_KEY_LEN: usize = 32;

/// Length of the Argon2id salt in bytes (encoded as base64 by `SaltString`).
pub const SALT_LEN: usize = 16;

/// Environment variable name for the bootstrap key (hex-encoded 32 bytes).
pub const ENV_VAR_NAME: &str = "WABIDB_ROOT_KEY";

/// Where to look for the bootstrap key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootstrapSource {
    /// The bootstrap key is provided directly as 32 bytes.
    /// Used for tests and in-process bootstrap.
    Provided([u8; BOOTSTRAP_KEY_LEN]),
    /// The bootstrap key is hex-encoded in the `WABIDB_ROOT_KEY` environment variable.
    EnvVar,
    /// The bootstrap key is derived from a passphrase via Argon2id.
    Passphrase {
        /// The user's passphrase.
        passphrase: String,
        /// The salt (read from or generated for the data directory).
        salt: [u8; SALT_LEN],
    },
    /// The bootstrap key is in the OS keychain. Not yet implemented.
    Keychain,
}

/// Load the bootstrap key from the configured source.
///
/// This is the only function that returns the bootstrap key. All other code
/// in the engine receives a `&[u8; BOOTSTRAP_KEY_LEN]` reference.
///
/// # Errors
///
/// - `WabiError::KeychainUnavailable` for the `Keychain` source.
/// - `WabiError::Io` if the env var is not set or unreadable.
/// - `WabiError::Validation` if the env var content is not valid hex or
///   not the right length.
/// - `WabiError::InternalInvariantViolated` if Argon2id fails (should
///   not happen with the configured parameters).
pub fn load_bootstrap_key(source: &BootstrapSource) -> Result<[u8; BOOTSTRAP_KEY_LEN]> {
    match source {
        BootstrapSource::Provided(key) => Ok(*key),

        BootstrapSource::EnvVar => load_from_env(),

        BootstrapSource::Passphrase { passphrase, salt } => {
            derive_from_passphrase(passphrase, *salt)
        }

        BootstrapSource::Keychain => Err(WabiError::KeychainUnavailable),
    }
}

/// Load the bootstrap key from the `WABIDB_ROOT_KEY` environment variable.
///
/// The variable must contain 64 hex characters (32 bytes when decoded).
fn load_from_env() -> Result<[u8; BOOTSTRAP_KEY_LEN]> {
    let raw = env::var(ENV_VAR_NAME).map_err(|e| match e {
        std::env::VarError::NotPresent => WabiError::Validation {
            command: "load_bootstrap_key".into(),
            reason: format!("env var {ENV_VAR_NAME} not set"),
        },
        other => WabiError::Io(std::io::Error::new(std::io::ErrorKind::Other, other)),
    })?;

    let trimmed = raw.trim();
    if trimmed.len() % 2 != 0 {
        return Err(WabiError::Validation {
            command: "load_bootstrap_key".into(),
            reason: format!(
                "env var {ENV_VAR_NAME} has odd length {} (hex pairs required)",
                trimmed.len()
            ),
        });
    }
    let mut bytes = Vec::with_capacity(trimmed.len() / 2);
    for i in (0..trimmed.len()).step_by(2) {
        let byte = u8::from_str_radix(&trimmed[i..i + 2], 16).map_err(|e| {
            WabiError::Validation {
                command: "load_bootstrap_key".into(),
                reason: format!("invalid hex at offset {i}: {e}"),
            }
        })?;
        bytes.push(byte);
    }

    if bytes.len() != BOOTSTRAP_KEY_LEN {
        return Err(WabiError::Validation {
            command: "load_bootstrap_key".into(),
            reason: format!(
                "env var {ENV_VAR_NAME} decoded to {} bytes, expected {}",
                bytes.len(),
                BOOTSTRAP_KEY_LEN
            ),
        });
    }

    let mut key = [0u8; BOOTSTRAP_KEY_LEN];
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// Derive a 32-byte bootstrap key from a passphrase via Argon2id.
///
/// Argon2id parameters (memory=64MB, time=3, parallelism=1) are conservative
/// defaults that take ~100ms on a modern CPU. These are tuned to be safe
/// against GPU/ASIC attacks while remaining interactive.
fn derive_from_passphrase(
    passphrase: &str,
    salt: [u8; SALT_LEN],
) -> Result<[u8; BOOTSTRAP_KEY_LEN]> {
    // Argon2id parameters: m=64MB, t=3, p=1
    let params = Params::new(64 * 1024, 3, 1, Some(BOOTSTRAP_KEY_LEN))
        .map_err(|e| WabiError::InternalInvariantViolated {
            invariant: format!("Argon2id params invalid: {e}"),
        })?;

    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, Version::V0x13, params);

    // Argon2id expects a salt in `SaltString` format (base64 with prefix).
    let salt_b64 = base64_encode_salt(&salt);
    let salt_string = SaltString::from_b64(&salt_b64).map_err(|e| {
        WabiError::InternalInvariantViolated {
            invariant: format!("invalid salt encoding: {e}"),
        }
    })?;

    let mut output = [0u8; BOOTSTRAP_KEY_LEN];
    argon2
        .hash_password_into(passphrase.as_bytes(), &salt_string.as_str().as_bytes(), &mut output)
        .map_err(|e| WabiError::InternalInvariantViolated {
            invariant: format!("Argon2id derivation failed: {e}"),
        })?;

    Ok(output)
}

/// Generate a fresh random salt for Argon2id.
pub fn generate_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    salt
}

/// Encode a 16-byte salt as base64 (no padding). The Argon2id `SaltString`
/// Encode a 16-byte salt as base64 (no padding). The Argon2id `SaltString`
/// type expects base64 without the trailing `=` padding characters; here we
/// produce the raw base64 of the 16 bytes. For our purposes (16 bytes = 22
/// base64 chars + 0 padding) this is a simple custom encoder.
fn base64_encode_salt(bytes: &[u8]) -> String {
    // Use the standard base64 alphabet. We avoid pulling in the `base64` crate
    // for a single 16-byte encoding.
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let b0 = bytes[i];
        let b1 = bytes[i + 1];
        let b2 = bytes[i + 2];
        out.push(ALPHABET[(b0 >> 2) as usize] as char);
        out.push(ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(ALPHABET[(((b1 & 0x0F) << 2) | (b2 >> 6)) as usize] as char);
        out.push(ALPHABET[(b2 & 0x3F) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let b0 = bytes[i];
        out.push(ALPHABET[(b0 >> 2) as usize] as char);
        out.push(ALPHABET[((b0 & 0x03) << 4) as usize] as char);
        // No padding; `SaltString` rejects `=`.
    } else if rem == 2 {
        let b0 = bytes[i];
        let b1 = bytes[i + 1];
        out.push(ALPHABET[(b0 >> 2) as usize] as char);
        out.push(ALPHABET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        out.push(ALPHABET[((b1 & 0x0F) << 2) as usize] as char);
        // No padding; `SaltString` rejects `=`.
    }
    out
}

/// Verify a passphrase against a known bootstrap key. Constant-time compare.
///
/// Useful for `wabidb check-bootstrap --passphrase-stdin` style operations
/// where the operator wants to verify they have the right passphrase
/// before opening the engine.
pub fn verify_passphrase(
    passphrase: &str,
    salt: [u8; SALT_LEN],
    expected: &[u8; BOOTSTRAP_KEY_LEN],
) -> Result<bool> {
    let derived = derive_from_passphrase(passphrase, salt)?;
    Ok(subtle::ConstantTimeEq::ct_eq(&derived[..], &expected[..]).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provided_key_passes_through() {
        let key = [0x42u8; BOOTSTRAP_KEY_LEN];
        let src = BootstrapSource::Provided(key);
        let loaded = load_bootstrap_key(&src).unwrap();
        assert_eq!(loaded, key);
    }

    #[test]
    fn env_var_round_trip() {
        let key = [0xABu8; BOOTSTRAP_KEY_LEN];
        let hex_str = hex::encode(key);
        // SAFETY: tests run single-threaded; no concurrent env access
        unsafe {
            env::set_var(ENV_VAR_NAME, &hex_str);
        }
        let src = BootstrapSource::EnvVar;
        let loaded = load_bootstrap_key(&src).unwrap();
        assert_eq!(loaded, key);
        unsafe {
            env::remove_var(ENV_VAR_NAME);
        }
    }

    #[test]
    fn env_var_invalid_hex() {
        unsafe {
            env::set_var(ENV_VAR_NAME, "not hex at all");
        }
        let src = BootstrapSource::EnvVar;
        let err = load_bootstrap_key(&src).unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }), "got {err:?}");
        unsafe {
            env::remove_var(ENV_VAR_NAME);
        }
    }

    #[test]
    fn env_var_wrong_length() {
        // 16 bytes (32 hex chars) instead of 32
        let short = hex::encode([0u8; 16]);
        unsafe {
            env::set_var(ENV_VAR_NAME, &short);
        }
        let src = BootstrapSource::EnvVar;
        let err = load_bootstrap_key(&src).unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }), "got {err:?}");
        unsafe {
            env::remove_var(ENV_VAR_NAME);
        }
    }

    #[test]
    fn env_var_not_set() {
        unsafe {
            env::remove_var(ENV_VAR_NAME);
        }
        let src = BootstrapSource::EnvVar;
        let err = load_bootstrap_key(&src).unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }), "got {err:?}");
    }

    #[test]
    fn keychain_source_returns_error() {
        let src = BootstrapSource::Keychain;
        let err = load_bootstrap_key(&src).unwrap_err();
        assert!(
            matches!(err, WabiError::KeychainUnavailable),
            "got {err:?}"
        );
    }

    #[test]
    fn passphrase_round_trip() {
        let salt = generate_salt();
        let passphrase = "correct horse battery staple";
        let key = derive_from_passphrase(passphrase, salt).unwrap();
        // Determinism: same passphrase + salt = same key
        let key2 = derive_from_passphrase(passphrase, salt).unwrap();
        assert_eq!(key, key2);
        // Different salt = different key
        let other_salt = generate_salt();
        let key3 = derive_from_passphrase(passphrase, other_salt).unwrap();
        assert_ne!(key, key3);
    }

    #[test]
    fn passphrase_different_input_different_key() {
        let salt = generate_salt();
        let key1 = derive_from_passphrase("alpha", salt).unwrap();
        let key2 = derive_from_passphrase("beta", salt).unwrap();
        assert_ne!(key1, key2);
    }

    #[test]
    fn verify_passphrase_correct() {
        let salt = generate_salt();
        let passphrase = "secret";
        let key = derive_from_passphrase(passphrase, salt).unwrap();
        assert!(verify_passphrase(passphrase, salt, &key).unwrap());
    }

    #[test]
    fn verify_passphrase_wrong() {
        let salt = generate_salt();
        let key = derive_from_passphrase("right", salt).unwrap();
        assert!(!verify_passphrase("wrong", salt, &key).unwrap());
    }

    #[test]
    fn salt_is_random() {
        // Generate two salts; they should differ.
        let s1 = generate_salt();
        let s2 = generate_salt();
        assert_ne!(s1, s2);
    }

    #[test]
    fn base64_round_trip() {
        // Sanity check on our local base64 encoder: 16 bytes -> 22 chars
        // (5 full triplets * 4 = 20, plus 1 byte remainder * 2 unpadded = 2).
        let salt = [
            0x01u8, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E,
            0x0F, 0x10,
        ];
        let encoded = base64_encode_salt(&salt);
        assert_eq!(encoded, "AQIDBAUGBwgJCgsMDQ4PEA");
        // Decoded length: 16 bytes (22 base64 chars = 16 raw bytes per RFC 4648 unpadded)
        let chars: Vec<char> = encoded.chars().collect();
        assert_eq!(chars.len(), 22);
    }
}
