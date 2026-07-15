//! Mandatory snapshot encryption.
//!
//! Full standby snapshots contain sensitive server state, so this module does
//! not expose a plaintext/insecure mode. Tests use encrypted fixture payloads
//! too; debugging should inspect manifests and hashes, not raw backup dumps.

use age::{secrecy::ExposeSecret, Decryptor, Encryptor};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::io::{Read, Write};
use thiserror::Error;

pub const SNAPSHOT_ENCRYPTION_ALGORITHM: &str = "age-x25519-v1";

#[derive(Debug, Error)]
#[allow(dead_code)]
pub enum SnapshotCryptoError {
    #[error("invalid age recipient: {0}")]
    InvalidRecipient(String),
    #[error("invalid age identity: {0}")]
    InvalidIdentity(String),
    #[error("encryption failed: {0}")]
    Encrypt(String),
    #[error("decryption failed: {0}")]
    Decrypt(String),
    #[error("encrypted payload was not valid base64: {0}")]
    Base64(String),
}

#[allow(dead_code)]
pub fn generate_standby_identity() -> age::x25519::Identity {
    age::x25519::Identity::generate()
}

#[allow(dead_code)]
pub fn identity_to_string(identity: &age::x25519::Identity) -> String {
    identity.to_string().expose_secret().to_string()
}

#[allow(dead_code)]
pub fn recipient_to_string(identity: &age::x25519::Identity) -> String {
    identity.to_public().to_string()
}

pub fn encrypt_to_recipient_b64(
    plaintext: &[u8],
    recipient: &str,
) -> Result<String, SnapshotCryptoError> {
    let recipient = recipient
        .parse::<age::x25519::Recipient>()
        .map_err(|error| SnapshotCryptoError::InvalidRecipient(error.to_string()))?;
    let encryptor = Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))
        .map_err(|error| SnapshotCryptoError::Encrypt(error.to_string()))?;
    let mut encrypted = Vec::new();
    {
        let mut writer = encryptor
            .wrap_output(&mut encrypted)
            .map_err(|error| SnapshotCryptoError::Encrypt(error.to_string()))?;
        writer
            .write_all(plaintext)
            .map_err(|error| SnapshotCryptoError::Encrypt(error.to_string()))?;
        writer
            .finish()
            .map_err(|error| SnapshotCryptoError::Encrypt(error.to_string()))?;
    }
    Ok(BASE64.encode(encrypted))
}

#[allow(dead_code)]
pub fn decrypt_from_identity_b64(
    encrypted_b64: &str,
    identity: &str,
) -> Result<Vec<u8>, SnapshotCryptoError> {
    let encrypted = BASE64
        .decode(encrypted_b64)
        .map_err(|error| SnapshotCryptoError::Base64(error.to_string()))?;
    let identity = identity
        .parse::<age::x25519::Identity>()
        .map_err(|error| SnapshotCryptoError::InvalidIdentity(error.to_string()))?;
    let decryptor = Decryptor::new(&encrypted[..])
        .map_err(|error| SnapshotCryptoError::Decrypt(error.to_string()))?;
    if decryptor.is_scrypt() {
        return Err(SnapshotCryptoError::Decrypt(
            "unsupported passphrase snapshot".into(),
        ));
    }
    let mut reader = decryptor
        .decrypt(std::iter::once(&identity as &dyn age::Identity))
        .map_err(|error| SnapshotCryptoError::Decrypt(error.to_string()))?;
    let mut plaintext = Vec::new();
    reader
        .read_to_end(&mut plaintext)
        .map_err(|error| SnapshotCryptoError::Decrypt(error.to_string()))?;
    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn age_snapshot_encryption_roundtrips() {
        let identity = generate_standby_identity();
        let identity_text = identity_to_string(&identity);
        let recipient_text = recipient_to_string(&identity);

        let encrypted = encrypt_to_recipient_b64(b"standby snapshot fixture", &recipient_text)
            .expect("encrypt fixture");
        assert!(!encrypted.contains("standby snapshot fixture"));

        let decrypted =
            decrypt_from_identity_b64(&encrypted, &identity_text).expect("decrypt fixture");
        assert_eq!(decrypted, b"standby snapshot fixture");
    }
}
