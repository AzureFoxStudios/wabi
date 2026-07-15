use proptest::prelude::*;

use crate::commit_index::record::CommitIndexEntry;
use crate::format::record::{payload_crc32c, RecordHeader, RecordKind};

proptest! {
    #[test]
    fn record_encode_decode_round_trip(
        commit_seq in 0u64..1_000_000,
        payload_len in 0u32..1024,
        stream_hash_0 in any::<u8>(),
        stream_hash_15 in any::<u8>(),
        payload_seed in any::<u32>(),
    ) {
        let mut stream_id_hash = [0u8; 16];
        stream_id_hash[0] = stream_hash_0;
        stream_id_hash[15] = stream_hash_15;
        let payload: Vec<u8> = (0..payload_len).map(|i| (payload_seed.wrapping_add(i)) as u8).collect();
        let crc = payload_crc32c(&payload);
        let header = RecordHeader::new(RecordKind::Event, commit_seq, stream_id_hash, payload_len, crc);
        let encoded = header.encode();
        let decoded = RecordHeader::decode(&encoded).unwrap();
        assert_eq!(header, decoded);
    }
}

proptest! {
    #[test]
    fn commit_index_encode_decode_round_trip(
        commit_seq in 0u64..100_000,
        caller_user_id in 0u64..10_000,
        has_idem in prop::bool::weighted(0.5),
    ) {
        let mut device_hash = [0u8; 16];
        device_hash[0] = (commit_seq & 0xFF) as u8;
        let mut cmd_hash = [0u8; 16];
        cmd_hash[0] = ((commit_seq >> 8) & 0xFF) as u8;
        let idem_hash = if has_idem {
            let mut h = [0u8; 32];
            h[0] = (commit_seq & 0xFF) as u8;
            Some(h)
        } else {
            None
        };
        let entry = CommitIndexEntry {
            commit_seq,
            timestamp_micros: 1_718_901_234_567_890i64,
            caller_user_id,
            caller_device_id_hash: device_hash,
            command_name_hash: cmd_hash,
            has_idempotency_key: has_idem,
            idempotency_key_hash: idem_hash,
            event_refs: vec![],
            payload_hashes: vec![],
        };
        let encoded = entry.encode();
        let decoded = CommitIndexEntry::decode(&encoded).unwrap();
        assert_eq!(entry, decoded);
    }
}

// -- Projection record postcard round-trips --------------------------------

fn projection_round_trip<T: serde::Serialize + serde::de::DeserializeOwned + std::fmt::Debug + PartialEq>(record: &T) {
    let encoded = postcard::to_allocvec(record).expect("encode");
    let decoded: T = postcard::from_bytes(&encoded).expect("decode");
    assert_eq!(*record, decoded);
}

fn short_string() -> impl Strategy<Value = String> {
    "[a-zA-Z0-9_/.-]{0,64}"
}

proptest! {
    #[test]
    fn message_record_postcard_round_trip(
        message_id in short_string(),
        channel_id in short_string(),
        author_user_id in any::<u64>(),
        body_ref in short_string(),
        has_edit in any::<bool>(),
    ) {
        use crate::projections::messages::MessageRecord;
        let now = 1_718_901_234_567_890i64;
        let edits = if has_edit { vec![(now, "edit_body".into())] } else { vec![] };
        let record = MessageRecord {
            message_id,
            channel_id,
            author_user_id,
            author_device_id: "dev".into(),
            created_at_micros: now,
            encrypted_body_ref: body_ref,
            idempotency_key: None,
            edit_history: edits,
            edited_at_micros: None,
            is_deleted: false,
        };
        projection_round_trip(&record);
    }
}

proptest! {
    #[test]
    fn wiki_page_record_postcard_round_trip(
        page_id in short_string(),
        channel_id in short_string(),
        title in "[ -~]{0,128}",
        body in "[ -~]{0,1024}",
        author_user_id in any::<u64>(),
    ) {
        use crate::projections::wiki::WikiPageRecord;
        let now = 1_718_901_234_567_890i64;
        let record = WikiPageRecord {
            page_id,
            channel_id,
            title,
            body,
            author_user_id,
            created_at_micros: now,
            updated_at_micros: now,
            is_deleted: false,
        };
        projection_round_trip(&record);
    }
}

proptest! {
    #[test]
    fn forum_post_record_postcard_round_trip(
        post_id in short_string(),
        thread_id in short_string(),
        channel_id in short_string(),
        author_user_id in any::<u64>(),
        body in "[ -~]{0,1024}",
        is_thread_starter in any::<bool>(),
        has_edit in any::<bool>(),
    ) {
        use crate::projections::forum::ForumPostRecord;
        let now = 1_718_901_234_567_890i64;
        let edited = if has_edit { Some(now + 1000) } else { None };
        let record = ForumPostRecord {
            post_id,
            thread_id,
            channel_id,
            author_user_id,
            body,
            created_at_micros: now,
            edited_at_micros: edited,
            is_deleted: false,
            is_thread_starter,
        };
        projection_round_trip(&record);
    }
}

proptest! {
    #[test]
    fn incident_record_postcard_round_trip(
        incident_id in short_string(),
        channel_id in short_string(),
        title in "[ -~]{0,128}",
        description in "[ -~]{0,1024}",
        severity in "critical|high|medium|low",
        status in "open|investigating|resolved|closed",
        reporter_user_id in any::<u64>(),
        has_assignee in any::<bool>(),
        is_resolved in any::<bool>(),
    ) {
        use crate::projections::incidents::IncidentRecord;
        let now = 1_718_901_234_567_890i64;
        let assigned = if has_assignee { Some(42u64) } else { None };
        let resolved_at = if is_resolved { Some(now + 5000) } else { None };
        let record = IncidentRecord {
            incident_id,
            channel_id,
            title,
            description,
            severity,
            status,
            reporter_user_id,
            assigned_user_id: assigned,
            created_at_micros: now,
            updated_at_micros: now,
            resolved_at_micros: resolved_at,
            is_deleted: false,
        };
        projection_round_trip(&record);
    }
}

// -- Key encoding round-trips --

proptest! {
    #[test]
    fn wiki_key_encode_decode_injective(
        channel_id in short_string(),
        page_id in short_string(),
    ) {
        use crate::projections::wiki::encode_key;
        let encoded = encode_key(&channel_id, &page_id);
        assert!(!encoded.is_empty());
        let encoded2 = encode_key(&channel_id, &page_id);
        assert_eq!(encoded, encoded2);
        if channel_id != page_id || !channel_id.is_empty() {
            let alt = encode_key(&page_id, &channel_id);
            if alt == encoded {
                assert_eq!(channel_id, page_id);
            }
        }
    }
}

proptest! {
    #[test]
    fn forum_key_encode_decode_injective(
        channel_id in short_string(),
        thread_id in short_string(),
        post_id in short_string(),
    ) {
        use crate::projections::forum::encode_key;
        let encoded = encode_key(&channel_id, &thread_id, &post_id);
        assert!(!encoded.is_empty());
        let encoded2 = encode_key(&channel_id, &thread_id, &post_id);
        assert_eq!(encoded, encoded2);
    }
}

proptest! {
    #[test]
    fn incident_key_encode_decode_injective(
        channel_id in short_string(),
        incident_id in short_string(),
    ) {
        use crate::projections::incidents::encode_key;
        let encoded = encode_key(&channel_id, &incident_id);
        assert!(!encoded.is_empty());
        let encoded2 = encode_key(&channel_id, &incident_id);
        assert_eq!(encoded, encoded2);
    }
}

// -- Domain type JSON round-trips --

proptest! {
    #[test]
    fn wiki_page_json_round_trip(
        page_id in short_string(),
        channel_id in short_string(),
        title in "[ -~]{0,128}",
        body in "[ -~]{0,256}",
        author_user_id in any::<u64>(),
    ) {
        let page = crate::domain::WikiPage {
            page_id,
            channel_id,
            title,
            body,
            author_user_id,
            created_at_micros: 1_718_901_234_567_890i64,
            updated_at_micros: 1_718_901_234_567_891i64,
            is_deleted: false,
        };
        let json = serde_json::to_string(&page).unwrap();
        let back: crate::domain::WikiPage = serde_json::from_str(&json).unwrap();
        assert_eq!(page, back);
    }
}

proptest! {
    #[test]
    fn forum_post_json_round_trip(
        post_id in short_string(),
        thread_id in short_string(),
        channel_id in short_string(),
        author_user_id in any::<u64>(),
        body in "[ -~]{0,256}",
        is_thread_starter in any::<bool>(),
    ) {
        let post = crate::domain::ForumPost {
            post_id,
            thread_id,
            channel_id,
            author_user_id,
            body,
            created_at_micros: 1_718_901_234_567_890i64,
            edited_at_micros: None,
            is_deleted: false,
            is_thread_starter,
        };
        let json = serde_json::to_string(&post).unwrap();
        let back: crate::domain::ForumPost = serde_json::from_str(&json).unwrap();
        assert_eq!(post, back);
    }
}

proptest! {
    #[test]
    fn incident_json_round_trip(
        incident_id in short_string(),
        channel_id in short_string(),
        title in "[ -~]{0,128}",
        description in "[ -~]{0,256}",
        severity in "critical|high|medium|low",
        status in "open|investigating|resolved|closed",
        reporter_user_id in any::<u64>(),
        has_assignee in any::<bool>(),
        is_resolved in any::<bool>(),
    ) {
        let assigned = if has_assignee { Some(99u64) } else { None };
        let resolved_at = if is_resolved { Some(1_718_901_234_567_900i64) } else { None };
        let incident = crate::domain::Incident {
            incident_id,
            channel_id,
            title,
            description,
            severity,
            status,
            reporter_user_id,
            assigned_user_id: assigned,
            created_at_micros: 1_718_901_234_567_890i64,
            updated_at_micros: 1_718_901_234_567_891i64,
            resolved_at_micros: resolved_at,
            is_deleted: false,
        };
        let json = serde_json::to_string(&incident).unwrap();
        let back: crate::domain::Incident = serde_json::from_str(&json).unwrap();
        assert_eq!(incident, back);
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn record_round_trip_minimal() {
        let header = RecordHeader::new(RecordKind::Event, 0, [0u8; 16], 0, 0);
        let bytes = header.encode();
        let decoded = RecordHeader::decode(&bytes).unwrap();
        assert_eq!(header, decoded);
    }

    #[test]
    fn commit_index_round_trip_no_idem() {
        let entry = CommitIndexEntry {
            commit_seq: 1,
            timestamp_micros: 1_718_901_234_567_890,
            caller_user_id: 42,
            caller_device_id_hash: [0u8; 16],
            command_name_hash: [0u8; 16],
            has_idempotency_key: false,
            idempotency_key_hash: None,
            event_refs: vec![],
            payload_hashes: vec![],
        };
        let bytes = entry.encode();
        let decoded = CommitIndexEntry::decode(&bytes).unwrap();
        assert_eq!(entry, decoded);
    }

    #[test]
    fn commit_index_round_trip_with_idem() {
        let entry = CommitIndexEntry {
            commit_seq: 42,
            timestamp_micros: 1_718_901_234_567_890,
            caller_user_id: 123,
            caller_device_id_hash: [1u8; 16],
            command_name_hash: [2u8; 16],
            has_idempotency_key: true,
            idempotency_key_hash: Some([3u8; 32]),
            event_refs: vec![],
            payload_hashes: vec![[4u8; 32]],
        };
        let bytes = entry.encode();
        let decoded = CommitIndexEntry::decode(&bytes).unwrap();
        assert_eq!(entry, decoded);
    }

    #[test]
    fn blob_write_read_round_trip() {
        let data = b"hello blob store";
        let path = std::env::temp_dir().join(format!("blob_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        let file_path = path.join("blob.bin");
        std::fs::write(&file_path, data).unwrap();
        let read_back = std::fs::read(&file_path).unwrap();
        assert_eq!(&read_back, data);
        let _ = std::fs::remove_dir_all(&path);
    }
}
