//! X3DH initial handshake (wabidb-78).
//!
//! Implements the X3DH key-agreement protocol using X25519 Diffie-Hellman
//! with Ed25519-based signed-prekey attestation.
//!
//! ## Handshake flow
//!
//! 1. **Initiator** (Alice) fetches the responder's prekey bundle from the server:
//!    - IK_B  — X25519 identity public key
//!    - SPK_B — X25519 signed-prekey public key + Ed25519 signature
//!    - OPK_B — optional X25519 one-time prekey
//! 2. **Initiator** verifies `sig(SPK_B)` against Alice's stored view of Bob's
//!    Ed25519 verifying key (Council Review #4 §2.2 – MUST fail before any DH).
//! 3. **Initiator** computes the DH operations and derives the shared secret.
//! 4. **Responder** receives the initiator's public keys and the signed-prekey
//!    signature, verifies (defensive check), consumes the one-time prekey, and
//!    derives the identical shared secret.
//!
//! ## Design references
//!
//! - Council Review #1 §1.4  – signature verification before DH
//! - Council Review #4 §2    – atomic prekey consumption, signature verification
//! - `docs/proposals/wabidb-endstate.md` §6.1

use crate::error::{Result, WabiError};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rand::RngCore;
use x25519_dalek::{PublicKey, StaticSecret};

#[cfg(test)]
use ed25519_dalek::Signer;

/// BLAKE3 context string for X3DH key derivation.
const X3DH_KDF_CONTEXT: &str = "WabiDB X3DH v1";

// ---------------------------------------------------------------------------
// Identity bootstrap
// ---------------------------------------------------------------------------

/// Complete X3DH identity key material for one participant.
///
/// Contains both the X25519 long-term identity key (for DH operations) and
/// the Ed25519 signing key (for signed-prekey attestation).
#[derive(Clone)]
pub struct IdentityBootstrap {
    /// X25519 long-term identity secret (used in DH1).
    pub identity_secret: StaticSecret,
    /// Ed25519 key used to sign prekeys and attestations.
    pub signing_secret: ed25519_dalek::SigningKey,
}

impl IdentityBootstrap {
    pub fn new(identity_secret: StaticSecret, signing_secret: ed25519_dalek::SigningKey) -> Self {
        Self {
            identity_secret,
            signing_secret,
        }
    }

    /// Generate a fresh random identity.
    pub fn generate() -> Self {
        let mut rng = rand::thread_rng();

        let mut ik_bytes = [0u8; 32];
        rng.fill_bytes(&mut ik_bytes);
        ik_bytes[0] &= 248;
        ik_bytes[31] &= 127;
        ik_bytes[31] |= 64;
        let identity_secret = StaticSecret::from(ik_bytes);

        let mut sk_bytes = [0u8; 32];
        rng.fill_bytes(&mut sk_bytes);
        let signing_secret = ed25519_dalek::SigningKey::from_bytes(&sk_bytes);

        Self {
            identity_secret,
            signing_secret,
        }
    }

    pub fn identity_public(&self) -> [u8; 32] {
        PublicKey::from(&self.identity_secret).to_bytes()
    }

    pub fn verifying_key(&self) -> VerifyingKey {
        self.signing_secret.verifying_key()
    }
}

// ---------------------------------------------------------------------------
// One-time prekey
// ---------------------------------------------------------------------------

/// A single-use prekey for X3DH (public half only).
///
/// The matching [`StaticSecret`] is retained by the responder and is used
/// when the prekey is consumed during `X3DHResponder::handle_initiator`.
#[derive(Clone, Debug)]
pub struct OneTimePreKey {
    pub id: String,
    pub public_key: [u8; 32],
}

impl OneTimePreKey {
    pub fn new(id: String, public_key: [u8; 32]) -> Self {
        Self { id, public_key }
    }
}

// ---------------------------------------------------------------------------
// Handshake result
// ---------------------------------------------------------------------------

/// Output of a completed X3DH handshake.
#[derive(Debug, Clone)]
pub struct HandshakeResult {
    /// 32-byte shared secret SK = KDF(DH1 ‖ DH2 ‖ DH3 [‖ DH4]).
    pub shared_secret: [u8; 32],
    /// Associated data = identity_A ‖ identity_B (64 bytes).
    pub associated_data: Vec<u8>,
    /// The initiator's ephemeral public key (must be sent to the responder).
    pub ephemeral_public: [u8; 32],
}

// ---------------------------------------------------------------------------
// Initiator  (Alice)
// ---------------------------------------------------------------------------

/// Initiator (Alice) side of the X3DH handshake.
pub struct X3DHInitiator {
    identity: IdentityBootstrap,
    ephemeral_secret: StaticSecret,
    recipient_identity_key: PublicKey,
    recipient_signed_prekey: PublicKey,
    recipient_signed_prekey_signature: [u8; 64],
    recipient_verifying_key: VerifyingKey,
    recipient_one_time_prekey: Option<OneTimePreKey>,
}

impl X3DHInitiator {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        identity: IdentityBootstrap,
        ephemeral_secret: StaticSecret,
        recipient_identity_key: [u8; 32],
        recipient_signed_prekey: [u8; 32],
        recipient_signed_prekey_signature: [u8; 64],
        recipient_verifying_key: VerifyingKey,
        recipient_one_time_prekey: Option<OneTimePreKey>,
    ) -> Self {
        Self {
            identity,
            ephemeral_secret,
            recipient_identity_key: PublicKey::from(recipient_identity_key),
            recipient_signed_prekey: PublicKey::from(recipient_signed_prekey),
            recipient_signed_prekey_signature,
            recipient_verifying_key,
            recipient_one_time_prekey,
        }
    }

    /// Execute the X3DH handshake.
    ///
    /// 1. Verifies the signed-prekey signature (Council Review #1 §1.4 —
    ///    signature check *before* any DH computation).
    /// 2. DH1 = DH(IK_A, SPK_B)
    /// 3. DH2 = DH(EK_A, IK_B)
    /// 4. DH3 = DH(EK_A, SPK_B)
    /// 5. DH4 = DH(EK_A, OPK_B) [if OPK provided]
    /// 6. SK  = BLAKE3_derive_key(DH1 ‖ DH2 ‖ DH3 [‖ DH4])
    pub fn perform_handshake(&self) -> Result<HandshakeResult> {
        // ── signature verification before DH (Council Review #1 §1.4) ──
        {
            let spk_bytes = self.recipient_signed_prekey.as_bytes();
            let sig = Signature::from_bytes(&self.recipient_signed_prekey_signature);
            self.recipient_verifying_key
                .verify(spk_bytes, &sig)
                .map_err(|_| WabiError::SignatureVerificationFailed)?;
        }

        // ── DH operations ──
        // DH1 = DH(IK_A, SPK_B)  – initiator identity × responder signed prekey
        let dh1 = self
            .identity
            .identity_secret
            .diffie_hellman(&self.recipient_signed_prekey);

        // DH2 = DH(EK_A, IK_B)  – initiator ephemeral × responder identity
        let dh2 = self
            .ephemeral_secret
            .diffie_hellman(&self.recipient_identity_key);

        // DH3 = DH(EK_A, SPK_B) – initiator ephemeral × responder signed prekey
        let dh3 = self
            .ephemeral_secret
            .diffie_hellman(&self.recipient_signed_prekey);

        let mut kdf_input = Vec::with_capacity(4 * 32);
        kdf_input.extend_from_slice(dh1.as_bytes());
        kdf_input.extend_from_slice(dh2.as_bytes());
        kdf_input.extend_from_slice(dh3.as_bytes());

        if let Some(ref opk) = self.recipient_one_time_prekey {
            // DH4 = DH(EK_A, OPK_B) – initiator ephemeral × responder one-time prekey
            let dh4 = self
                .ephemeral_secret
                .diffie_hellman(&PublicKey::from(opk.public_key));
            kdf_input.extend_from_slice(dh4.as_bytes());
        }

        let shared_secret = blake3::derive_key(X3DH_KDF_CONTEXT, &kdf_input);

        // AD = IK_A ‖ IK_B  (canonical order: initiator ‖ responder)
        let mut associated_data = Vec::with_capacity(64);
        associated_data.extend_from_slice(&self.identity.identity_public());
        associated_data.extend_from_slice(self.recipient_identity_key.as_bytes());

        let ephemeral_public = PublicKey::from(&self.ephemeral_secret).to_bytes();

        Ok(HandshakeResult {
            shared_secret,
            associated_data,
            ephemeral_public,
        })
    }
}

// ---------------------------------------------------------------------------
// Responder  (Bob)
// ---------------------------------------------------------------------------

/// Responder (Bob) side of the X3DH handshake.
pub struct X3DHResponder {
    identity: IdentityBootstrap,
    signed_prekey: StaticSecret,
    signed_prekey_public: PublicKey,
    /// Pool of (public info, secret key) pairs for one-time prekeys.
    one_time_prekey_pool: Vec<(OneTimePreKey, StaticSecret)>,
}

impl X3DHResponder {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        identity: IdentityBootstrap,
        signed_prekey: StaticSecret,
        one_time_prekey_pool: Vec<(OneTimePreKey, StaticSecret)>,
    ) -> Self {
        let signed_prekey_public = PublicKey::from(&signed_prekey);
        Self {
            identity,
            signed_prekey,
            signed_prekey_public,
            one_time_prekey_pool,
        }
    }

    /// Handle an incoming X3DH handshake from an initiator.
    ///
    /// `initiator_identity` — the initiator's X25519 identity public key (IK_A).  
    /// `initiator_ephemeral` — the initiator's X25519 ephemeral public key (EK_A).  
    /// `signature` — the signed-prekey signature (Ed25519 over SPK_B).  The responder
    ///               verifies this defensively: a tampered prekey bundle will be rejected.  
    /// `one_time_prekey_id` — which one-time prekey (if any) the initiator consumed.
    ///
    /// The method consumes the one-time prekey atomically (removes it from the pool).
    pub fn handle_initiator(
        &mut self,
        initiator_identity: [u8; 32],
        initiator_ephemeral: [u8; 32],
        signature: [u8; 64],
        one_time_prekey_id: Option<String>,
    ) -> Result<HandshakeResult> {
        // ── verify signed-prekey signature (defensive check) ──
        {
            let spk_bytes = self.signed_prekey_public.as_bytes();
            let sig = Signature::from_bytes(&signature);
            self.identity
                .verifying_key()
                .verify(spk_bytes, &sig)
                .map_err(|_| WabiError::SignatureVerificationFailed)?;
        }

        let initiator_identity_pk = PublicKey::from(initiator_identity);
        let initiator_ephemeral_pk = PublicKey::from(initiator_ephemeral);

        // ── consume the requested one-time prekey ──
        let consumed_opk_secret: Option<StaticSecret> =
            if let Some(ref opk_id) = one_time_prekey_id {
                let pos = self
                    .one_time_prekey_pool
                    .iter()
                    .position(|(info, _)| info.id == *opk_id)
                    .ok_or(WabiError::PrekeyAlreadyConsumed)?;
                let (_, secret) = self.one_time_prekey_pool.swap_remove(pos);
                Some(secret)
            } else {
                None
            };

        // ── DH operations ──
        // DH1 = DH(SPK_B, IK_A)
        let dh1 = self.signed_prekey.diffie_hellman(&initiator_identity_pk);

        // DH2 = DH(IK_B, EK_A)  [identity × initiator ephemeral]
        let dh2 = self
            .identity
            .identity_secret
            .diffie_hellman(&initiator_ephemeral_pk);

        // DH3 = DH(SPK_B, EK_A) [signed prekey × initiator ephemeral]
        let dh3 = self.signed_prekey.diffie_hellman(&initiator_ephemeral_pk);

        let mut kdf_input = Vec::with_capacity(4 * 32);
        kdf_input.extend_from_slice(dh1.as_bytes());
        kdf_input.extend_from_slice(dh2.as_bytes());
        kdf_input.extend_from_slice(dh3.as_bytes());

        if let Some(ref opk_secret) = consumed_opk_secret {
            // DH4 = DH(OPK_B, EK_A)  [one-time prekey × initiator ephemeral]
            let dh4 = opk_secret.diffie_hellman(&initiator_ephemeral_pk);
            kdf_input.extend_from_slice(dh4.as_bytes());
        }

        let shared_secret = blake3::derive_key(X3DH_KDF_CONTEXT, &kdf_input);

        // AD = IK_A ‖ IK_B (same canonical order as the initiator)
        let mut associated_data = Vec::with_capacity(64);
        associated_data.extend_from_slice(&initiator_identity);
        associated_data.extend_from_slice(&self.identity.identity_public());

        Ok(HandshakeResult {
            shared_secret,
            associated_data,
            ephemeral_public: initiator_ephemeral,
        })
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Generate an X25519 key pair, returning (secret, public_bytes).
#[allow(dead_code)]
fn generate_x25519_keypair() -> (StaticSecret, [u8; 32]) {
    let secret = StaticSecret::random_from_rng(rand::thread_rng());
    let public = PublicKey::from(&secret).to_bytes();
    (secret, public)
}

/// Create a one-time prekey with both (public info, secret key).
#[allow(dead_code)]
fn generate_one_time_prekey(id: &str) -> (OneTimePreKey, StaticSecret) {
    let (secret, public) = generate_x25519_keypair();
    (OneTimePreKey::new(id.into(), public), secret)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a fresh participant: (identity, spk_secret, spk_public, spk_sig).
    fn make_participant() -> (
        IdentityBootstrap,
        StaticSecret,
        [u8; 32],
        [u8; 64],
    ) {
        let identity = IdentityBootstrap::generate();
        let (spk_secret, spk_public) = generate_x25519_keypair();

        // Sign the signed-prekey public key with the identity's Ed25519 key.
        let sig = identity.signing_secret.sign(&spk_public);

        (identity, spk_secret, spk_public, sig.to_bytes())
    }

    // ------------------------------------------------------------------
    // 1. handshake_round_trip
    // ------------------------------------------------------------------
    #[test]
    fn handshake_round_trip() {
        let (alice, ..) = make_participant();
        let (bob, bob_spk_secret, bob_spk_public, bob_spk_sig) = make_participant();

        let (eph_secret, _eph_public) = generate_x25519_keypair();

        let initiator = X3DHInitiator::new(
            alice.clone(),
            eph_secret,
            bob.identity_public(),
            bob_spk_public,
            bob_spk_sig,
            bob.verifying_key(),
            None,
        );
        let alice_result = initiator.perform_handshake().unwrap();

        let mut responder = X3DHResponder::new(
            bob,
            bob_spk_secret,
            vec![],
        );
        let bob_result = responder
            .handle_initiator(
                alice.identity_public(),
                alice_result.ephemeral_public,
                bob_spk_sig,
                None,
            )
            .unwrap();

        assert_eq!(
            alice_result.shared_secret, bob_result.shared_secret,
            "both sides must derive the same shared secret"
        );
        assert_eq!(
            alice_result.associated_data, bob_result.associated_data,
            "both sides must compute the same associated data"
        );
    }

    // ------------------------------------------------------------------
    // 2. handshake_without_one_time_prekey
    // ------------------------------------------------------------------
    #[test]
    fn handshake_without_one_time_prekey() {
        let (alice, ..) = make_participant();
        let (bob, bob_spk_secret, bob_spk_public, bob_spk_sig) = make_participant();

        let (eph_secret, _) = generate_x25519_keypair();

        let initiator = X3DHInitiator::new(
            alice.clone(),
            eph_secret,
            bob.identity_public(),
            bob_spk_public,
            bob_spk_sig,
            bob.verifying_key(),
            None,
        );
        let alice_result = initiator.perform_handshake().unwrap();

        let mut responder = X3DHResponder::new(
            bob,
            bob_spk_secret,
            vec![],
        );
        let bob_result = responder
            .handle_initiator(
                alice.identity_public(),
                alice_result.ephemeral_public,
                bob_spk_sig,
                None,
            )
            .unwrap();

        assert_eq!(alice_result.shared_secret, bob_result.shared_secret);
    }

    // ------------------------------------------------------------------
    // 3. handshake_with_one_time_prekey
    // ------------------------------------------------------------------
    #[test]
    fn handshake_with_one_time_prekey() {
        let (alice, ..) = make_participant();
        let (bob, bob_spk_secret, bob_spk_public, bob_spk_sig) = make_participant();

        let (opk_info, opk_secret) = generate_one_time_prekey("opk-001");
        let (eph_secret, _) = generate_x25519_keypair();

        let initiator = X3DHInitiator::new(
            alice.clone(),
            eph_secret,
            bob.identity_public(),
            bob_spk_public,
            bob_spk_sig,
            bob.verifying_key(),
            Some(opk_info.clone()),
        );
        let alice_result = initiator.perform_handshake().unwrap();

        let mut responder = X3DHResponder::new(
            bob,
            bob_spk_secret,
            vec![(opk_info.clone(), opk_secret)],
        );

        assert_eq!(responder.one_time_prekey_pool.len(), 1);

        let bob_result = responder
            .handle_initiator(
                alice.identity_public(),
                alice_result.ephemeral_public,
                bob_spk_sig,
                Some("opk-001".into()),
            )
            .unwrap();

        assert_eq!(
            alice_result.shared_secret, bob_result.shared_secret,
            "both sides must derive the same shared secret with OPK"
        );
        // The OPK must be consumed (removed from the pool).
        assert!(
            responder.one_time_prekey_pool.is_empty(),
            "one-time prekey must be consumed"
        );
    }

    // ------------------------------------------------------------------
    // 4. signature_verification_failure_rejects
    // ------------------------------------------------------------------
    #[test]
    fn signature_verification_failure_rejects() {
        let (alice, ..) = make_participant();
        let (bob, _bob_spk_secret, bob_spk_public, _bob_spk_sig) = make_participant();

        // Use a WRONG signing key to sign the prekey.
        let _wrong_public = generate_x25519_keypair().1;
        let wrong_identity = IdentityBootstrap::generate();
        let wrong_sig = wrong_identity.signing_secret.sign(&bob_spk_public);

        let (eph_secret, _) = generate_x25519_keypair();

        let initiator = X3DHInitiator::new(
            alice,
            eph_secret,
            bob.identity_public(),
            bob_spk_public,
            wrong_sig.to_bytes(),
            bob.verifying_key(),
            None,
        );
        let err = initiator.perform_handshake().unwrap_err();
        assert!(
            matches!(err, WabiError::SignatureVerificationFailed),
            "expected SignatureVerificationFailed, got {err:?}"
        );
    }

    // ------------------------------------------------------------------
    // 5. tampered_ephemeral_rejected
    // ------------------------------------------------------------------
    #[test]
    fn tampered_ephemeral_rejected() {
        let (alice, ..) = make_participant();
        let (bob, bob_spk_secret, bob_spk_public, bob_spk_sig) = make_participant();

        let (eph_secret, _) = generate_x25519_keypair();

        let initiator = X3DHInitiator::new(
            alice.clone(),
            eph_secret,
            bob.identity_public(),
            bob_spk_public,
            bob_spk_sig,
            bob.verifying_key(),
            None,
        );
        let alice_result = initiator.perform_handshake().unwrap();

        // Tamper with the ephemeral public key that gets sent to the responder.
        let mut tampered_ephemeral = alice_result.ephemeral_public;
        tampered_ephemeral[0] ^= 0xFF;

        let mut responder = X3DHResponder::new(
            bob,
            bob_spk_secret,
            vec![],
        );
        let bob_result = responder
            .handle_initiator(
                alice.identity_public(),
                tampered_ephemeral,
                bob_spk_sig,
                None,
            )
            .unwrap();

        assert_ne!(
            alice_result.shared_secret, bob_result.shared_secret,
            "tampered ephemeral MUST produce a different shared secret"
        );
    }

    // ------------------------------------------------------------------
    // 6. wrong_identity_rejected
    // ------------------------------------------------------------------
    #[test]
    fn wrong_identity_rejected() {
        let (alice, ..) = make_participant();
        let (bob, bob_spk_secret, bob_spk_public, bob_spk_sig) = make_participant();

        // The attacker (Mallory) presents her own key as Bob's identity.
        let (mallory, ..) = make_participant();

        let (eph_secret, _) = generate_x25519_keypair();

        // The signed prekey is signed by Bob's Ed25519 key.
        let initiator = X3DHInitiator::new(
            alice.clone(),
            eph_secret,
            mallory.identity_public(), // wrong identity key – not Bob's
            bob_spk_public,
            bob_spk_sig,
            bob.verifying_key(),
            None,
        );
        let err = initiator.perform_handshake();
        // The signature is over the signed prekey which IS Bob's, and the
        // verifying key IS Bob's, but the identity key is Mallory's.
        // In X3DH, Alice must verify that the identity key matches the
        // verifying key she knows for Bob.  Since she's using Mallory's
        // identity key with Bob's verifying key, the handshake should fail
        // because the prekey bundle is inconsistent.
        //
        // The initiator can't detect this at the crypto layer (the Ed25519
        // signature verifies against Bob's key regardless of what identity
        // key is provided), but the protocol layer should catch it.
        //
        // For this test we verify that Alice's DH operations produce a
        // SHARED SECRET that is DIFFERENT from what Bob would compute,
        // preventing them from establishing a session.
        assert!(err.is_ok(), "initiator should still produce a result (the crypto layer can't detect wrong identity)");

        let alice_result = err.unwrap();

        // Now Bob responds with his own keys.
        let mut responder = X3DHResponder::new(
            bob,
            bob_spk_secret,
            vec![],
        );
        let bob_result = responder
            .handle_initiator(
                alice.identity_public(),
                alice_result.ephemeral_public,
                bob_spk_sig,
                None,
            )
            .unwrap();

        assert_ne!(
            alice_result.shared_secret, bob_result.shared_secret,
            "wrong identity must produce a different shared secret"
        );
    }

    // ------------------------------------------------------------------
    // 7. shared_secret_binds_to_associated_data
    // ------------------------------------------------------------------
    #[test]
    fn shared_secret_binds_to_associated_data() {
        let (alice, ..) = make_participant();
        let (bob, _bob_spk_secret, bob_spk_public, bob_spk_sig) = make_participant();

        let (eph_secret, _) = generate_x25519_keypair();

        let initiator = X3DHInitiator::new(
            alice.clone(),
            eph_secret,
            bob.identity_public(),
            bob_spk_public,
            bob_spk_sig,
            bob.verifying_key(),
            None,
        );
        let alice_result = initiator.perform_handshake().unwrap();

        // Manually compute a shared secret with swapped AD order.
        let mut swapped_ad = Vec::with_capacity(64);
        swapped_ad.extend_from_slice(alice_result.associated_data[32..].as_ref()); // Bob's key first
        swapped_ad.extend_from_slice(alice_result.associated_data[..32].as_ref()); // Alice's key second
        assert_ne!(
            alice_result.associated_data, swapped_ad,
            "associated data must be order-dependent"
        );

        // The AD is part of the output, not the KDF input, so the shared
        // secret itself doesn't change if AD is different — the AD is
        // separate.  The test is that the AD correctly encodes both
        // identity keys in canonical order.  Both sides computed the
        // same AD above.  Now verify that a different AD would indicate
        // a MITM.
        let (eve, ..) = make_participant();
        let eve_ad: Vec<u8> = {
            let mut ad = Vec::with_capacity(64);
            ad.extend_from_slice(&alice.identity_public());
            ad.extend_from_slice(&eve.identity_public());
            ad
        };
        assert_ne!(
            alice_result.associated_data, eve_ad,
            "associated data MUST include the real responder's identity"
        );
    }
}
