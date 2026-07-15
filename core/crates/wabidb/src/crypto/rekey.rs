use crate::crypto::stream_key_registry::StreamKeyRegistry;
use crate::error::{Result, WabiError};

#[derive(Debug)]
pub struct NewKeyInfo {
    pub stream_id: String,
    pub new_min_commit_seq: u64,
    pub old_max_commit_seq: u64,
}

pub fn channel_rekey(
    stream_id: &str,
    registry: &mut StreamKeyRegistry,
    key_material: [u8; 32],
    at_commit_seq: u64,
) -> Result<NewKeyInfo> {
    if registry.is_destroyed(stream_id) {
        return Err(WabiError::StreamDestroyed {
            stream_id: stream_id.to_string(),
        });
    }

    if !registry.has_stream(stream_id) {
        return Err(WabiError::UnknownStreamKey {
            key_id: stream_id.to_string(),
        });
    }

    registry.rotate_key(stream_id, key_material, at_commit_seq)?;

    Ok(NewKeyInfo {
        stream_id: stream_id.to_string(),
        new_min_commit_seq: at_commit_seq,
        old_max_commit_seq: at_commit_seq.saturating_sub(1),
    })
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

    #[test]
    fn rotate_from_specific_commit_seq() {
        let mut registry = StreamKeyRegistry::new();
        registry.create_stream("ch_01H", test_key(1)).unwrap();

        let info = channel_rekey("ch_01H", &mut registry, test_key(2), 50).unwrap();
        assert_eq!(info.stream_id, "ch_01H");
        assert_eq!(info.new_min_commit_seq, 50);
        assert_eq!(info.old_max_commit_seq, 49);
    }

    #[test]
    fn idempotent_rotation_allows_multiple_rotates() {
        let mut registry = StreamKeyRegistry::new();
        registry.create_stream("ch_01H", test_key(1)).unwrap();

        channel_rekey("ch_01H", &mut registry, test_key(2), 50).unwrap();
        channel_rekey("ch_01H", &mut registry, test_key(3), 100).unwrap();

        assert_eq!(registry.len(), 1);
        assert!(registry.has_stream("ch_01H"));
    }

    #[test]
    fn rekey_unknown_stream_errors() {
        let mut registry = StreamKeyRegistry::new();
        let err = channel_rekey("nonexistent", &mut registry, test_key(1), 1).unwrap_err();
        assert!(matches!(err, WabiError::UnknownStreamKey { .. }));
    }

    #[test]
    fn rekey_destroyed_stream_errors() {
        let mut registry = StreamKeyRegistry::new();
        registry.create_stream("ch_01H", test_key(1)).unwrap();
        registry.destroy_stream("ch_01H").unwrap();
        let err = channel_rekey("ch_01H", &mut registry, test_key(2), 50).unwrap_err();
        assert!(matches!(err, WabiError::StreamDestroyed { .. }));
    }
}
