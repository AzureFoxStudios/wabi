use serde::{Deserialize, Serialize};

use crate::error::{Result, WabiError};

pub const CURRENT_SCHEMA_VERSION: u16 = 1;

pub const SIGNATURE_LEN: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventEnvelope {
    pub schema_version: u16,
    pub created_at_micros: i64,
    pub commit_seq: u64,
    pub stream_id: String,
    pub event_type: String,
    pub payload: Vec<u8>,
    pub signature: Option<Vec<u8>>,
}

impl EventEnvelope {
    pub fn new(commit_seq: u64, stream_id: String, event_type: String, payload: Vec<u8>) -> Self {
        let created_at_micros = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as i64;
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            created_at_micros,
            commit_seq,
            stream_id,
            event_type,
            payload,
            signature: None,
        }
    }

    pub fn sign(&mut self, private_key: &[u8; 64]) {
        let msg = self.signing_message();
        use ed25519_dalek::Signer;
        let keypair = ed25519_dalek::SigningKey::from_keypair_bytes(private_key)
            .expect("valid ed25519 keypair");
        self.signature = Some(keypair.sign(&msg).to_bytes().to_vec());
    }

    pub fn verify(&self, public_key: &[u8; 32]) -> Result<()> {
        let sig_bytes = self.signature.as_ref().ok_or_else(|| WabiError::Validation {
            command: "event_envelope".into(),
            reason: "no signature on envelope".into(),
        })?;
        if sig_bytes.len() != SIGNATURE_LEN {
            return Err(WabiError::Validation {
                command: "event_envelope".into(),
                reason: format!("signature length {} != {}", sig_bytes.len(), SIGNATURE_LEN),
            });
        }
        let msg = self.signing_message();
        let mut arr = [0u8; SIGNATURE_LEN];
        arr.copy_from_slice(sig_bytes);
        let sig = ed25519_dalek::Signature::from_bytes(&arr);
        let pub_key = ed25519_dalek::VerifyingKey::from_bytes(public_key)
            .map_err(|_| WabiError::Validation {
                command: "event_envelope".into(),
                reason: "invalid public key bytes".into(),
            })?;
        use ed25519_dalek::Verifier;
        pub_key
            .verify(&msg, &sig)
            .map_err(|_| WabiError::AuthTagMismatch {
                stream_id: self.stream_id.clone(),
                commit_seq: self.commit_seq,
            })
    }

    pub fn with_version(mut self, version: u16) -> Self {
        self.schema_version = version;
        self
    }

    fn signing_message(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(&self.schema_version.to_le_bytes());
        buf.extend_from_slice(&self.created_at_micros.to_le_bytes());
        buf.extend_from_slice(&self.commit_seq.to_le_bytes());
        buf.extend_from_slice(self.stream_id.as_bytes());
        buf.extend_from_slice(self.event_type.as_bytes());
        buf.extend_from_slice(&self.payload);
        buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_envelope() -> EventEnvelope {
        EventEnvelope::new(
            1,
            "ch_01".into(),
            "message_created".into(),
            b"hello".to_vec(),
        )
    }

    #[test]
    fn roundtrip() {
        let env = make_envelope();
        let json = serde_json::to_string(&env).unwrap();
        let back: EventEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(env, back);
    }

    #[test]
    fn version_migration() {
        let env = make_envelope().with_version(0);
        assert_eq!(env.schema_version, 0);
        let env = env.with_version(CURRENT_SCHEMA_VERSION);
        assert_eq!(env.schema_version, CURRENT_SCHEMA_VERSION);
    }

    fn make_keypair() -> ([u8; 64], [u8; 32]) {
        let mut seed = [0u8; 32];
        use rand::RngCore;
        rand::thread_rng().fill_bytes(&mut seed);
        let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
        let private = signing.to_keypair_bytes();
        let public = signing.verifying_key().to_bytes();
        (private, public)
    }

    #[test]
    fn sign_and_verify() {
        let mut env = make_envelope();
        let (private, public) = make_keypair();
        env.sign(&private);
        assert!(env.signature.is_some());
        assert!(env.verify(&public).is_ok());
    }

    #[test]
    fn signature_failure_rejected() {
        let mut env = make_envelope();
        let (private, _public) = make_keypair();
        let (_wrong_private, wrong_public) = make_keypair();

        env.sign(&private);
        let result = env.verify(&wrong_public);
        assert!(result.is_err());
    }

    #[test]
    fn no_signature_returns_error() {
        let env = make_envelope();
        let (_, public) = make_keypair();
        let result = env.verify(&public);
        assert!(result.is_err());
    }

    #[test]
    fn tampered_payload_fails_verify() {
        let mut env = make_envelope();
        let (private, public) = make_keypair();

        env.sign(&private);
        env.payload[0] ^= 0xFF;
        let result = env.verify(&public);
        assert!(result.is_err());
    }
}
