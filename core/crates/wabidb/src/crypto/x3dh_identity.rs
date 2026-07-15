use crate::crypto::identity::{IdentityKey, IdentityRegistry, SignedDeviceAttestation};
use crate::error::{Result, WabiError};
use ed25519_dalek::{Signer, SigningKey};
use rand::Rng;
use std::sync::Mutex;
use x25519_dalek::{PublicKey, StaticSecret};

const BOOTSTRAP_USER_ID: u64 = 0;
const INITIAL_PREKEY_COUNT: usize = 100;

/// A one-time prekey for X3DH handshake.
#[derive(Debug, Clone)]
pub struct OneTimePreKey {
    pub prekey_id: String,
    pub x25519_public: [u8; 32],
    pub signature: [u8; 64],
}

/// Internal prekey with private key material.
#[derive(Clone)]
struct InternalPreKey {
    prekey_id: String,
    public: [u8; 32],
    signature: [u8; 64],
}

impl InternalPreKey {
    fn to_public(&self) -> OneTimePreKey {
        OneTimePreKey {
            prekey_id: self.prekey_id.clone(),
            x25519_public: self.public,
            signature: self.signature,
        }
    }
}

/// Internal signed prekey with private key material.
#[derive(Clone)]
struct InternalSignedPreKey {
    public: [u8; 32],
    prekey_id: u64,
    signature: [u8; 64],
}

/// Identity bootstrap holding the engine's identity key material and prekey pool.
///
/// Per Council Review #4 §3, manages:
/// - Ed25519 identity key
/// - Signed X25519 prekey (rotated periodically)
/// - One-time prekey pool (consumed atomically, topped up by client)
pub struct IdentityBootstrap {
    #[allow(dead_code)]
    bootstrap_key: [u8; 32],
    identity_signing_key: SigningKey,
    identity_verifying_key_bytes: [u8; 32],
    signed_prekey: Mutex<InternalSignedPreKey>,
    prekey_pool: Mutex<Vec<InternalPreKey>>,
    identity_registry: Mutex<IdentityRegistry>,
}

impl IdentityBootstrap {
    /// Create a new bootstrap with identity key, signed prekey, and 100 one-time prekeys.
    pub fn new(bootstrap_key: [u8; 32]) -> Self {
        let mut rng = rand::thread_rng();

        let mut seed = [0u8; 32];
        rng.fill(&mut seed);
        let signing_key = SigningKey::from_bytes(&seed);
        let verifying_key = signing_key.verifying_key();
        let vk_bytes = verifying_key.to_bytes();

        let signed_prekey = Self::generate_signed_prekey(&signing_key, &mut rng, 1);

        let mut pool = Vec::with_capacity(INITIAL_PREKEY_COUNT);
        for _ in 0..INITIAL_PREKEY_COUNT {
            pool.push(Self::generate_one_time_prekey(&signing_key, &mut rng));
        }

        Self {
            bootstrap_key,
            identity_signing_key: signing_key,
            identity_verifying_key_bytes: vk_bytes,
            signed_prekey: Mutex::new(signed_prekey),
            prekey_pool: Mutex::new(pool),
            identity_registry: Mutex::new(IdentityRegistry::new()),
        }
    }

    fn generate_x25519_keypair(
        rng: &mut impl Rng,
    ) -> (StaticSecret, [u8; 32]) {
        let mut bytes = [0u8; 32];
        rng.fill(&mut bytes);
        let secret = StaticSecret::from(bytes);
        let public = PublicKey::from(&secret);
        (secret, public.to_bytes())
    }

    fn generate_one_time_prekey(
        signing_key: &SigningKey,
        rng: &mut impl Rng,
    ) -> InternalPreKey {
        let (_secret, public_bytes) = Self::generate_x25519_keypair(rng);
        let prekey_id = Self::new_prekey_id(rng);

        let mut msg = Vec::with_capacity(prekey_id.len() + 32);
        msg.extend_from_slice(prekey_id.as_bytes());
        msg.extend_from_slice(&public_bytes);
        let signature = signing_key.sign(&msg).to_bytes();

        InternalPreKey {
            prekey_id,
            public: public_bytes,
            signature,
        }
    }

    fn generate_signed_prekey(
        signing_key: &SigningKey,
        rng: &mut impl Rng,
        prekey_id: u64,
    ) -> InternalSignedPreKey {
        let (_secret, public_bytes) = Self::generate_x25519_keypair(rng);

        let mut msg = Vec::with_capacity(8 + 32);
        msg.extend_from_slice(&prekey_id.to_le_bytes());
        msg.extend_from_slice(&public_bytes);
        let signature = signing_key.sign(&msg).to_bytes();

        InternalSignedPreKey {
            public: public_bytes,
            prekey_id,
            signature,
        }
    }

    fn new_prekey_id(rng: &mut impl Rng) -> String {
        let bytes: [u8; 16] = rng.gen();
        hex::encode(bytes)
    }

    /// The Ed25519 identity public key.
    pub fn identity_public_key(&self) -> [u8; 32] {
        self.identity_verifying_key_bytes
    }

    /// The X25519 signed prekey public key.
    pub fn signed_prekey_public(&self) -> [u8; 32] {
        self.signed_prekey.lock().unwrap().public
    }

    /// The Ed25519 signature over the signed prekey.
    pub fn signed_prekey_signature(&self) -> [u8; 64] {
        self.signed_prekey.lock().unwrap().signature
    }

    /// Rotate the signed prekey: generate a new X25519 key and re-sign it.
    pub fn rotate_signed_prekey(&mut self) {
        let signing_key = &self.identity_signing_key;
        let mut rng = rand::thread_rng();
        let new_id = {
            let spk = self.signed_prekey.lock().unwrap();
            spk.prekey_id.wrapping_add(1)
        };
        let new_spk = Self::generate_signed_prekey(signing_key, &mut rng, new_id);
        *self.signed_prekey.lock().unwrap() = new_spk;
    }

    /// Atomically consume and return one one-time prekey.
    ///
    /// Returns `PrekeyAlreadyConsumed` if the pool is empty.
    pub fn consume_one_time_prekey(&mut self) -> Result<OneTimePreKey> {
        let mut pool = self.prekey_pool.lock().unwrap();
        pool.pop()
            .map(|k| k.to_public())
            .ok_or(WabiError::PrekeyAlreadyConsumed)
    }

    /// Add `n` new one-time prekeys to the pool.
    pub fn rekey_pool(&mut self, n: usize) -> Result<()> {
        if n == 0 {
            return Ok(());
        }
        let signing_key = &self.identity_signing_key;
        let mut rng = rand::thread_rng();
        let mut pool = self.prekey_pool.lock().unwrap();
        for _ in 0..n {
            pool.push(Self::generate_one_time_prekey(signing_key, &mut rng));
        }
        Ok(())
    }

    /// Create a signed attestation binding the identity key to a device.
    pub fn sign_attestation(&self, device_id: &str) -> SignedDeviceAttestation {
        let pk_bytes = self.identity_verifying_key_bytes;
        let identity_key_hash = *blake3::hash(&pk_bytes).as_bytes();
        let payload = format!("wabidb:identity:attestation:{device_id}").into_bytes();

        let mut msg =
            Vec::with_capacity(identity_key_hash.len() + device_id.len() + payload.len());
        msg.extend_from_slice(&identity_key_hash);
        msg.extend_from_slice(device_id.as_bytes());
        msg.extend_from_slice(&payload);
        let signature = self.identity_signing_key.sign(&msg).to_bytes();

        let mut reg = self.identity_registry.lock().unwrap();
        let identity_key = IdentityKey {
            user_id: BOOTSTRAP_USER_ID,
            device_id: device_id.to_string(),
            signing_public_key: pk_bytes,
            created_at_micros: 1000,
            expires_at_micros: None,
        };
        reg.register(identity_key);

        SignedDeviceAttestation {
            identity_key_hash,
            device_id: device_id.to_string(),
            payload,
            signature,
        }
    }

    /// Verify a signed device attestation.
    ///
    /// Returns `SignatureVerificationFailed` if the device_id doesn't match,
    /// the device is not registered, or the signature is invalid.
    pub fn verify_attestation(
        &self,
        att: &SignedDeviceAttestation,
        expected_device_id: &str,
    ) -> Result<()> {
        if att.device_id != expected_device_id {
            return Err(WabiError::SignatureVerificationFailed);
        }
        let reg = self.identity_registry.lock().unwrap();
        crate::crypto::identity::verify_attestation(&reg, BOOTSTRAP_USER_ID, att)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn make_bootstrap_key() -> [u8; 32] {
        let mut key = [0u8; 32];
        rand::thread_rng().fill(&mut key);
        key
    }

    #[test]
    fn new_creates_identity_with_prekeys() {
        let key = make_bootstrap_key();
        let bootstrap = IdentityBootstrap::new(key);

        assert_eq!(bootstrap.bootstrap_key, key);
        assert_ne!(bootstrap.identity_verifying_key_bytes, [0u8; 32]);

        let spk = bootstrap.signed_prekey.lock().unwrap();
        assert_ne!(spk.public, [0u8; 32]);
        assert_ne!(spk.signature, [0u8; 64]);
        assert_eq!(spk.prekey_id, 1);
        drop(spk);

        let pool = bootstrap.prekey_pool.lock().unwrap();
        assert_eq!(pool.len(), 100);
        for pk in pool.iter() {
            assert_ne!(pk.public, [0u8; 32]);
            assert_ne!(pk.signature, [0u8; 64]);
        }
    }

    #[test]
    fn consume_one_time_prekey_returns_distinct() {
        let key = make_bootstrap_key();
        let mut bootstrap = IdentityBootstrap::new(key);

        let mut ids = HashSet::new();
        for _ in 0..10 {
            let pk = bootstrap.consume_one_time_prekey().unwrap();
            assert!(ids.insert(pk.prekey_id.clone()), "duplicate prekey_id: {}", pk.prekey_id);
        }
        assert_eq!(ids.len(), 10);
    }

    #[test]
    fn consume_one_time_prekey_depletes_pool() {
        let key = make_bootstrap_key();
        let mut bootstrap = IdentityBootstrap::new(key);

        for _ in 0..100 {
            bootstrap.consume_one_time_prekey().unwrap();
        }

        let err = bootstrap.consume_one_time_prekey().unwrap_err();
        assert!(matches!(err, WabiError::PrekeyAlreadyConsumed));
    }

    #[test]
    fn rotate_signed_prekey_changes_signature() {
        let key = make_bootstrap_key();
        let mut bootstrap = IdentityBootstrap::new(key);

        let old_sig = bootstrap.signed_prekey_signature();
        bootstrap.rotate_signed_prekey();
        let new_sig = bootstrap.signed_prekey_signature();

        assert_ne!(old_sig, new_sig, "rotated prekey signature must differ");
    }

    #[test]
    fn sign_and_verify_attestation_round_trip() {
        let key = make_bootstrap_key();
        let bootstrap = IdentityBootstrap::new(key);

        let att = bootstrap.sign_attestation("device_alpha");

        assert!(bootstrap
            .verify_attestation(&att, "device_alpha")
            .is_ok());

        let err = bootstrap
            .verify_attestation(&att, "device_beta")
            .unwrap_err();
        assert!(matches!(err, WabiError::SignatureVerificationFailed));
    }

    #[test]
    fn rekey_pool_adds_prekeys() {
        let key = make_bootstrap_key();
        let mut bootstrap = IdentityBootstrap::new(key);

        let initial_len = bootstrap.prekey_pool.lock().unwrap().len();

        bootstrap.rekey_pool(50).unwrap();

        let final_len = bootstrap.prekey_pool.lock().unwrap().len();
        assert_eq!(final_len, initial_len + 50);
    }

    #[test]
    fn atomic_consume_under_concurrency() {
        let key = make_bootstrap_key();
        let bootstrap = std::sync::Arc::new(std::sync::Mutex::new(IdentityBootstrap::new(key)));

        let mut handles = Vec::new();
        for _ in 0..10 {
            let guard = std::sync::Arc::clone(&bootstrap);
            handles.push(std::thread::spawn(move || {
                guard.lock().unwrap().consume_one_time_prekey().unwrap()
            }));
        }

        let mut ids = HashSet::new();
        for h in handles {
            let pk = h.join().expect("thread panicked");
            assert!(ids.insert(pk.prekey_id), "duplicate prekey_id from concurrent consume");
        }
        assert_eq!(ids.len(), 10);
    }
}
