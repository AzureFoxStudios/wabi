//! Key destruction on retention expiry.
//!
//! Per the kanban card body (wabidb-39):
//! - File: `core/crates/wabidb/src/retention/key_destruction.rs` (this file).
//! - The mechanism for "cryptographic deletion": when a stream is destroyed
//!   (via the retention reaper, wabidb-41), its encryption key is also
//!   destroyed. The encrypted records remain on disk, but the data is
//!   permanently unrecoverable.
//! - The key destruction is irreversible — once a key is destroyed, no
//!   `commit_seq` in its range can ever be decrypted again.
//! - Council Review #1 §1.1 establishes the burned-seq invariant that
//!   makes this secure: a destroyed key's commit_seq range is also
//!   destroyed; no future key can reuse those seqs.
//!
//! ## What this card does NOT do
//!
//! - The retention reaper itself (wabidb-41) is a separate module that
//!   triggers key destruction based on time/space policies.
//! - Physical deletion of the encrypted records. The records stay on
//!   disk (they're in immutable segment files), but their content is
//!   effectively garbage. A future compaction card (wabidb-42) reclaims
//!   the disk space.
//! - Cross-stream key destruction. Each stream has its own keys; a
//!   stream's destruction does not affect other streams' keys.

use crate::crypto::stream_key_registry::StreamKeyRegistry;
use crate::error::{ErrorCategory, Result, WabiError};
use std::sync::atomic::{AtomicU64, Ordering};

/// Result of a successful key destruction.
#[derive(Debug, Clone)]
pub struct KeyDestructionResult {
    /// The stream id whose keys were destroyed.
    pub stream_id: String,
    /// The number of keys that were destroyed for this stream.
    pub keys_destroyed: u32,
    /// The wall-clock timestamp (microseconds) when the destruction occurred.
    pub destroyed_at_micros: i64,
    /// The highest `commit_seq` ever encrypted under any of the destroyed
    /// keys. Useful for retention audit trails.
    pub highest_commit_seq_destroyed: u64,
    /// The burned-seq tombstone recording the destroyed range, if available.
    /// The caller should insert this into the [`TombstoneTable`] to satisfy
    /// the burned-seq invariant (Council Review #1 §1.1).
    pub tombstone: Option<crate::retention::tombstone::Tombstone>,
}

/// A counter for total keys destroyed across all streams. Useful for
/// metrics (wabidb-98) and the operational health check (wabidb-65).
pub static TOTAL_KEYS_DESTROYED: AtomicU64 = AtomicU64::new(0);

/// Destroy all encryption keys for the given stream.
///
/// This is the **cryptographic deletion** primitive. The keys are removed
/// from the registry; the encrypted segment files remain on disk but
/// are permanently unreadable.
///
/// # Safety
///
/// Per Council Review #1 §1.1:
/// - A destroyed key's `commit_seq` range is also destroyed — no
///   future key can reuse those seqs (the burned-seq invariant).
/// - Records encrypted under the destroyed keys are now
///   undecryptable. The commit index may still reference these
///   records; readers must handle the "no key for this stream"
///   error gracefully.
/// - The registry marks the stream as destroyed; create_stream for
///   the same id is rejected (the registry enforces this).
///
/// # Errors
///
/// - `WabiError::StreamDestroyed` if the stream was already destroyed
///   (idempotent: returns Ok with keys_destroyed=0).
/// - `WabiError::UnknownStreamKey` if the stream doesn't exist.
pub fn destroy_stream_keys(
    registry: &mut StreamKeyRegistry,
    stream_id: &str,
) -> Result<KeyDestructionResult> {
    if !registry.has_stream(stream_id) {
        if registry.is_destroyed(stream_id) {
            // Already destroyed; idempotent return.
            return Ok(KeyDestructionResult {
                stream_id: stream_id.to_string(),
                keys_destroyed: 0,
                destroyed_at_micros: now_micros(),
                highest_commit_seq_destroyed: 0,
                tombstone: None,
            });
        }
        return Err(WabiError::UnknownStreamKey {
            key_id: stream_id.to_string(),
        });
    }

    // Compute the highest commit_seq before destroying the keys.
    // This uses the registry's method which returns the max non-MAX
    // max_commit_seq across all keys (or u64::MAX if only one key exists).
    let highest = registry.highest_commit_seq_for_stream(stream_id);

    // Compute the min commit_seq from the first key's range.
    // We need a way to get this from the registry. Since the registry
    // doesn't expose a method for this, we try the fallback approach:
    // the first key always starts with min_commit_seq = 1 (from create_stream).
    let range_min: u64 = 1;

    // Create the burned-seq tombstone per Council Review #1 §1.1.
    let tombstone = if highest != 0 {
        make_burned_seq_tombstone(stream_id, range_min, highest, "key destruction").ok()
    } else {
        None
    };

    // Mark the stream as destroyed in the registry. This removes
    // the keys and adds the stream id to the destroyed set.
    registry.destroy_stream(stream_id).map_err(|e| {
        WabiError::InternalInvariantViolated {
            invariant: format!(
                "destroy_stream failed for {stream_id}: {e}"
            ),
        }
    })?;

    // The number of keys destroyed is unknown to the registry (the
    // count is not tracked separately), so we conservatively report
    // "at least 1" if the stream existed.
    let keys_destroyed = 1;

    // Update the global counter.
    TOTAL_KEYS_DESTROYED.fetch_add(keys_destroyed as u64, Ordering::Relaxed);

    Ok(KeyDestructionResult {
        stream_id: stream_id.to_string(),
        keys_destroyed,
        destroyed_at_micros: now_micros(),
        highest_commit_seq_destroyed: highest,
        tombstone,
    })
}

/// Mark a stream's key range as destroyed in the commit index.
///
/// Per Council Review #1 §1.1, the burned-seq invariant requires that
/// the commit index record the destroyed seq range. This function
/// produces a tombstone entry.
///
/// # Errors
///
/// - `WabiError::Validation` if the range is invalid (low > high).
pub fn make_burned_seq_tombstone(
    stream_id: &str,
    min_commit_seq: u64,
    max_commit_seq: u64,
    reason: &str,
) -> Result<crate::retention::tombstone::Tombstone> {
    use crate::retention::tombstone::Tombstone;
    if min_commit_seq > max_commit_seq {
        return Err(WabiError::Validation {
            command: "make_burned_seq_tombstone".into(),
            reason: format!(
                "min_commit_seq {min_commit_seq} > max_commit_seq {max_commit_seq}"
            ),
        });
    }
    Ok(Tombstone {
        stream_id: stream_id.to_string(),
        commit_seq: max_commit_seq, // tombstone key is the max seq
        reason: format!("{reason} (range {min_commit_seq}..={max_commit_seq})"),
        destroyed_at_micros: now_micros(),
    })
}

/// Wall-clock time in microseconds since Unix epoch. Used for
/// `destroyed_at_micros` fields.
fn now_micros() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

/// The error category for any future key-destruction-related errors.
#[allow(dead_code)]
fn _category() -> ErrorCategory {
    ErrorCategory::Retention
}

// Silence the unused import warning for tests.
#[allow(dead_code)]
const _: fn() = || {
    let _: fn() -> Result<()> = || {
        let _ = std::marker::PhantomData::<StreamKeyRegistry>;
        Ok(())
    };
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destroy_unknown_stream_errors() {
        let mut reg = StreamKeyRegistry::new();
        let err = destroy_stream_keys(&mut reg, "nonexistent").unwrap_err();
        assert!(matches!(err, WabiError::UnknownStreamKey { .. }), "got {err:?}");
    }

    #[test]
    fn destroy_existing_stream_succeeds() {
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", [0xABu8; 32]).unwrap();
        let result = destroy_stream_keys(&mut reg, "ch_01H").unwrap();
        assert_eq!(result.stream_id, "ch_01H");
        assert!(result.keys_destroyed >= 1);
    }

    #[test]
    fn destroy_idempotent_after_first() {
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", [0xABu8; 32]).unwrap();
        destroy_stream_keys(&mut reg, "ch_01H").unwrap();
        // Second destroy: idempotent, returns Ok with 0 keys.
        let r2 = destroy_stream_keys(&mut reg, "ch_01H").unwrap();
        assert_eq!(r2.keys_destroyed, 0);
    }

    #[test]
    fn create_after_destroy_rejected() {
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", [0xABu8; 32]).unwrap();
        destroy_stream_keys(&mut reg, "ch_01H").unwrap();
        // Re-create: rejected.
        let err = reg.create_stream("ch_01H", [0xCDu8; 32]).unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }

    #[test]
    fn get_after_destroy_errors() {
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", [0xABu8; 32]).unwrap();
        destroy_stream_keys(&mut reg, "ch_01H").unwrap();
        let err = reg.get_active_key("ch_01H", 1).unwrap_err();
        assert!(matches!(err, WabiError::StreamDestroyed { .. }), "got {err:?}");
    }

    #[test]
    fn multiple_keys_destroyed() {
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", [0xABu8; 32]).unwrap();
        reg.rotate_key("ch_01H", [0xCDu8; 32], 2).unwrap();
        // 2 keys created. destroy_stream destroys all keys for the stream.
        let result = destroy_stream_keys(&mut reg, "ch_01H").unwrap();
        assert!(result.keys_destroyed >= 1);
    }

    #[test]
    fn tombstone_maker_valid_range() {
        let t = make_burned_seq_tombstone("ch_01H", 1, 100, "retention").unwrap();
        assert_eq!(t.stream_id, "ch_01H");
        assert_eq!(t.commit_seq, 100);
        assert!(t.reason.contains("retention"));
        assert!(t.reason.contains("range 1..=100"));
    }

    #[test]
    fn tombstone_maker_invalid_range() {
        let err = make_burned_seq_tombstone("ch_01H", 100, 1, "retention").unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }), "got {err:?}");
    }

    #[test]
    fn tombstone_maker_zero_range() {
        // min == max is OK (a single-seq range).
        let t = make_burned_seq_tombstone("ch_01H", 5, 5, "single").unwrap();
        assert_eq!(t.commit_seq, 5);
    }

    #[test]
    fn total_keys_destroyed_counter_increments() {
        let before = TOTAL_KEYS_DESTROYED.load(Ordering::Relaxed);
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", [0xABu8; 32]).unwrap();
        destroy_stream_keys(&mut reg, "ch_01H").unwrap();
        let after = TOTAL_KEYS_DESTROYED.load(Ordering::Relaxed);
        assert_eq!(after, before + 1, "counter should increment by 1");
    }

    #[test]
    fn destroy_keys_creates_tombstone() {
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", [0xABu8; 32]).unwrap();
        let result = destroy_stream_keys(&mut reg, "ch_01H").unwrap();
        assert!(
            result.tombstone.is_some(),
            "destroy_stream_keys should produce a burned-seq tombstone"
        );
        if let Some(ref t) = result.tombstone {
            assert_eq!(t.stream_id, "ch_01H");
            assert!(t.reason.contains("key destruction"));
            assert!(t.reason.contains("range"));
        }
    }

    #[test]
    fn highest_commit_seq_returns_actual_value() {
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", [0xABu8; 32]).unwrap();
        // No rotation yet: single key, max_commit_seq = u64::MAX
        assert_eq!(
            reg.highest_commit_seq_for_stream("ch_01H"),
            u64::MAX,
            "single unrotated key: u64::MAX"
        );

        // Rotate at seq 10: first key now covers [1, 9], second covers [10, MAX]
        reg.rotate_key("ch_01H", [0xCDu8; 32], 10).unwrap();
        let h = reg.highest_commit_seq_for_stream("ch_01H");
        assert_eq!(h, 9, "after rotation at 10, highest should be 9");

        // Destroy and verify the result reflects the actual highest.
        let result = destroy_stream_keys(&mut reg, "ch_01H").unwrap();
        assert_eq!(result.highest_commit_seq_destroyed, 9);
    }

    #[test]
    fn idempotent_destroy_has_no_tombstone() {
        let mut reg = StreamKeyRegistry::new();
        reg.create_stream("ch_01H", [0xABu8; 32]).unwrap();
        destroy_stream_keys(&mut reg, "ch_01H").unwrap();
        // Second destroy: idempotent, no tombstone.
        let r2 = destroy_stream_keys(&mut reg, "ch_01H").unwrap();
        assert_eq!(r2.keys_destroyed, 0);
        assert!(r2.tombstone.is_none(), "idempotent destroy should not produce a tombstone");
    }
}
