//! Double Ratchet session (per Council Review #4 §1).
//!
//! Implements the Double Ratchet protocol for per-message encryption with
//! forward secrecy, using AES-256-GCM (via `aes_gcm_record` primitives) and
//! X25519 Diffie-Hellman ratchet turns.
//!
//! ## Security invariants (Council Review #4)
//!
//! - `MAX_SKIPPED_KEYS = 1000` hard cap (Council Review #4 §1.1).
//! - Burned-seq: once a message key is consumed, its seq is never reused.
//! - Out-of-order messages are stored in a skipped-keys cache (up to 1000).
//! - The send and receive chains advance independently via `KDF_CK`.
//! - The DH ratchet advances via `KDF_RK` after a fresh X25519 key exchange.
//!
//! ## Design decisions (Council Review #4 §1.2 - Option A)
//!
//! This module is a `pub` shared library. The wabidb crate is used by both
//! the wabi-server (for storage of wrapped keys) and the Tauri desktop client
//! (for ratchet state). The same Rust implementation can be compiled to WASM
//! for the browser client.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use rand::RngCore;
use std::collections::HashMap;
use x25519_dalek::{PublicKey, StaticSecret};

use crate::error::{Result, WabiError};

/// Maximum number of skipped (out-of-order) message keys allowed per session.
/// Council Review #4 §1.1 sets this at 1000 to bound memory exposure.
pub const MAX_SKIPPED_KEYS: usize = 1000;

/// AES-256 key length in bytes.
pub const KEY_LEN: usize = 32;

/// AES-GCM nonce length in bytes.
pub const NONCE_LEN: usize = 12;

/// The role of this party in the Double Ratchet session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// The party that initiated the X3DH handshake.
    Initiator,
    /// The party that responded to the X3DH handshake.
    Responder,
}

/// Output of an X3DH handshake, used to initialize a Double Ratchet session.
///
/// Produced by `wabidb-78` (`x3dh_handshake.rs`).
#[derive(Debug, Clone)]
pub struct HandshakeResult {
    /// The X3DH shared secret (`SK`), used as the initial root key.
    pub shared_secret: [u8; 32],
    /// This party's X25519 private key for the initial DH ratchet.
    pub our_dh_private: [u8; 32],
    /// The other party's X25519 public key for the initial DH ratchet.
    pub their_dh_public: [u8; 32],
}

/// An encrypted message produced by [`DoubleRatchetSession::encrypt`].
#[derive(Debug, Clone)]
pub struct EncryptedMessage {
    /// The sender's current DH ratchet public key.
    pub dh_public: [u8; 32],
    /// The message counter within the current send chain.
    pub counter: u64,
    /// The AES-256-GCM ciphertext (includes the 16-byte auth tag).
    pub ciphertext: Vec<u8>,
    /// The 12-byte AES-GCM nonce used for this message.
    pub nonce: [u8; 12],
}

/// A Double Ratchet session, holding the root key, chain keys, DH keypair,
/// and skipped-key cache.
///
/// ## State
///
/// - `root_key`: the current root key (`RK`), used to derive chain keys after
///   each DH ratchet turn.
/// - `send_chain_key`: the current sending chain key (`CKs`), or `None` if the
///   send chain has not been established yet.
/// - `recv_chain_key`: the current receiving chain key (`CKr`), or `None`.
/// - `send_counter`: the message number within the current send chain.
/// - `recv_counter`: the message number within the current receive chain.
/// - `skipped_keys`: cache of message keys for out-of-order messages, keyed by
///   `(counter, dh_public_hash)`.
/// - `dh_send_secret`: this party's current X25519 private key for send DH.
/// - `dh_recv_public`: the other party's current X25519 public key for recv DH.
#[derive(Debug, Clone)]
pub struct DoubleRatchetSession {
    root_key: [u8; 32],
    send_chain_key: Option<[u8; 32]>,
    recv_chain_key: Option<[u8; 32]>,
    send_counter: u64,
    recv_counter: u64,
    skipped_keys: HashMap<(u64, [u8; 32]), [u8; 32]>,
    dh_send_secret: [u8; 32],
    dh_recv_public: [u8; 32],
}

// ---------------------------------------------------------------------------
// KDF helpers
// ---------------------------------------------------------------------------

/// Root-key KDF: `KDF_RK(RK, dh_out) -> (new_RK, chain_key)`.
fn kdf_rk(rk: &[u8; 32], dh_out: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"WabiDB-DoubleRatchet-KDF-RK-v1");
    hasher.update(rk);
    hasher.update(dh_out);
    let mut reader = hasher.finalize_xof();
    let mut new_rk = [0u8; 32];
    let mut new_ck = [0u8; 32];
    reader.fill(&mut new_rk);
    reader.fill(&mut new_ck);
    (new_rk, new_ck)
}

/// Chain-key KDF: `KDF_CK(ck) -> (next_ck, message_key)`.
fn kdf_ck(ck: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"WabiDB-DoubleRatchet-KDF-CK-v1");
    hasher.update(ck);
    let mut reader = hasher.finalize_xof();
    let mut next_ck = [0u8; 32];
    let mut mk = [0u8; 32];
    reader.fill(&mut next_ck);
    reader.fill(&mut mk);
    (next_ck, mk)
}

// ---------------------------------------------------------------------------
// X25519 DH helpers
// ---------------------------------------------------------------------------

/// Compute X25519 Diffie-Hellman shared secret.
fn x25519_dh(private: &[u8; 32], public: &[u8; 32]) -> [u8; 32] {
    let secret = StaticSecret::from(*private);
    let pub_key = PublicKey::from(*public);
    *secret.diffie_hellman(&pub_key).as_bytes()
}

/// Generate a random X25519 private key.
fn generate_dh_secret() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
}

/// Derive the X25519 public key from a private key.
fn dh_public_from_secret(private: &[u8; 32]) -> [u8; 32] {
    let secret = StaticSecret::from(*private);
    let public = PublicKey::from(&secret);
    public.to_bytes()
}

/// Hash of a DH public key, used as part of the skipped-keys cache key.
fn dh_public_hash(public: &[u8; 32]) -> [u8; 32] {
    let hash = blake3::hash(public);
    *hash.as_bytes()
}

// ---------------------------------------------------------------------------
// AES-256-GCM helpers for Double Ratchet messages
// ---------------------------------------------------------------------------

fn dr_encrypt(key: &[u8; 32], counter: u64, dh_public: &[u8; 32], plaintext: &[u8]) -> Result<(Vec<u8>, [u8; 12])> {
    let mut nonce = [0u8; NONCE_LEN];
    nonce[0..8].copy_from_slice(&counter.to_le_bytes());

    let mut aad = Vec::with_capacity(4 + 32);
    aad.extend_from_slice(b"DRv1");
    aad.extend_from_slice(dh_public);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: &aad })
        .map_err(|_| WabiError::InternalInvariantViolated {
            invariant: format!("Double Ratchet encryption failed at counter {counter}"),
        })?;
    Ok((ct, nonce))
}

fn dr_decrypt(key: &[u8; 32], counter: u64, dh_public: &[u8; 32], ciphertext: &[u8]) -> Result<Vec<u8>> {
    let mut nonce = [0u8; NONCE_LEN];
    nonce[0..8].copy_from_slice(&counter.to_le_bytes());

    let mut aad = Vec::with_capacity(4 + 32);
    aad.extend_from_slice(b"DRv1");
    aad.extend_from_slice(dh_public);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: ciphertext, aad: &aad })
        .map_err(|_| WabiError::AuthTagMismatch {
            stream_id: "double_ratchet".into(),
            commit_seq: counter,
        })
}

// ---------------------------------------------------------------------------
// DoubleRatchetSession implementation
// ---------------------------------------------------------------------------

impl DoubleRatchetSession {
    /// Create a new Double Ratchet session from an X3DH handshake result.
    ///
    /// The initiator's `HandshakeResult` must contain the initiator's DH
    /// private key as `our_dh_private` and the responder's DH public key as
    /// `their_dh_public`. The responder's handshake must contain the
    /// responder's DH private key and the initiator's public key.
    ///
    /// No chain keys are derived during initialization — they are established
    /// lazily on the first `encrypt()` or `decrypt()` call.
    pub fn new(handshake: HandshakeResult) -> Self {
        Self {
            root_key: handshake.shared_secret,
            send_chain_key: None,
            recv_chain_key: None,
            send_counter: 0,
            recv_counter: 0,
            skipped_keys: HashMap::new(),
            dh_send_secret: handshake.our_dh_private,
            dh_recv_public: handshake.their_dh_public,
        }
    }

    /// Encrypt a plaintext message.
    ///
    /// If the send chain is not yet established, a DH ratchet step is
    /// performed first: a fresh X25519 keypair is generated, the shared
    /// secret is computed with `dh_recv_public`, and a new send chain key
    /// is derived from the root key.
    ///
    /// The resulting [`EncryptedMessage`] carries the sender's current DH
    /// public key, the message counter, ciphertext, and nonce.
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<EncryptedMessage> {
        // Establish send chain if not already present.
        if self.send_chain_key.is_none() {
            let new_private = generate_dh_secret();
            let shared = x25519_dh(&new_private, &self.dh_recv_public);
            let (new_rk, ck) = kdf_rk(&self.root_key, &shared);
            self.root_key = new_rk;
            self.send_chain_key = Some(ck);
            self.dh_send_secret = new_private;
            self.send_counter = 0;
        }

        let ck = self.send_chain_key.unwrap();
        let (next_ck, mk) = kdf_ck(&ck);
        self.send_chain_key = Some(next_ck);

        let dh_pub = dh_public_from_secret(&self.dh_send_secret);
        let (ciphertext, nonce) = dr_encrypt(&mk, self.send_counter, &dh_pub, plaintext)?;

        let msg = EncryptedMessage {
            dh_public: dh_pub,
            counter: self.send_counter,
            ciphertext,
            nonce,
        };

        self.send_counter += 1;
        Ok(msg)
    }

    /// Decrypt an [`EncryptedMessage`].
    ///
    /// Handles out-of-order messages via the skipped-keys cache. If the
    /// message's DH public key differs from the stored `dh_recv_public`, a
    /// full DH ratchet turn is performed (deriving both a new recv chain and
    /// a new send chain, resetting counters, and generating a fresh DH
    /// keypair).
    pub fn decrypt(&mut self, message: &EncryptedMessage) -> Result<Vec<u8>> {
        let dh_hash = dh_public_hash(&message.dh_public);

        // DH ratchet when a new DH public key is received.
        if message.dh_public != self.dh_recv_public {
            // Compute shared secret for the receive chain using our current
            // DH private key and their new DH public key.
            let shared_recv = x25519_dh(&self.dh_send_secret, &message.dh_public);
            let (new_rk, new_recv_ck) = kdf_rk(&self.root_key, &shared_recv);
            self.root_key = new_rk;
            self.recv_chain_key = Some(new_recv_ck);

            // Generate a fresh DH keypair and derive a new send chain key.
            let new_send_private = generate_dh_secret();
            let shared_send = x25519_dh(&new_send_private, &message.dh_public);
            let (new_rk2, new_send_ck) = kdf_rk(&self.root_key, &shared_send);
            self.root_key = new_rk2;
            self.send_chain_key = Some(new_send_ck);
            self.dh_send_secret = new_send_private;

            self.dh_recv_public = message.dh_public;
            self.recv_counter = 0;
            self.send_counter = 0;
        }

        // Check the skipped-keys cache.
        let cache_key = (message.counter, dh_hash);
        if let Some(mk) = self.skipped_keys.remove(&cache_key) {
            return dr_decrypt(&mk, message.counter, &message.dh_public, &message.ciphertext);
        }

        // Advance the receive chain to reach this message's counter.
        if message.counter >= self.recv_counter {
            let ck = self.recv_chain_key.ok_or_else(|| {
                WabiError::InternalInvariantViolated {
                    invariant: "recv_chain_key is None during decrypt with no DH ratchet triggered".into(),
                }
            })?;

            let mut current_ck = ck;
            while self.recv_counter < message.counter {
                let (next_ck, mk_skip) = kdf_ck(&current_ck);

                if self.skipped_keys.len() >= MAX_SKIPPED_KEYS {
                    return Err(WabiError::SkippedKeyCacheFull);
                }

                let skip_key = (self.recv_counter, dh_hash);
                self.skipped_keys.insert(skip_key, mk_skip);
                current_ck = next_ck;
                self.recv_counter += 1;
            }

            let (next_ck, mk) = kdf_ck(&current_ck);
            self.recv_chain_key = Some(next_ck);
            self.recv_counter += 1;

            dr_decrypt(&mk, message.counter, &message.dh_public, &message.ciphertext)
        } else {
            Err(WabiError::AuthTagMismatch {
                stream_id: "double_ratchet".into(),
                commit_seq: message.counter,
            })
        }
    }

    /// Perform a fresh DH ratchet step for the send chain.
    ///
    /// Generates a new DH keypair, derives a new send chain key from the
    /// current root key and the stored remote DH public, and resets the
    /// send counter. This is called automatically during [`encrypt`] when
    /// the send chain is not established.
    pub fn ratchet_step(&mut self) -> Result<()> {
        let new_private = generate_dh_secret();
        let shared = x25519_dh(&new_private, &self.dh_recv_public);
        let (new_rk, ck) = kdf_rk(&self.root_key, &shared);
        self.root_key = new_rk;
        self.send_chain_key = Some(ck);
        self.dh_send_secret = new_private;
        self.send_counter = 0;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Read-only accessors for testing
    // -----------------------------------------------------------------------

    /// The current send chain key, if established.
    pub fn get_send_chain_key(&self) -> Option<[u8; 32]> {
        self.send_chain_key
    }

    /// The current receive chain key, if established.
    pub fn get_recv_chain_key(&self) -> Option<[u8; 32]> {
        self.recv_chain_key
    }

    /// The current root key.
    pub fn get_root_key(&self) -> [u8; 32] {
        self.root_key
    }

    /// The current DH send private key.
    pub fn get_dh_send_secret(&self) -> [u8; 32] {
        self.dh_send_secret
    }

    /// The current remote DH public key.
    pub fn get_dh_recv_public(&self) -> [u8; 32] {
        self.dh_recv_public
    }

    /// The number of skipped keys currently cached.
    pub fn skipped_keys_count(&self) -> usize {
        self.skipped_keys.len()
    }

    /// The current send counter.
    pub fn send_counter(&self) -> u64 {
        self.send_counter
    }

    /// The current receive counter.
    pub fn recv_counter(&self) -> u64 {
        self.recv_counter
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a pair of handshakes (initiator + responder) with proper
    /// asymmetric DH keys for testing.
    fn test_handshake_pair(seed: u8) -> (HandshakeResult, HandshakeResult) {
        // Generate a deterministic DH keypair for the initiator (Alice).
        let mut alice_private = [0u8; 32];
        let mut bob_private = [0u8; 32];
        for i in 0..32 {
            alice_private[i] = seed.wrapping_add(1).wrapping_add(i as u8);
            bob_private[i] = seed.wrapping_add(2).wrapping_add(i as u8);
        }
        let alice_public = dh_public_from_secret(&alice_private);
        let bob_public = dh_public_from_secret(&bob_private);

        // Shared secret from X3DH.
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

    /// Test 1: Round-trip encrypt/decrypt.
    #[test]
    fn round_trip() {
        let (alice_hs, bob_hs) = test_handshake_pair(1);
        let mut alice = DoubleRatchetSession::new(alice_hs);
        let mut bob = DoubleRatchetSession::new(bob_hs);

        let plaintext = b"Hello, Double Ratchet!";
        let msg = alice.encrypt(plaintext).unwrap();
        let decrypted = bob.decrypt(&msg).unwrap();

        assert_eq!(decrypted, plaintext);
    }

    /// Test 2: Out-of-order messages.
    #[test]
    fn out_of_order_messages() {
        let (alice_hs, bob_hs) = test_handshake_pair(2);
        let mut alice = DoubleRatchetSession::new(alice_hs);
        let mut bob = DoubleRatchetSession::new(bob_hs);

        let plaintexts: &[&[u8]] = &[b"msg0", b"msg1", b"msg2"];

        // Alice sends all three messages.
        let msgs: Vec<_> = plaintexts
            .iter()
            .map(|pt| alice.encrypt(pt).unwrap())
            .collect();

        // Bob receives them in order: 0, 2, 1
        let m0 = bob.decrypt(&msgs[0]).unwrap();
        let m2 = bob.decrypt(&msgs[2]).unwrap();
        let m1 = bob.decrypt(&msgs[1]).unwrap();

        assert_eq!(m0, plaintexts[0]);
        assert_eq!(m1, plaintexts[1]);
        assert_eq!(m2, plaintexts[2]);
    }

    /// Test 3: `ratchet_step` advances keys.
    #[test]
    fn ratchet_step_advances_keys() {
        let (alice_hs, _) = test_handshake_pair(3);
        let mut alice = DoubleRatchetSession::new(alice_hs);

        // First encrypt to establish the send chain.
        let _msg0 = alice.encrypt(b"pre-ratchet").unwrap();
        let ck_before = alice.get_send_chain_key().unwrap();
        let rk_before = alice.get_root_key();

        alice.ratchet_step().unwrap();

        let ck_after = alice.get_send_chain_key().unwrap();
        let rk_after = alice.get_root_key();

        assert_ne!(ck_before, ck_after, "send chain key must change after ratchet step");
        assert_ne!(rk_before, rk_after, "root key must change after ratchet step");
    }

    /// Test 4: Skipped-key cache is capped at `MAX_SKIPPED_KEYS`.
    #[test]
    fn skipped_key_cache_capped() {
        let (alice_hs, bob_hs) = test_handshake_pair(4);
        let mut alice = DoubleRatchetSession::new(alice_hs);
        let mut bob = DoubleRatchetSession::new(bob_hs);

        // Alice sends MAX_SKIPPED_KEYS + 2 messages (counters 0..=1001).
        // Bob receives the LAST one (counter 1001), which creates a gap of
        // 1001 skipped keys (counters 0..=1000). The cache can hold only
        // 1000, so the 1001st insertion triggers SkippedKeyCacheFull.
        let count = MAX_SKIPPED_KEYS + 2;
        let mut msgs = Vec::with_capacity(count);
        for i in 0..count {
            let pt = format!("msg{i}");
            msgs.push(alice.encrypt(pt.as_bytes()).unwrap());
        }

        // Receive the last message (counter = MAX_SKIPPED_KEYS + 1).
        let err = bob.decrypt(&msgs[count - 1]).unwrap_err();
        assert!(
            matches!(err, WabiError::SkippedKeyCacheFull),
            "expected SkippedKeyCacheFull, got {err:?}"
        );
    }

    /// Test 5: Burned-seq invariant.
    ///
    /// Once a message key is consumed, it cannot be reused. A replayed
    /// message must fail authentication.
    #[test]
    fn burned_seq_invariant() {
        let (alice_hs, bob_hs) = test_handshake_pair(5);
        let mut alice = DoubleRatchetSession::new(alice_hs);
        let mut bob = DoubleRatchetSession::new(bob_hs);

        let m0 = alice.encrypt(b"first").unwrap();
        let m1 = alice.encrypt(b"second").unwrap();

        // Both messages decrypt fine in order.
        assert_eq!(bob.decrypt(&m0).unwrap(), b"first");
        assert_eq!(bob.decrypt(&m1).unwrap(), b"second");

        // Replaying m0 (counter 0, chain already advanced past it) must fail.
        let err = bob.decrypt(&m0).unwrap_err();
        assert!(
            matches!(err, WabiError::AuthTagMismatch { .. }),
            "expected AuthTagMismatch for replayed message, got {err:?}"
        );
    }

    /// Test 6: Tampered message is rejected.
    #[test]
    fn tampered_message_rejected() {
        let (alice_hs, bob_hs) = test_handshake_pair(6);
        let mut alice = DoubleRatchetSession::new(alice_hs);
        let mut bob = DoubleRatchetSession::new(bob_hs);

        let msg = alice.encrypt(b"secret").unwrap();
        let mut tampered = msg.clone();
        // Flip a bit in the ciphertext.
        tampered.ciphertext[0] ^= 0xFF;

        let err = bob.decrypt(&tampered).unwrap_err();
        assert!(
            matches!(err, WabiError::AuthTagMismatch { .. }),
            "expected AuthTagMismatch for tampered message, got {err:?}"
        );
    }

    /// Test 7: Wrong-direction rejection.
    ///
    /// An initiator session cannot decrypt its own encrypted message (the
    /// decrypt path looks at the receive chain, which is not established
    /// for the initiator on its own messages).
    #[test]
    fn wrong_direction_rejected() {
        let (alice_hs, _) = test_handshake_pair(7);
        let mut alice = DoubleRatchetSession::new(alice_hs);

        let msg = alice.encrypt(b"cross-direction").unwrap();

        // Alice tries to decrypt her own message. The decrypt path attempts
        // a DH ratchet (since the message's dh_public != alice's dh_recv_public
        // which is Bob's public from the handshake). After the ratchet, the
        // recv chain is derived, but the message's key was derived on the
        // *send* chain and thus has a different message key. Auth fails.
        let err = alice.decrypt(&msg).unwrap_err();
        assert!(
            matches!(err, WabiError::AuthTagMismatch { .. }),
            "expected AuthTagMismatch when initiator decrypts own message, got {err:?}"
        );
    }

    /// Test 8: Fresh DH ratchet produces different keys.
    ///
    /// After a DH ratchet turn (triggered by receiving a message with a new
    /// DH public key), the session's chain keys and root key change.
    #[test]
    fn fresh_dh_ratchet() {
        let (alice_hs, bob_hs) = test_handshake_pair(8);
        let mut alice = DoubleRatchetSession::new(alice_hs);
        let mut bob = DoubleRatchetSession::new(bob_hs);

        let bob_rk_before = bob.get_root_key();

        // Alice sends a message. Bob decrypts, triggering a DH ratchet.
        let msg = alice.encrypt(b"ratchet-test").unwrap();
        let _ = bob.decrypt(&msg).unwrap();

        let bob_ck_after = bob.get_recv_chain_key();
        let bob_rk_after = bob.get_root_key();

        assert!(bob_ck_after.is_some(), "Bob must have a recv chain after DH ratchet");
        assert_ne!(bob_rk_before, bob_rk_after, "Bob's root key must change after DH ratchet");

        let alice_ck_after = alice.get_send_chain_key();
        assert!(alice_ck_after.is_some(), "Alice must still have a send chain");
    }
}
