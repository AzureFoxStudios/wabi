use crate::commit_index::record::CommitIndexEntry;
use crate::error::Result;

pub struct SyncPeer {
    pub endpoint: String,
}

pub fn run_anti_entropy(
    local_entries: &[CommitIndexEntry],
    remote_entries: &[CommitIndexEntry],
) -> Result<Vec<CommitIndexEntry>> {
    let mut missing = Vec::new();

    let local_set: std::collections::BTreeSet<u64> =
        local_entries.iter().map(|e| e.commit_seq).collect();

    for entry in remote_entries {
        if !local_set.contains(&entry.commit_seq) {
            missing.push(entry.clone());
        }
    }

    Ok(missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(commit_seq: u64) -> CommitIndexEntry {
        CommitIndexEntry {
            commit_seq,
            timestamp_micros: 1_718_901_234_567_890,
            caller_user_id: 1,
            caller_device_id_hash: [0u8; 16],
            command_name_hash: [0u8; 16],
            has_idempotency_key: false,
            idempotency_key_hash: None,
            event_refs: vec![],
            payload_hashes: vec![],
        }
    }

    #[test]
    fn empty_returns_empty() {
        let missing = run_anti_entropy(&[], &[]).unwrap();
        assert!(missing.is_empty());
    }

    #[test]
    fn all_synced_returns_empty() {
        let local = vec![sample_entry(1), sample_entry(2), sample_entry(3)];
        let remote = vec![sample_entry(1), sample_entry(2), sample_entry(3)];

        let missing = run_anti_entropy(&local, &remote).unwrap();
        assert!(missing.is_empty());
    }

    #[test]
    fn missing_entries_detected() {
        let local = vec![sample_entry(1), sample_entry(3)];
        let remote = vec![sample_entry(1), sample_entry(2), sample_entry(3), sample_entry(4)];

        let missing = run_anti_entropy(&local, &remote).unwrap();
        assert_eq!(missing.len(), 2);
        assert_eq!(missing[0].commit_seq, 2);
        assert_eq!(missing[1].commit_seq, 4);
    }
}
