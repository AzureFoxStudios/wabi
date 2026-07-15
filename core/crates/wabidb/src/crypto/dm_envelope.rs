use crate::crypto::double_ratchet::DoubleRatchetSession;
use crate::error::Result;

#[derive(Debug, Clone)]
pub struct DmEnvelope {
    pub sender_user_id: u64,
    pub recipient_user_id: u64,
    pub sender_device_id: String,
    pub recipient_device_id: String,
    pub dm_id: String,
    pub payload: Vec<u8>,
    pub ratchet_state_hash: [u8; 32],
}

#[derive(Debug, Clone)]
pub struct EncryptedEnvelope {
    pub sender_user_id: u64,
    pub recipient_user_id: u64,
    pub sender_device_id: String,
    pub recipient_device_id: String,
    pub dm_id: String,
    pub ciphertext: Vec<u8>,
    pub ratchet_state_hash: [u8; 32],
    pub dh_public: [u8; 32],
    pub counter: u64,
    pub nonce: [u8; 12],
}

pub fn seal(
    envelope: &DmEnvelope,
    session: &mut DoubleRatchetSession,
) -> Result<EncryptedEnvelope> {
    let msg = session.encrypt(&envelope.payload)?;
    Ok(EncryptedEnvelope {
        sender_user_id: envelope.sender_user_id,
        recipient_user_id: envelope.recipient_user_id,
        sender_device_id: envelope.sender_device_id.clone(),
        recipient_device_id: envelope.recipient_device_id.clone(),
        dm_id: envelope.dm_id.clone(),
        ciphertext: msg.ciphertext,
        ratchet_state_hash: envelope.ratchet_state_hash,
        dh_public: msg.dh_public,
        counter: msg.counter,
        nonce: msg.nonce,
    })
}

pub fn open(
    encrypted: &EncryptedEnvelope,
    session: &mut DoubleRatchetSession,
) -> Result<DmEnvelope> {
    let msg = crate::crypto::double_ratchet::EncryptedMessage {
        dh_public: encrypted.dh_public,
        counter: encrypted.counter,
        ciphertext: encrypted.ciphertext.clone(),
        nonce: encrypted.nonce,
    };
    let plaintext = session.decrypt(&msg)?;
    Ok(DmEnvelope {
        sender_user_id: encrypted.sender_user_id,
        recipient_user_id: encrypted.recipient_user_id,
        sender_device_id: encrypted.sender_device_id.clone(),
        recipient_device_id: encrypted.recipient_device_id.clone(),
        dm_id: encrypted.dm_id.clone(),
        payload: plaintext,
        ratchet_state_hash: encrypted.ratchet_state_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::double_ratchet::HandshakeResult;

    fn test_handshake_pair(seed: u8) -> (HandshakeResult, HandshakeResult) {
        let mut alice_private = [0u8; 32];
        let mut bob_private = [0u8; 32];
        for i in 0..32 {
            alice_private[i] = seed.wrapping_add(1).wrapping_add(i as u8);
            bob_private[i] = seed.wrapping_add(2).wrapping_add(i as u8);
        }
        let alice_public = {
            let secret = x25519_dalek::StaticSecret::from(alice_private);
            x25519_dalek::PublicKey::from(&secret).to_bytes()
        };
        let bob_public = {
            let secret = x25519_dalek::StaticSecret::from(bob_private);
            x25519_dalek::PublicKey::from(&secret).to_bytes()
        };
        let mut shared_secret = [0u8; 32];
        for i in 0..32 {
            shared_secret[i] = seed.wrapping_add(i as u8);
        }
        let alice = HandshakeResult {
            shared_secret,
            our_dh_private: alice_private,
            their_dh_public: bob_public,
        };
        let bob = HandshakeResult {
            shared_secret,
            our_dh_private: bob_private,
            their_dh_public: alice_public,
        };
        (alice, bob)
    }

    fn make_envelope(sender: u64, recipient: u64) -> DmEnvelope {
        DmEnvelope {
            sender_user_id: sender,
            recipient_user_id: recipient,
            sender_device_id: format!("dev_{}", sender),
            recipient_device_id: format!("dev_{}", recipient),
            dm_id: format!("dm_{}_{}", sender, recipient),
            payload: b"hello DM".to_vec(),
            ratchet_state_hash: [0xAA; 32],
        }
    }

    #[test]
    fn seal_open_roundtrip() {
        let (alice_hs, bob_hs) = test_handshake_pair(1);
        let mut alice = DoubleRatchetSession::new(alice_hs);
        let mut bob = DoubleRatchetSession::new(bob_hs);

        let envelope = make_envelope(1, 2);
        let encrypted = seal(&envelope, &mut alice).unwrap();
        let decrypted = open(&encrypted, &mut bob).unwrap();

        assert_eq!(decrypted.sender_user_id, 1);
        assert_eq!(decrypted.recipient_user_id, 2);
        assert_eq!(decrypted.payload, b"hello DM");
    }

    #[test]
    fn wrong_recipient_rejected() {
        let (alice_hs, _bob_hs) = test_handshake_pair(2);
        let mut alice = DoubleRatchetSession::new(alice_hs.clone());
        let mut alice2 = DoubleRatchetSession::new(alice_hs);

        let envelope = make_envelope(1, 2);
        let encrypted = seal(&envelope, &mut alice).unwrap();
        let result = open(&encrypted, &mut alice2);
        assert!(result.is_err());
    }
}
