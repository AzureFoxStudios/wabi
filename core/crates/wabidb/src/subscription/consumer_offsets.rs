//! Consumer offset tracking for reliable subscription checkpoints.
//!
//! Stores the last committed sequence number a consumer has processed for a
//! given topic pattern, enabling resume after disconnect without data loss.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// A record tracking a consumer's progress on a topic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsumerOffsetRecord {
    /// The consumer identifier (e.g. device id, session id).
    pub consumer_id: String,
    /// The topic pattern the consumer is subscribed to.
    pub topic_pattern: String,
    /// The highest `commit_seq` the consumer has acknowledged.
    pub last_commit_seq: u64,
    /// Unix timestamp (seconds) when this record was last updated.
    pub updated_at: i64,
}

/// An in-memory table of consumer offsets backed by a `HashMap`.
///
/// The key is `(consumer_id, topic_pattern)`.
#[derive(Debug, Default)]
pub struct ConsumerOffsetsTable {
    offsets: HashMap<(String, String), ConsumerOffsetRecord>,
}

impl ConsumerOffsetsTable {
    /// Create a new empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert or update a consumer offset record.
    ///
    /// If a record for the same `(consumer_id, topic_pattern)` already exists,
    /// it is replaced.
    pub fn upsert(&mut self, record: ConsumerOffsetRecord) {
        let key = (record.consumer_id.clone(), record.topic_pattern.clone());
        self.offsets.insert(key, record);
    }

    /// Look up the offset record for a specific `(consumer_id, topic_pattern)`.
    pub fn lookup(
        &self,
        consumer_id: &str,
        topic_pattern: &str,
    ) -> Option<&ConsumerOffsetRecord> {
        self.offsets
            .get(&(consumer_id.to_string(), topic_pattern.to_string()))
    }

    /// Return all offset records for a given consumer (across all topics).
    pub fn get_offsets_for_consumer(&self, consumer_id: &str) -> Vec<&ConsumerOffsetRecord> {
        self.offsets
            .iter()
            .filter(|((cid, _), _)| cid == consumer_id)
            .map(|(_, record)| record)
            .collect()
    }

    /// Advance the consumer's acknowledged offset for a topic.
    ///
    /// Returns the previous `last_commit_seq` value (or `0` if no prior record
    /// existed).
    pub fn checkpoint_commit(
        &mut self,
        consumer_id: &str,
        topic_pattern: &str,
        last_commit_seq: u64,
        now: i64,
    ) -> u64 {
        let key = (consumer_id.to_string(), topic_pattern.to_string());
        let prev = self
            .offsets
            .get(&key)
            .map(|r| r.last_commit_seq)
            .unwrap_or(0);

        self.offsets.insert(
            key,
            ConsumerOffsetRecord {
                consumer_id: consumer_id.to_string(),
                topic_pattern: topic_pattern.to_string(),
                last_commit_seq,
                updated_at: now,
            },
        );

        prev
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_lookup() {
        let mut table = ConsumerOffsetsTable::new();
        table.upsert(ConsumerOffsetRecord {
            consumer_id: "device-1".to_string(),
            topic_pattern: "user:1:inbox".to_string(),
            last_commit_seq: 100,
            updated_at: 1000,
        });

        let found = table.lookup("device-1", "user:1:inbox");
        assert!(found.is_some());
        assert_eq!(found.unwrap().last_commit_seq, 100);
    }

    #[test]
    fn update_existing_offset() {
        let mut table = ConsumerOffsetsTable::new();
        table.upsert(ConsumerOffsetRecord {
            consumer_id: "device-1".to_string(),
            topic_pattern: "user:1:inbox".to_string(),
            last_commit_seq: 100,
            updated_at: 1000,
        });

        table.upsert(ConsumerOffsetRecord {
            consumer_id: "device-1".to_string(),
            topic_pattern: "user:1:inbox".to_string(),
            last_commit_seq: 200,
            updated_at: 2000,
        });

        assert_eq!(
            table
                .lookup("device-1", "user:1:inbox")
                .unwrap()
                .last_commit_seq,
            200
        );
    }

    #[test]
    fn multiple_topics_per_consumer() {
        let mut table = ConsumerOffsetsTable::new();
        table.upsert(ConsumerOffsetRecord {
            consumer_id: "device-1".to_string(),
            topic_pattern: "user:1:inbox".to_string(),
            last_commit_seq: 100,
            updated_at: 1000,
        });
        table.upsert(ConsumerOffsetRecord {
            consumer_id: "device-1".to_string(),
            topic_pattern: "channel:abc".to_string(),
            last_commit_seq: 50,
            updated_at: 1000,
        });

        let offsets = table.get_offsets_for_consumer("device-1");
        assert_eq!(offsets.len(), 2);
    }

    #[test]
    fn checkpoint_commit_returns_previous_value() {
        let mut table = ConsumerOffsetsTable::new();

        // First checkpoint: no prior record, returns 0
        let prev = table.checkpoint_commit("device-1", "user:1:inbox", 100, 1000);
        assert_eq!(prev, 0);

        // Second checkpoint: prior record exists, returns 100
        let prev = table.checkpoint_commit("device-1", "user:1:inbox", 200, 2000);
        assert_eq!(prev, 100);

        // Verify the stored value was updated
        let record = table.lookup("device-1", "user:1:inbox").unwrap();
        assert_eq!(record.last_commit_seq, 200);
        assert_eq!(record.updated_at, 2000);
    }

    #[test]
    fn checkpoint_commit_isolation() {
        let mut table = ConsumerOffsetsTable::new();

        // Two consumers on different topics
        table.checkpoint_commit("consumer-a", "topic:1", 50, 1000);
        table.checkpoint_commit("consumer-b", "topic:2", 99, 1000);

        // Isolated checkpoint
        let prev = table.checkpoint_commit("consumer-a", "topic:1", 75, 2000);
        assert_eq!(prev, 50);

        // Consumer-b's offset is unchanged
        assert_eq!(
            table.lookup("consumer-b", "topic:2").unwrap().last_commit_seq,
            99
        );
    }
}
