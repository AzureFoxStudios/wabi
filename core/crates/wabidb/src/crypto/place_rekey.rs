use crate::crypto::stream_key_registry::StreamKeyRegistry;
use crate::error::{Result, WabiError};

pub fn place_rekey(
    place_id: &str,
    registry: &mut StreamKeyRegistry,
    new_key_material: [u8; 32],
    at_commit_seq: u64,
) -> Result<()> {
    if registry.is_destroyed(place_id) {
        return Err(WabiError::StreamDestroyed {
            stream_id: place_id.to_string(),
        });
    }

    if !registry.has_stream(place_id) {
        return Err(WabiError::UnknownStreamKey {
            key_id: place_id.to_string(),
        });
    }

    registry.rotate_key(place_id, new_key_material, at_commit_seq)?;

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
        registry.create_stream("place_01H", test_key(1)).unwrap();

        place_rekey("place_01H", &mut registry, test_key(2), 50).unwrap();

        assert!(registry.has_stream("place_01H"));
    }

    #[test]
    fn rekey_destroyed_rejected() {
        let mut registry = StreamKeyRegistry::new();
        registry.create_stream("place_01H", test_key(1)).unwrap();
        registry.destroy_stream("place_01H").unwrap();

        let err = place_rekey("place_01H", &mut registry, test_key(2), 50).unwrap_err();
        assert!(matches!(err, WabiError::StreamDestroyed { .. }));
    }

    #[test]
    fn rekey_unknown_place_errors() {
        let mut registry = StreamKeyRegistry::new();
        let err = place_rekey("nonexistent", &mut registry, test_key(1), 1).unwrap_err();
        assert!(matches!(err, WabiError::UnknownStreamKey { .. }));
    }
}
