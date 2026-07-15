//! Per-stream encryption key registry.
//!
//! See `core/crates/wabidb/docs/architecture/wabidb-council-reviews.md`
//! Council Review #1 §1.1 for the rationale behind the key-range tracking
//! and the burned-seq invariant.
//!
//! # Invariants (Council Review #1 §1.1)
//!
//! - A key is only used for a contiguous `[min_commit_seq, max_commit_seq]`
//!   range.
//! - On rotation: the previously active key gets its `max_commit_seq` set to
//!   `new_min_commit_seq - 1`, ensuring ranges never overlap and no nonce is
//!   ever reused with two different keys.
//! - Destroyed streams are irrevocable: the engine is permanently unable to
//!   decrypt that stream's segments.

use std::collections::{HashMap, HashSet};

use crate::error::{Result, WabiError};
use rand::Rng;
use zeroize::Zeroize;

/// A single stream's encryption key plus its allowed commit_seq range.
#[derive(Debug, Clone, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
pub struct StreamKey {
    /// The 32-byte AES-256 key.
    pub key_material: [u8; 32],
    /// ULID identifier for this key (used in `consume_one_time_prekey` etc.).
    pub key_id: String,
    /// Minimum `commit_seq` this key may encrypt.
    pub min_commit_seq: u64,
    /// Maximum `commit_seq` this key may encrypt.
    pub max_commit_seq: u64,
}

/// In-memory registry of stream encryption keys.
#[derive(Debug, Default)]
pub struct StreamKeyRegistry {
    keys: HashMap<String, Vec<StreamKey>>,
    destroyed: HashSet<String>,
}

impl Drop for StreamKeyRegistry {
    fn drop(&mut self) {
        // Zero all key material before dropping.
        for (_stream_id, keys) in self.keys.iter_mut() {
            for key in keys.iter_mut() {
                key.key_material.zeroize();
            }
        }
        // Clear the rest.
        self.keys.clear();
        self.destroyed.clear();
    }
}

fn generate_key_id() -> String {
    let bytes: [u8; 10] = rand::thread_rng().gen();
    hex::encode(bytes)
}

impl StreamKeyRegistry {
    /// Create an empty registry.
    pub fn new() -> Self {
        Self::default()
    }

    /// Register the first key for a stream.
    pub fn create_stream(&mut self, stream_id: &str, key_material: [u8; 32]) -> Result<()> {
        if stream_id.is_empty() {
            return Err(WabiError::Validation {
                command: "create_stream".into(),
                reason: "stream_id must not be empty".into(),
            });
        }
        if self.keys.contains_key(stream_id) {
            return Err(WabiError::Validation {
                command: "create_stream".into(),
                reason: format!("stream {stream_id} already exists"),
            });
        }
        if self.destroyed.contains(stream_id) {
            return Err(WabiError::Validation {
                command: "create_stream".into(),
                reason: format!("stream {stream_id} was destroyed and cannot be re-created"),
            });
        }
        let key = StreamKey {
            key_material,
            key_id: generate_key_id(),
            min_commit_seq: 1,
            max_commit_seq: u64::MAX,
        };
        self.keys.insert(stream_id.to_string(), vec![key]);
        Ok(())
    }

    /// Return the key whose range contains `commit_seq`.
    pub fn get_active_key(&self, stream_id: &str, commit_seq: u64) -> Result<&StreamKey> {
        if self.destroyed.contains(stream_id) {
            return Err(WabiError::StreamDestroyed {
                stream_id: stream_id.to_string(),
            });
        }
        let stream_keys = self.keys.get(stream_id).ok_or_else(|| WabiError::UnknownStreamKey {
            key_id: stream_id.to_string(),
        })?;
        for key in stream_keys.iter().rev() {
            if commit_seq >= key.min_commit_seq && commit_seq <= key.max_commit_seq {
                return Ok(key);
            }
        }
        Err(WabiError::KeyRangeViolation {
            key_id: stream_id.to_string(),
            min_commit_seq: stream_keys.first().map(|k| k.min_commit_seq).unwrap_or(0),
            attempted_commit_seq: commit_seq,
        })
    }

    /// Rotate the active key for a stream at a specific commit sequence.
    ///
    /// The new key covers the range `[at_commit_seq, u64::MAX]`. The previous
    /// key's range is closed to `[prev_min, at_commit_seq - 1]` (or 0 if
    /// `at_commit_seq` is 0), ensuring ranges never overlap.
    pub fn rotate_key(
        &mut self,
        stream_id: &str,
        key_material: [u8; 32],
        at_commit_seq: u64,
    ) -> Result<()> {
        if self.destroyed.contains(stream_id) {
            return Err(WabiError::StreamDestroyed {
                stream_id: stream_id.to_string(),
            });
        }
        let stream_keys = self.keys.get_mut(stream_id).ok_or_else(|| WabiError::UnknownStreamKey {
            key_id: stream_id.to_string(),
        })?;
        // Close the previous key's range
        if let Some(last) = stream_keys.last_mut() {
            last.max_commit_seq = at_commit_seq.saturating_sub(1);
        }
        let new_key = StreamKey {
            key_material,
            key_id: generate_key_id(),
            min_commit_seq: at_commit_seq,
            max_commit_seq: u64::MAX,
        };
        stream_keys.push(new_key);
        Ok(())
    }

    /// Remove all keys for a stream and mark it destroyed.
    pub fn destroy_stream(&mut self, stream_id: &str) -> Result<()> {
        if self.destroyed.contains(stream_id) {
            return Ok(()); // already destroyed
        }
        self.keys.remove(stream_id);
        self.destroyed.insert(stream_id.to_string());
        Ok(())
    }

    /// Whether the stream has been destroyed.
    pub fn is_destroyed(&self, stream_id: &str) -> bool {
        self.destroyed.contains(stream_id)
    }

    /// Whether the stream exists (active).
    pub fn has_stream(&self, stream_id: &str) -> bool {
        self.keys.contains_key(stream_id)
    }

    /// The highest `commit_seq` actually used by any key in this stream,
    /// excluding the sentinel `u64::MAX` from the active (unrotated) key.
    /// Returns `0` if the stream does not exist, or `u64::MAX` if only a
    /// single unrotated key exists (the actual max is unknown).
    pub fn highest_commit_seq_for_stream(&self, stream_id: &str) -> u64 {
        if let Some(stream_keys) = self.keys.get(stream_id) {
            let mut max_seen = 0u64;
            for key in stream_keys {
                if key.max_commit_seq != u64::MAX {
                    max_seen = max_seen.max(key.max_commit_seq);
                }
            }
            if max_seen > 0 {
                max_seen
            } else {
                u64::MAX
            }
        } else {
            0
        }
    }

    /// Number of active streams.
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    /// Whether the registry is empty.
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key(seed: u8) -> [u8; 32] {
        let mut k = [0u8; 32];
        for (i, b) in k.iter_mut().enumerate() {
            *b = seed.wrapping_add(i as u8);
        }
        k
    }

    #[test]
    fn create_and_get() {
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", test_key(1)).unwrap();
        let key = reg.get_active_key("ch_01H", 1).unwrap();
        assert_eq!(key.key_material, test_key(1));
    }

    #[test]
    fn create_empty_stream_id_rejected() {
        let mut reg = StreamKeyRegistry::new();
        let err = reg.create_stream("", test_key(1)).unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }

    #[test]
    fn duplicate_create_rejected() {
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", test_key(1)).unwrap();
        let err = reg.create_stream("ch_01H", test_key(2)).unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }

    #[test]
    fn get_unknown_stream_errors() {
        let reg = StreamKeyRegistry::new();
        let err = reg.get_active_key("nope", 1).unwrap_err();
        assert!(matches!(err, WabiError::UnknownStreamKey { .. }));
    }

    #[test]
    fn rotate_spans_both_ranges() {
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", test_key(1)).unwrap();
        // First key covers seq 1 to u64::MAX
        let _ = reg.get_active_key("ch_01H", 1).unwrap();
        // Rotate at seq 2: previous key's range is closed, new key gets a new range
        reg.rotate_key("ch_01H", test_key(2), 2).unwrap();
        // Both keys are present
        assert_eq!(reg.keys.get("ch_01H").unwrap().len(), 2);
    }

    #[test]
    fn rotate_key_at_specific_seq_produces_usable_key() {
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", test_key(1)).unwrap();
        // First key covers seq [1, u64::MAX]
        // Rotate at seq 50: old key gets [1, 49], new key gets [50, MAX]
        reg.rotate_key("ch_01H", test_key(2), 50).unwrap();
        // get_active_key(100) returns the new key
        let key = reg.get_active_key("ch_01H", 100).unwrap();
        assert_eq!(key.key_material, test_key(2));
        // get_active_key(50) returns the new key
        let key = reg.get_active_key("ch_01H", 50).unwrap();
        assert_eq!(key.key_material, test_key(2));
        // get_active_key(49) returns the old key
        let key = reg.get_active_key("ch_01H", 49).unwrap();
        assert_eq!(key.key_material, test_key(1));
    }

    #[test]
    fn destroy_then_get_errors() {
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", test_key(1)).unwrap();
        reg.destroy_stream("ch_01H").unwrap();
        let err = reg.get_active_key("ch_01H", 1).unwrap_err();
        assert!(matches!(err, WabiError::StreamDestroyed { .. }));
    }

    #[test]
    fn re_create_after_destroy_rejected() {
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", test_key(1)).unwrap();
        reg.destroy_stream("ch_01H").unwrap();
        let err = reg.create_stream("ch_01H", test_key(2)).unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }

    #[test]
    fn len_and_is_empty() {
        let mut reg = StreamKeyRegistry::new();
        assert!(reg.is_empty());
        assert_eq!(reg.len(), 0);
        reg.create_stream("ch_01H", test_key(1)).unwrap();
        assert!(!reg.is_empty());
        assert_eq!(reg.len(), 1);
    }
}
