use crate::crypto::stream_key_registry::StreamKeyRegistry;
use crate::error::{Result, WabiError};

pub fn dm_rekey(
    dm_id: &str,
    user_ids: &[u64],
    registry: &mut StreamKeyRegistry,
    new_key_material: [u8; 32],
    at_commit_seq: u64,
) -> Result<()> {
    if user_ids.is_empty() {
        return Err(WabiError::Validation {
            command: "dm_rekey".into(),
            reason: "DM rekey requires at least one participant".into(),
        });
    }

    if registry.is_destroyed(dm_id) {
        return Err(WabiError::StreamDestroyed {
            stream_id: dm_id.to_string(),
        });
    }

    if !registry.has_stream(dm_id) {
        return Err(WabiError::UnknownStreamKey {
            key_id: dm_id.to_string(),
        });
    }

    registry.rotate_key(dm_id, new_key_material, at_commit_seq)?;

    Ok(())
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
    fn standard_rekey_succeeds() {
        let mut registry = StreamKeyRegistry::new();
        registry.create_stream("dm_01H", test_key(1)).unwrap();

        let user_ids = vec![1001, 1002];
        dm_rekey("dm_01H", &user_ids, &mut registry, test_key(2), 50).unwrap();

        assert!(registry.has_stream("dm_01H"));
    }

    #[test]
    fn empty_participants_rejected() {
        let mut registry = StreamKeyRegistry::new();
        registry.create_stream("dm_01H", test_key(1)).unwrap();

        let user_ids: Vec<u64> = vec![];
        let err = dm_rekey("dm_01H", &user_ids, &mut registry, test_key(2), 50).unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }

    #[test]
    fn rekey_unknown_dm_errors() {
        let mut registry = StreamKeyRegistry::new();
        let err = dm_rekey("unknown", &[1, 2], &mut registry, test_key(1), 1).unwrap_err();
        assert!(matches!(err, WabiError::UnknownStreamKey { .. }));
    }
}
