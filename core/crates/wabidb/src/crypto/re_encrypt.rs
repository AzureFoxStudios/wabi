use crate::crypto::aes_gcm_record::{decrypt_record, encrypt_record, KEY_LEN};
use crate::crypto::stream_key_registry::StreamKeyRegistry;
use crate::error::Result;
use crate::format::record::RecordHeader;

#[derive(Debug)]
pub struct ReEncryptedRecord {
    pub header: RecordHeader,
    pub ciphertext: Vec<u8>,
}

pub fn force_re_encrypt(
    header: &RecordHeader,
    payload: &[u8],
    old_key: &[u8; KEY_LEN],
    new_key: &[u8; KEY_LEN],
) -> Result<ReEncryptedRecord> {
    let header_bytes = header.encode();

    let plaintext = decrypt_record(old_key, header.commit_seq, &header_bytes, payload)?;

    let new_header = RecordHeader::new(
        header.record_kind,
        header.commit_seq,
        header.stream_id_hash,
        plaintext.len() as u32,
        header.payload_crc32c,
    );
    let new_header_bytes = new_header.encode();
    let new_ciphertext = encrypt_record(new_key, header.commit_seq, &new_header_bytes, &plaintext)?;

    Ok(ReEncryptedRecord {
        header: new_header,
        ciphertext: new_ciphertext,
    })
}

pub fn force_re_encrypt_with_registry(
    header: &RecordHeader,
    payload: &[u8],
    stream_id: &str,
    registry: &StreamKeyRegistry,
    new_key_material: [u8; 32],
) -> Result<ReEncryptedRecord> {
    let old_key = registry.get_active_key(stream_id, header.commit_seq)?;

    force_re_encrypt(header, payload, &old_key.key_material, &new_key_material)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::WabiError;

    fn test_key(seed: u8) -> [u8; 32] {
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = seed.wrapping_add(i as u8);
        }
        k
    }

    fn sample_header(commit_seq: u64) -> RecordHeader {
        RecordHeader::new(
            crate::format::record::RecordKind::Event,
            commit_seq,
            [0xABu8; 16],
            8,
            0,
        )
    }

    #[test]
    fn re_encrypt_with_valid_old_key_succeeds() {
        let old_key = test_key(1);
        let new_key = test_key(2);
        let header = sample_header(1);
        let payload = b"test data";

        let header_bytes = header.encode();
        let ciphertext = encrypt_record(&old_key, 1, &header_bytes, payload).unwrap();

        let result = force_re_encrypt(&header, &ciphertext, &old_key, &new_key).unwrap();
        assert_eq!(result.header.commit_seq, 1);
        assert!(!result.ciphertext.is_empty());
    }

    #[test]
    fn re_encrypt_with_wrong_old_key_rejected() {
        let old_key = test_key(1);
        let wrong_key = test_key(99);
        let new_key = test_key(2);
        let header = sample_header(1);
        let payload = b"test data";

        let header_bytes = header.encode();
        let ciphertext = encrypt_record(&old_key, 1, &header_bytes, payload).unwrap();

        let err = force_re_encrypt(&header, &ciphertext, &wrong_key, &new_key).unwrap_err();
        assert!(matches!(err, WabiError::AuthTagMismatch { .. }));
    }
}
