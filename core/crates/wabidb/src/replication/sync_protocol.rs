use crate::error::{Result, WabiError};
use crate::commit_index::record::CommitIndexEntry;

pub struct SyncRequest {
    pub since_commit_seq: u64,
}

pub struct SyncResponse {
    pub since_commit_seq: u64,
    pub entries: Vec<CommitIndexEntry>,
    pub latest_commit_seq: u64,
}

pub fn build_sync_request(since_commit_seq: u64) -> SyncRequest {
    SyncRequest { since_commit_seq }
}

pub fn apply_sync_response(
    state: &mut Vec<CommitIndexEntry>,
    response: SyncResponse,
) -> Result<()> {
    for entry in response.entries {
        if entry.commit_seq <= response.since_commit_seq {
            return Err(WabiError::InternalInvariantViolated {
                invariant: format!(
                    "sync response contains entry with commit_seq {} <= since {}",
                    entry.commit_seq, response.since_commit_seq
                ),
            });
        }

        if let Some(existing) = state.iter_mut().find(|e: &&mut CommitIndexEntry| e.commit_seq == entry.commit_seq) {
            if existing != &entry {
                return Err(WabiError::InternalInvariantViolated {
                    invariant: format!(
                        "commit_seq {} mismatch between local and remote",
                        entry.commit_seq
                    ),
                });
            }
            continue;
        }

        state.push(entry);
    }

    state.sort_by_key(|e| e.commit_seq);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::WabiError;

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
    fn build_sync_request_has_correct_seq() {
        let req = build_sync_request(100);
        assert_eq!(req.since_commit_seq, 100);
    }

    #[test]
    fn apply_sync_response_adds_entries() {
        let mut state = vec![sample_entry(1), sample_entry(2)];

        let resp = SyncResponse {
            since_commit_seq: 2,
            entries: vec![sample_entry(3), sample_entry(4)],
            latest_commit_seq: 4,
        };

        apply_sync_response(&mut state, resp).unwrap();
        assert_eq!(state.len(), 4);
        assert_eq!(state[0].commit_seq, 1);
        assert_eq!(state[3].commit_seq, 4);
    }

    #[test]
    fn apply_idempotent_does_not_duplicate() {
        let mut state = vec![sample_entry(1), sample_entry(2)];

        let resp = SyncResponse {
            since_commit_seq: 1,
            entries: vec![sample_entry(2)],
            latest_commit_seq: 2,
        };

        apply_sync_response(&mut state, resp).unwrap();
        assert_eq!(state.len(), 2);
    }

    #[test]
    fn apply_invalid_seq_rejected() {
        let mut state = vec![];

        let resp = SyncResponse {
            since_commit_seq: 10,
            entries: vec![sample_entry(5)],
            latest_commit_seq: 5,
        };

        let err = apply_sync_response(&mut state, resp).unwrap_err();
        assert!(matches!(err, WabiError::InternalInvariantViolated { .. }));
    }
}
