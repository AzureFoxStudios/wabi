//! Canonical stream identity helpers shared with replication transports.
//!
//! The commit-index format stores the first 16 bytes of BLAKE3(stream_id).
//! Keep external transports on that exact contract instead of approximating
//! stream identity from directory ordering or segment numbers.

/// Maximum UTF-8 byte length for a stream directory component.
pub const MAX_STREAM_ID_BYTES: usize = 255;

/// Whether an ID can be used as one stream directory component.
///
/// Preserve existing Unicode identities, including emoji reaction-removal
/// streams. An ASCII-only allow-list would reject valid durable history.
/// Never normalize or truncate: the exact bytes also identify the stream key.
pub fn is_safe_stream_id(stream_id: &str) -> bool {
    !stream_id.is_empty()
        && stream_id.len() <= MAX_STREAM_ID_BYTES
        && !matches!(stream_id, "." | "..")
        && !stream_id.chars().any(|character| {
            matches!(character, '/' | '\\' | '\0') || character.is_control()
        })
}

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
    fn stream_ids_are_bounded_single_components_without_losing_unicode_identity() {
        for id in ["channel:general", "reactions:msg_1:👍🏽:removed", "legacy.room-1"] {
            assert!(is_safe_stream_id(id), "valid stream identity rejected: {id}");
        }
        assert!(is_safe_stream_id(&"a".repeat(MAX_STREAM_ID_BYTES)));
        assert!(!is_safe_stream_id(&"a".repeat(MAX_STREAM_ID_BYTES + 1)));
        assert!(!is_safe_stream_id(&"👍".repeat(64)), "bound is bytes, not characters");
        for id in ["", ".", "..", "../outside", "/absolute", "nested/stream", "nested\\stream", "bad\0id", "bad\nid", "bad\u{7f}id"] {
            assert!(!is_safe_stream_id(id), "unsafe stream identity accepted: {id:?}");
        }
    }

    #[test]
    fn stream_id_hash_is_stable_and_sensitive_to_identity() {
        assert_eq!(stream_id_hash("channel:general"), stream_id_hash("channel:general"));
        assert_ne!(stream_id_hash("channel:general"), stream_id_hash("channel:random"));
        assert_eq!(stream_id_hash("channel:general").len(), 16);
    }
}
