use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tombstone {
    pub stream_id: String,
    pub commit_seq: u64,
    pub reason: String,
    pub destroyed_at_micros: i64,
}

#[derive(Debug, Clone, Default)]
pub struct TombstoneTable {
    tombstones: HashMap<(String, u64), Tombstone>,
}

impl TombstoneTable {
    pub fn new() -> Self {
        Self {
            tombstones: HashMap::new(),
        }
    }

    pub fn insert(&mut self, stream_id: String, commit_seq: u64, reason: String) {
        let destroyed_at_micros = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0);
        let tombstone = Tombstone {
            stream_id: stream_id.clone(),
            commit_seq,
            reason,
            destroyed_at_micros,
        };
        self.tombstones.insert((stream_id, commit_seq), tombstone);
    }

    pub fn is_tombstoned(&self, stream_id: &str, commit_seq: u64) -> bool {
        self.tombstones.contains_key(&(stream_id.to_string(), commit_seq))
    }

    pub fn list_by_stream(&self, stream_id: &str) -> Vec<&Tombstone> {
        self.tombstones
            .iter()
            .filter(|((sid, _), _)| sid == stream_id)
            .map(|(_, t)| t)
            .collect()
    }

    pub fn len(&self) -> usize {
        self.tombstones.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tombstones.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_adds_tombstone() {
        let mut table = TombstoneTable::new();
        table.insert("stream_a".into(), 1, "key destroyed".into());
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn is_tombstoned_returns_true_after_insert() {
        let mut table = TombstoneTable::new();
        table.insert("stream_a".into(), 42, "retention expiry".into());
        assert!(table.is_tombstoned("stream_a", 42));
    }

    #[test]
    fn is_tombstoned_returns_false_for_nonexistent() {
        let table = TombstoneTable::new();
        assert!(!table.is_tombstoned("stream_a", 99));
    }

    #[test]
    fn list_by_stream_returns_all_for_stream() {
        let mut table = TombstoneTable::new();
        table.insert("stream_a".into(), 1, "reason1".into());
        table.insert("stream_a".into(), 2, "reason2".into());
        table.insert("stream_b".into(), 1, "other".into());
        let results = table.list_by_stream("stream_a");
        assert_eq!(results.len(), 2);
        assert!(results.iter().any(|t| t.commit_seq == 1));
        assert!(results.iter().any(|t| t.commit_seq == 2));
    }

    #[test]
    fn list_by_stream_returns_empty_for_unknown() {
        let table = TombstoneTable::new();
        let results = table.list_by_stream("nonexistent");
        assert!(results.is_empty());
    }

    #[test]
    fn new_table_is_empty() {
        let table = TombstoneTable::new();
        assert!(table.is_empty());
    }
}
