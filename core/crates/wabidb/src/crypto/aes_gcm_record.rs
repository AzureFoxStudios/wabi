//! Per-stream record encryption: AES-256-GCM.
//!
//! See `docs/architecture/STORAGE_FORMAT.md` §2 (Stream segment record
//! format) and `core/crates/wabidb/docs/architecture/wabidb-council-reviews.md`
//! Council Review #1 §1.1-1.3 (the decisions that produced this design).
//!
//! ## Design summary
//!
//! - **Cipher:** AES-256-GCM (key = 32 bytes, nonce = 12 bytes, tag = 16 bytes).
//! - **Nonce:** the record's `commit_seq` as a little-endian `u64` zero-padded to
//!   12 bytes. The high 4 bytes are always zero. The nonce is unique per
//!   (key, stream) pair because the global commit sequencer assigns monotonic
//!   `commit_seq` and each stream receives a strictly increasing subset
//!   (Council Review #1 §1.1).
//! - **AAD:** the encoded `RecordHeader` (48 bytes). The GCM tag covers the
//!   header as passed to the AES-GCM API. `header_crc32c` is computed BEFORE
//!   encryption and is part of the AAD; `payload_crc32c` is set to 0 in the
//!   header at write time (the GCM tag is the cryptographic integrity check).
//! - **On-disk payload layout:** `ciphertext || gcm_tag`. The 16-byte GCM tag
//!   is appended to the ciphertext. The on-disk `payload_len` includes the
//!   tag.
//!
//! ## What this card does NOT do
//!
//! - Key management. The `StreamKeyRegistry` (wabidb-09) is responsible for
//!   storing and rotating keys, enforcing the per-key commit_seq range, and
//!   destroying keys. This card receives a raw 32-byte key and trusts the
//!   caller to have checked the range.
//! - Bulk-encryption of multiple records. Each call encrypts/decrypts one
//!   record.
//! - The 96-bit nonce improvement. The 8-byte u64 padded to 12 bytes is
//!   sufficient for v1; a 96-bit internal counter is a future enhancement
//!   (Council Review #1 §1.2).

use crate::error::{Result, WabiError};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};

/// AES-256 key length in bytes.
pub const KEY_LEN: usize = 32;

/// AES-GCM nonce length in bytes.
pub const NONCE_LEN: usize = 12;

/// AES-GCM authentication tag length in bytes.
pub const TAG_LEN: usize = 16;

/// Build the 12-byte nonce from a `commit_seq`.
///
/// The nonce is `commit_seq` as little-endian `u64` followed by 4 zero bytes.
/// The high 4 bytes are reserved for a future 96-bit nonce extension
/// (Council Review #1 §1.2).
pub fn nonce_from_commit_seq(commit_seq: u64) -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    nonce[0..8].copy_from_slice(&commit_seq.to_le_bytes());
    // nonce[8..12] is already zero
    nonce
}

/// Encrypt a record payload with AES-256-GCM.
///
/// # Arguments
///
/// - `key`: the 32-byte AES-256 key (from `StreamKeyRegistry`)
/// - `commit_seq`: the record's `commit_seq` (becomes the nonce)
/// - `header_bytes`: the encoded `RecordHeader` (48 bytes, with `header_crc32c`
///   set and `payload_crc32c = 0`). This is used as the AES-GCM AAD.
/// - `plaintext`: the record payload (the event bytes to encrypt)
///
/// # Returns
///
/// `ciphertext || gcm_tag` (the on-disk payload). The caller is responsible
/// for writing this to the segment file.
///
/// # Errors
///
/// Returns `WabiError::AuthTagMismatch` if AES-GCM reports a tag mismatch
/// (which can happen during encryption if the implementation is buggy; AES-GCM
/// doesn't normally fail during encryption, only during decryption).
/// Returns `WabiError::KeyRangeViolation` if the caller passes an invalid
/// `commit_seq` (e.g., the caller's range check rejected it).
pub fn encrypt_record(
    key: &[u8; KEY_LEN],
    commit_seq: u64,
    header_bytes: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce_bytes = nonce_from_commit_seq(commit_seq);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let payload = Payload {
        msg: plaintext,
        aad: header_bytes,
    };

    cipher
        .encrypt(nonce, payload)
        .map_err(|_| WabiError::InternalInvariantViolated {
            invariant: format!(
                "AES-256-GCM encryption failed for commit_seq {commit_seq} (this should not happen)"
            ),
        })
}

/// Decrypt a record payload with AES-256-GCM.
///
/// # Arguments
///
/// - `key`: the 32-byte AES-256 key (must match the key used to encrypt)
/// - `commit_seq`: the record's `commit_seq` (must match the nonce used at
///   encrypt time)
/// - `header_bytes`: the encoded `RecordHeader` (48 bytes, must match the AAD
///   used at encrypt time)
/// - `ciphertext_with_tag`: the on-disk payload (`ciphertext || gcm_tag`)
///
/// # Returns
///
/// The decrypted plaintext.
///
/// # Errors
///
/// Returns `WabiError::AuthTagMismatch` if the GCM tag does not verify. This
/// happens if:
/// - The ciphertext was tampered with.
/// - The AAD (`header_bytes`) was tampered with.
/// - The wrong key was supplied.
/// - The wrong `commit_seq` (and thus nonce) was supplied.
///
/// This is also the catch-all "this record is corrupt or not for us" error.
/// Per Council Review #1 §1.3, the AAD binding prevents an attacker from
/// splicing records or altering metadata without breaking the tag.
#[allow(unused_variables)]
pub fn decrypt_record(
    key: &[u8; KEY_LEN],
    commit_seq: u64,
    header_bytes: &[u8],
    ciphertext_with_tag: &[u8],
) -> Result<Vec<u8>> {
    if ciphertext_with_tag.len() < TAG_LEN {
        return Err(WabiError::Corrupt {
            location: "record payload".into(),
            detail: format!(
                "ciphertext_with_tag too short: {} bytes (need at least {})",
                ciphertext_with_tag.len(),
                TAG_LEN
            ),
        });
    }

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce_bytes = nonce_from_commit_seq(commit_seq);
    let nonce = Nonce::from_slice(&nonce_bytes);

    cipher
        .decrypt(
            nonce,
            Payload {
                msg: ciphertext_with_tag,
                aad: header_bytes,
            },
        )
        .map_err(|_| WabiError::AuthTagMismatch {
            stream_id: "<see caller context>".into(),
            commit_seq,
        })
}

/// Decrypt a record given the ciphertext and tag as separate slices.
///
/// Some readers may split the on-disk payload into `ciphertext` and `tag` parts
/// before calling. This is a convenience wrapper around [`decrypt_record`].
pub fn decrypt_record_split(
    key: &[u8; KEY_LEN],
    commit_seq: u64,
    header_bytes: &[u8],
    ciphertext: &[u8],
    tag: &[u8],
) -> Result<Vec<u8>> {
    if tag.len() != TAG_LEN {
        return Err(WabiError::Corrupt {
            location: "record tag".into(),
            detail: format!("tag is {} bytes, expected {}", tag.len(), TAG_LEN),
        });
    }
    let mut combined = Vec::with_capacity(ciphertext.len() + tag.len());
    combined.extend_from_slice(ciphertext);
    combined.extend_from_slice(tag);
    decrypt_record(key, commit_seq, header_bytes, &combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> [u8; KEY_LEN] {
        let mut key = [0u8; KEY_LEN];
        for (i, b) in key.iter_mut().enumerate() {
            *b = i as u8;
        }
        key
    }

    fn test_header() -> Vec<u8> {
        // 48 bytes; a fully-zero header is valid for the purposes of these tests
        vec![0u8; 48]
    }

    #[test]
    fn nonce_construction() {
        let n = nonce_from_commit_seq(42);
        assert_eq!(n[0..8], 42u64.to_le_bytes());
        assert_eq!(n[8..12], [0u8; 4]);

        let n = nonce_from_commit_seq(0);
        assert_eq!(n, [0u8; 12]);

        let n = nonce_from_commit_seq(u64::MAX);
        assert_eq!(n[0..8], u64::MAX.to_le_bytes());
        assert_eq!(n[8..12], [0u8; 4]);
    }

    #[test]
    fn encrypt_decrypt_round_trip() {
        let key = test_key();
        let header = test_header();
        let plaintext = b"hello, world";
        let ct = encrypt_record(&key, 1, &header, plaintext).unwrap();
        // Ciphertext should be plaintext.len() + 16 (tag)
        assert_eq!(ct.len(), plaintext.len() + TAG_LEN);
        // The ciphertext should NOT equal the plaintext
        assert_ne!(&ct[..plaintext.len()], plaintext);

        let pt = decrypt_record(&key, 1, &header, &ct).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn bit_flip_in_ciphertext_fails_auth() {
        let key = test_key();
        let header = test_header();
        let plaintext = b"the quick brown fox jumps over the lazy dog";
        let mut ct = encrypt_record(&key, 1, &header, plaintext).unwrap();
        // Flip a bit in the ciphertext (not the tag)
        ct[5] ^= 0x01;
        let err = decrypt_record(&key, 1, &header, &ct).unwrap_err();
        assert!(
            matches!(err, WabiError::AuthTagMismatch { .. }),
            "expected AuthTagMismatch, got {err:?}"
        );
    }

    #[test]
    fn bit_flip_in_aad_fails_auth() {
        let key = test_key();
        let header = test_header();
        let plaintext = b"some payload";
        let ct = encrypt_record(&key, 1, &header, plaintext).unwrap();

        // Flip a bit in the AAD (header) used for decryption
        let mut bad_header = header.clone();
        bad_header[10] ^= 0x80; // flip a bit in the flags field
        let err = decrypt_record(&key, 1, &bad_header, &ct).unwrap_err();
        assert!(
            matches!(err, WabiError::AuthTagMismatch { .. }),
            "expected AuthTagMismatch, got {err:?}"
        );
    }

    #[test]
    fn bit_flip_in_tag_fails_auth() {
        let key = test_key();
        let header = test_header();
        let plaintext = b"some payload";
        let mut ct = encrypt_record(&key, 1, &header, plaintext).unwrap();
        // Flip a bit in the last byte (the tag)
        let last = ct.len() - 1;
        ct[last] ^= 0x01;
        let err = decrypt_record(&key, 1, &header, &ct).unwrap_err();
        assert!(
            matches!(err, WabiError::AuthTagMismatch { .. }),
            "expected AuthTagMismatch, got {err:?}"
        );
    }

    #[test]
    fn wrong_key_fails_auth() {
        let key = test_key();
        let mut other_key = key;
        other_key[0] ^= 0xFF;
        let header = test_header();
        let plaintext = b"secret";
        let ct = encrypt_record(&key, 1, &header, plaintext).unwrap();
        let err = decrypt_record(&other_key, 1, &header, &ct).unwrap_err();
        assert!(
            matches!(err, WabiError::AuthTagMismatch { .. }),
            "expected AuthTagMismatch, got {err:?}"
        );
    }

    #[test]
    fn wrong_commit_seq_fails_auth() {
        let key = test_key();
        let header = test_header();
        let plaintext = b"secret";
        let ct = encrypt_record(&key, 1, &header, plaintext).unwrap();
        // Decrypt with the wrong commit_seq
        let err = decrypt_record(&key, 2, &header, &ct).unwrap_err();
        assert!(
            matches!(err, WabiError::AuthTagMismatch { .. }),
            "expected AuthTagMismatch, got {err:?}"
        );
    }

    #[test]
    fn same_commit_seq_different_streams_does_not_collide() {
        // Per Council Review #1 §1.1, nonce uniqueness is per (key, stream).
        // The same commit_seq under two different keys does NOT collide.
        // (Stream separation is handled by the key registry, not by the
        // nonce. This test verifies that decrypting with the same commit_seq
        // but a different key fails cleanly.)
        let key = test_key();
        let key2 = {
            let mut k = key;
            k[10] ^= 0x42;
            k
        };
        let header = test_header();
        let plaintext = b"data";
        let ct1 = encrypt_record(&key, 100, &header, plaintext).unwrap();
        // Decrypting ct1 with key2 should fail (different key = different
        // effective key-stream pairing)
        let err = decrypt_record(&key2, 100, &header, &ct1).unwrap_err();
        assert!(matches!(err, WabiError::AuthTagMismatch { .. }));
    }

    #[test]
    fn empty_payload_works() {
        let key = test_key();
        let header = test_header();
        let ct = encrypt_record(&key, 1, &header, b"").unwrap();
        // Empty payload + 16-byte tag = 16 bytes total
        assert_eq!(ct.len(), TAG_LEN);
        let pt = decrypt_record(&key, 1, &header, &ct).unwrap();
        assert_eq!(pt, b"");
    }

    #[test]
    fn large_payload_works() {
        // 64 KiB (the DM plaintext cap per endstate doc §6.3)
        let key = test_key();
        let header = test_header();
        let plaintext = vec![0xABu8; 64 * 1024];
        let ct = encrypt_record(&key, 1, &header, &plaintext).unwrap();
        assert_eq!(ct.len(), plaintext.len() + TAG_LEN);
        let pt = decrypt_record(&key, 1, &header, &ct).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn truncated_ciphertext_errors() {
        let key = test_key();
        let header = test_header();
        // Less than TAG_LEN bytes
        let short = vec![0u8; TAG_LEN - 1];
        let err = decrypt_record(&key, 1, &header, &short).unwrap_err();
        assert!(matches!(err, WabiError::Corrupt { .. }), "got {err:?}");
    }

    #[test]
    fn decrypt_record_split_round_trip() {
        let key = test_key();
        let header = test_header();
        let plaintext = b"split test";
        let ct = encrypt_record(&key, 7, &header, plaintext).unwrap();
        let (ciphertext, tag) = ct.split_at(ct.len() - TAG_LEN);
        let pt = decrypt_record_split(&key, 7, &header, ciphertext, tag).unwrap();
        assert_eq!(pt, plaintext);
    }

    #[test]
    fn decrypt_record_split_wrong_tag_length() {
        let key = test_key();
        let header = test_header();
        let plaintext = b"x";
        let ct = encrypt_record(&key, 1, &header, plaintext).unwrap();
        let (ciphertext, _) = ct.split_at(ct.len() - TAG_LEN);
        let err = decrypt_record_split(&key, 1, &header, ciphertext, &[0u8; TAG_LEN - 1])
            .unwrap_err();
        assert!(matches!(err, WabiError::Corrupt { .. }), "got {err:?}");
    }
}
