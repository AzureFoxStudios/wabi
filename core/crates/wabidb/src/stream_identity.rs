//! Canonical stream identity helpers shared with replication transports.
//!
//! The commit-index format stores the first 16 bytes of BLAKE3(stream_id).
//! Keep external transports on that exact contract instead of approximating
//! stream identity from directory ordering or segment numbers.

/// First 16 bytes of BLAKE3(stream_id), matching `StreamRef::stream_id_hash`.
pub fn stream_id_hash(stream_id: &str) -> [u8; 16] {
    let hash = blake3::hash(stream_id.as_bytes());
    let mut out = [0u8; 16];
    out.copy_from_slice(&hash.as_bytes()[..16]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_id_hash_is_stable_and_sensitive_to_identity() {
        assert_eq!(stream_id_hash("channel:general"), stream_id_hash("channel:general"));
        assert_ne!(stream_id_hash("channel:general"), stream_id_hash("channel:random"));
        assert_eq!(stream_id_hash("channel:general").len(), 16);
    }
}
