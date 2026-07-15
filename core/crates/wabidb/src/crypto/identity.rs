use crate::error::{Result, WabiError};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use std::collections::HashMap;

#[cfg(test)]
use ed25519_dalek::Signer;

/// A device-level identity key used for trust-on-first-use (TOFU) and
/// signed prekey attestation.
#[derive(Debug, Clone)]
pub struct IdentityKey {
    /// The Wabi user ID that owns this device.
    pub user_id: u64,
    /// A device-scoped identifier (unique within the user's device set).
    pub device_id: String,
    /// Ed25519 public key (32 bytes) for verifying signed attestations.
    pub signing_public_key: [u8; 32],
    /// Creation timestamp in microseconds since Unix epoch.
    pub created_at_micros: i64,
    /// Optional expiration timestamp in microseconds since Unix epoch.
    pub expires_at_micros: Option<i64>,
}

/// An in-memory registry of identity keys, keyed by `(user_id, device_id)`.
///
/// Provides CRUD operations and is the canonical source for Ed25519
/// public keys used in [`SignedDeviceAttestation`] verification.
#[derive(Debug, Default)]
pub struct IdentityRegistry {
    keys: HashMap<(u64, String), IdentityKey>,
}

impl IdentityRegistry {
    pub fn new() -> Self {
        Self {
            keys: HashMap::new(),
        }
    }

    /// Register a new device identity key.
    ///
    /// If a key for the same `(user_id, device_id)` already exists, it is
    /// replaced (the previous key is effectively rotated).
    pub fn register(&mut self, key: IdentityKey) {
        let k = (key.user_id, key.device_id.clone());
        self.keys.insert(k, key);
    }

    /// Look up an identity key by `(user_id, device_id)`.
    pub fn get(&self, user_id: u64, device_id: &str) -> Option<&IdentityKey> {
        self.keys.get(&(user_id, device_id.to_string()))
    }

    /// Rotate the signing public key for an existing device identity.
    ///
    /// Returns `Ok(())` if the device exists and the key was updated.
    /// Returns `Err(WabiError::UnknownStreamKey { .. })` if the device
    /// is not registered.
    pub fn rotate_signing_key(
        &mut self,
        user_id: u64,
        device_id: &str,
        new_public_key: [u8; 32],
    ) -> Result<()> {
        let key = self.keys.get_mut(&(user_id, device_id.to_string())).ok_or(
            WabiError::UnknownStreamKey {
                key_id: format!("{user_id}:{device_id}"),
            },
        )?;
        key.signing_public_key = new_public_key;
        Ok(())
    }

    /// Expire (remove) a device identity key.
    pub fn expire(&mut self, user_id: u64, device_id: &str) {
        self.keys.remove(&(user_id, device_id.to_string()));
    }

    /// Check whether a device identity key exists in the registry.
    pub fn contains(&self, user_id: u64, device_id: &str) -> bool {
        self.keys.contains_key(&(user_id, device_id.to_string()))
    }
}

/// A signed attestation from a device, proving possession of an identity key.
///
/// The signature covers `(identity_key_hash || device_id || payload)` using
/// the device's Ed25519 signing key.
#[derive(Debug, Clone)]
pub struct SignedDeviceAttestation {
    /// BLAKE3 hash of the device's identity key (the Ed25519 public key bytes).
    pub identity_key_hash: [u8; 32],
    /// The device ID (matches the `device_id` in the corresponding `IdentityKey`).
    pub device_id: String,
    /// The attestation payload (opaque bytes signed by the device).
    pub payload: Vec<u8>,
    /// Ed25519 signature of `(identity_key_hash || device_id.as_bytes() || payload)`.
    pub signature: [u8; 64],
}

/// Verify an Ed25519-signed device attestation against an identity key.
///
/// # Arguments
///
/// * `registry` - The identity registry containing the device's public key.
/// * `user_id` - The Wabi user ID that owns the device.
/// * `attestation` - The signed attestation to verify.
///
/// # Errors
///
/// Returns `WabiError::DeviceRevoked` if the device is not found in the registry.
/// Returns `WabiError::SignatureVerificationFailed` if the signature does not
/// verify against the stored public key.
pub fn verify_attestation(
    registry: &IdentityRegistry,
    user_id: u64,
    attestation: &SignedDeviceAttestation,
) -> Result<()> {
    let key = registry
        .get(user_id, &attestation.device_id)
        .ok_or_else(|| WabiError::DeviceRevoked)?;

    let mut msg = Vec::with_capacity(attestation.identity_key_hash.len() + attestation.device_id.len() + attestation.payload.len());
    msg.extend_from_slice(&attestation.identity_key_hash);
    msg.extend_from_slice(attestation.device_id.as_bytes());
    msg.extend_from_slice(&attestation.payload);

    let public_key = VerifyingKey::from_bytes(&key.signing_public_key)
        .map_err(|_| WabiError::SignatureVerificationFailed)?;

    let sig = Signature::from_bytes(&attestation.signature);

    public_key
        .verify(&msg, &sig)
        .map_err(|_| WabiError::SignatureVerificationFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use rand::Rng;

    fn make_signing_key() -> SigningKey {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill(&mut bytes);
        SigningKey::from_bytes(&bytes)
    }

    fn hash_public_key(pk: &[u8; 32]) -> [u8; 32] {
        *blake3::hash(pk).as_bytes()
    }

    fn sign_message(sk: &SigningKey, msg: &[u8]) -> [u8; 64] {
        sk.sign(msg).to_bytes()
    }

    #[test]
    fn register_and_get() {
        let mut reg = IdentityRegistry::new();
        let sk = make_signing_key();
        let pk = sk.verifying_key().to_bytes();

        let key = IdentityKey {
            user_id: 1,
            device_id: "dev_abc".into(),
            signing_public_key: pk,
            created_at_micros: 1000,
            expires_at_micros: None,
        };
        reg.register(key);

        let retrieved = reg.get(1, "dev_abc").unwrap();
        assert_eq!(retrieved.user_id, 1);
        assert_eq!(retrieved.device_id, "dev_abc");
        assert_eq!(retrieved.signing_public_key, pk);
    }

    #[test]
    fn rotate_signing_key() {
        let mut reg = IdentityRegistry::new();
        let sk1 = make_signing_key();
        let pk1 = sk1.verifying_key().to_bytes();
        let sk2 = make_signing_key();
        let pk2 = sk2.verifying_key().to_bytes();

        reg.register(IdentityKey {
            user_id: 1,
            device_id: "dev_abc".into(),
            signing_public_key: pk1,
            created_at_micros: 1000,
            expires_at_micros: None,
        });

        reg.rotate_signing_key(1, "dev_abc", pk2).unwrap();
        let retrieved = reg.get(1, "dev_abc").unwrap();
        assert_eq!(retrieved.signing_public_key, pk2);
    }

    #[test]
    fn expire_removes_key() {
        let mut reg = IdentityRegistry::new();
        let sk = make_signing_key();
        let pk = sk.verifying_key().to_bytes();

        reg.register(IdentityKey {
            user_id: 1,
            device_id: "dev_abc".into(),
            signing_public_key: pk,
            created_at_micros: 1000,
            expires_at_micros: None,
        });

        assert!(reg.contains(1, "dev_abc"));
        reg.expire(1, "dev_abc");
        assert!(!reg.contains(1, "dev_abc"));
    }

    #[test]
    fn verify_valid_signature() {
        let mut reg = IdentityRegistry::new();
        let sk = make_signing_key();
        let pk = sk.verifying_key().to_bytes();

        let device_id = "dev_valid".to_string();
        let payload = b"attestation payload".to_vec();
        let identity_key_hash = hash_public_key(&pk);

        let mut msg = Vec::new();
        msg.extend_from_slice(&identity_key_hash);
        msg.extend_from_slice(device_id.as_bytes());
        msg.extend_from_slice(&payload);
        let signature = sign_message(&sk, &msg);

        reg.register(IdentityKey {
            user_id: 1,
            device_id: device_id.clone(),
            signing_public_key: pk,
            created_at_micros: 1000,
            expires_at_micros: None,
        });

        let attestation = SignedDeviceAttestation {
            identity_key_hash,
            device_id,
            payload,
            signature,
        };

        assert!(verify_attestation(&reg, 1, &attestation).is_ok());
    }

    #[test]
    fn verify_tampered_signature_rejected() {
        let mut reg = IdentityRegistry::new();
        let sk = make_signing_key();
        let pk = sk.verifying_key().to_bytes();

        let device_id = "dev_tampered".to_string();
        let payload = b"attestation payload".to_vec();
        let identity_key_hash = hash_public_key(&pk);

        let mut msg = Vec::new();
        msg.extend_from_slice(&identity_key_hash);
        msg.extend_from_slice(device_id.as_bytes());
        msg.extend_from_slice(&payload);
        let signature = sign_message(&sk, &msg);

        // Tamper with the signature
        let mut bad_sig = signature;
        bad_sig[0] ^= 0xFF;

        reg.register(IdentityKey {
            user_id: 1,
            device_id: device_id.clone(),
            signing_public_key: pk,
            created_at_micros: 1000,
            expires_at_micros: None,
        });

        let attestation = SignedDeviceAttestation {
            identity_key_hash,
            device_id,
            payload,
            signature: bad_sig,
        };

        let err = verify_attestation(&reg, 1, &attestation).unwrap_err();
        assert!(
            matches!(err, WabiError::SignatureVerificationFailed),
            "expected SignatureVerificationFailed, got {err:?}"
        );
    }

    #[test]
    fn verify_unknown_identity_rejected() {
        let reg = IdentityRegistry::new();
        let sk = make_signing_key();
        let pk = sk.verifying_key().to_bytes();

        let identity_key_hash = hash_public_key(&pk);
        let device_id = "unknown_dev".to_string();
        let payload = b"data".to_vec();
        let signature = [0u8; 64];

        let attestation = SignedDeviceAttestation {
            identity_key_hash,
            device_id,
            payload,
            signature,
        };

        let err = verify_attestation(&reg, 99, &attestation).unwrap_err();
        assert!(
            matches!(err, WabiError::DeviceRevoked),
            "expected DeviceRevoked, got {err:?}"
        );
    }

    #[test]
    fn verify_wrong_payload_rejected() {
        let mut reg = IdentityRegistry::new();
        let sk = make_signing_key();
        let pk = sk.verifying_key().to_bytes();

        let device_id = "dev_wrong_payload".to_string();
        let payload = b"real payload".to_vec();
        let identity_key_hash = hash_public_key(&pk);

        let mut msg = Vec::new();
        msg.extend_from_slice(&identity_key_hash);
        msg.extend_from_slice(device_id.as_bytes());
        msg.extend_from_slice(&payload);
        let signature = sign_message(&sk, &msg);

        reg.register(IdentityKey {
            user_id: 1,
            device_id: device_id.clone(),
            signing_public_key: pk,
            created_at_micros: 1000,
            expires_at_micros: None,
        });

        // Present a different payload
        let wrong_payload = b"different payload".to_vec();
        let attestation = SignedDeviceAttestation {
            identity_key_hash,
            device_id,
            payload: wrong_payload,
            signature,
        };

        let err = verify_attestation(&reg, 1, &attestation).unwrap_err();
        assert!(
            matches!(err, WabiError::SignatureVerificationFailed),
            "expected SignatureVerificationFailed, got {err:?}"
        );
    }
}
