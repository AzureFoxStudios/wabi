//! Idempotency table for command replay detection.
//!
//! Stores the result of each command keyed by `(caller_user_id, client_request_id)`
//! so that replaying the same request returns the cached result instead of
//! re-executing.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::{Result, WabiError};

/// A cached command result for idempotency replay.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandIdempotencyRecord {
    /// The user who issued the command.
    pub caller_user_id: u64,
    /// The client-provided idempotency key.
    pub client_request_id: String,
    /// The name of the command (e.g. "send_message").
    pub command_name: String,
    /// Serialized result data. The first 8 bytes encode the `commit_seq` as a
    /// little-endian u64; callers may store additional payload after it.
    pub result_blob: Vec<u8>,
    /// Unix timestamp (seconds) when this record was created.
    pub created_at: i64,
    /// Unix timestamp (seconds) after which this record is considered expired.
    pub expires_at: i64,
}

impl CommandIdempotencyRecord {
    /// Extract the `commit_seq` from the first 8 bytes of the result blob.
    pub fn commit_seq(&self) -> u64 {
        let bytes: [u8; 8] = self.result_blob[..8].try_into().unwrap_or([0; 8]);
        u64::from_le_bytes(bytes)
    }
}

/// An in-memory idempotency table backed by a `HashMap`.
///
/// The key is `(caller_user_id, client_request_id)`.
#[derive(Debug, Default)]
pub struct CommandIdempotencyTable {
    records: HashMap<(u64, String), CommandIdempotencyRecord>,
}

impl CommandIdempotencyTable {
    /// Create a new empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a record into the table.
    pub fn insert(&mut self, record: CommandIdempotencyRecord) {
        let key = (record.caller_user_id, record.client_request_id.clone());
        self.records.insert(key, record);
    }

    /// Look up a record by `(caller_user_id, client_request_id)`.
    pub fn lookup(
        &self,
        caller_user_id: u64,
        client_request_id: &str,
    ) -> Option<&CommandIdempotencyRecord> {
        self.records
            .get(&(caller_user_id, client_request_id.to_string()))
    }

    /// Remove all expired records (those whose `expires_at < now`).
    ///
    /// Returns the removed records so callers can, for example, log or
    /// aggregate them.
    pub fn remove_expired(&mut self, now: i64) -> Vec<CommandIdempotencyRecord> {
        let mut removed = Vec::new();
        self.records.retain(|_, record| {
            if record.expires_at < now {
                removed.push(record.clone());
                false
            } else {
                true
            }
        });
        removed
    }

    /// Check-and-store semantics for idempotency.
    ///
    /// If a record with the same `(caller_user_id, client_request_id)` exists
    /// **and** has not expired, returns `Err(WabiError::IdempotentReplay)`
    /// with the original `commit_seq`.
    ///
    /// Otherwise (no record, or the existing record is expired), inserts the
    /// new record and returns `Ok(())`.
    pub fn check_and_store(
        &mut self,
        record: CommandIdempotencyRecord,
        now: i64,
    ) -> Result<()> {
        let key = (record.caller_user_id, record.client_request_id.clone());
        if let Some(existing) = self.records.get(&key) {
            if existing.expires_at >= now {
                return Err(WabiError::IdempotentReplay {
                    commit_seq: existing.commit_seq(),
                });
            }
        }
        self.records.insert(key, record);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_record(
        caller_user_id: u64,
        client_request_id: &str,
        commit_seq: u64,
        expires_at: i64,
    ) -> CommandIdempotencyRecord {
        CommandIdempotencyRecord {
            caller_user_id,
            client_request_id: client_request_id.to_string(),
            command_name: "test_command".to_string(),
            result_blob: commit_seq.to_le_bytes().to_vec(),
            created_at: 1000,
            expires_at,
        }
    }

    #[test]
    fn insert_and_lookup() {
        let mut table = CommandIdempotencyTable::new();
        let record = make_record(1, "req-1", 42, 2000);
        table.insert(record);

        let found = table.lookup(1, "req-1");
        assert!(found.is_some());
        assert_eq!(found.unwrap().commit_seq(), 42);
    }

    #[test]
    fn lookup_missing_returns_none() {
        let table = CommandIdempotencyTable::new();
        assert!(table.lookup(1, "nonexistent").is_none());
    }

    #[test]
    fn remove_expired_evicts_stale_records() {
        let mut table = CommandIdempotencyTable::new();
        table.insert(make_record(1, "expired", 10, 500));
        table.insert(make_record(2, "valid", 20, 2000));
        table.insert(make_record(3, "also-expired", 30, 800));

        let removed = table.remove_expired(1000);
        assert_eq!(removed.len(), 2);

        // Valid record survives
        assert!(table.lookup(2, "valid").is_some());
        // Expired records are gone
        assert!(table.lookup(1, "expired").is_none());
        assert!(table.lookup(3, "also-expired").is_none());
    }

    #[test]
    fn check_and_store_detects_replay() {
        let mut table = CommandIdempotencyTable::new();

        // First call succeeds
        let record = make_record(1, "req-1", 42, 2000);
        table.check_and_store(record, 1000).unwrap();

        // Second call with same key detects replay
        let replay = make_record(1, "req-1", 99, 3000);
        let err = table.check_and_store(replay, 1000).unwrap_err();
        match err {
            WabiError::IdempotentReplay { commit_seq } => {
                assert_eq!(commit_seq, 42, "expected original commit_seq");
            }
            _ => panic!("expected IdempotentReplay, got {err:?}"),
        }
    }

    #[test]
    fn check_and_store_expired_allows_insert() {
        let mut table = CommandIdempotencyTable::new();

        // First call with an already-expired record
        let record = make_record(1, "req-1", 42, 500);
        table.check_and_store(record, 1000).unwrap();

        // The expired record was replaced with a fresh one
        let fresh = make_record(1, "req-1", 99, 2000);
        table.check_and_store(fresh, 1000).unwrap();

        let found = table.lookup(1, "req-1").unwrap();
        assert_eq!(found.commit_seq(), 99, "should reflect the newer record");
    }
}
