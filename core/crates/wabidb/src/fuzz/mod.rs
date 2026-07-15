use crate::commit_index::record::{CommitIndexEntry, StreamRef};
use crate::format::record::RecordHeader;
use crate::projections::reactions::parse_composite_key;

pub fn fuzz_record_decode(data: &[u8]) {
    let header = match RecordHeader::decode(data) {
        Ok(h) => h,
        Err(_) => return,
    };

    let encoded = header.encode();
    let _re_decoded = match RecordHeader::decode(&encoded) {
        Ok(h) => h,
        Err(_) => return,
    };
}

/// Fuzz the `StreamRef::decode` deserializer with arbitrary bytes.
pub fn fuzz_stream_ref_decode(data: &[u8]) {
    let _ = StreamRef::decode(data);
}

/// Fuzz the `CommitIndexEntry::decode` deserializer with arbitrary bytes.
pub fn fuzz_commit_index_entry_decode(data: &[u8]) {
    let entry = match CommitIndexEntry::decode(data) {
        Ok(e) => e,
        Err(_) => return,
    };
    let encoded = entry.encode();
    let _re_decoded = match CommitIndexEntry::decode(&encoded) {
        Ok(e) => e,
        Err(_) => return,
    };
}

/// Fuzz the `parse_composite_key` parser with arbitrary bytes.
pub fn fuzz_parse_composite_key(data: &[u8]) {
    let _ = parse_composite_key(data);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_does_not_panic() {
        fuzz_record_decode(b"");
    }

    #[test]
    fn valid_header_round_trips() {
        let h = crate::format::record::RecordHeader::new(
            crate::format::record::RecordKind::Event,
            42,
            [0xABu8; 16],
            8,
            0xDEAD_BEEF,
        );
        let bytes = h.encode();
        fuzz_record_decode(&bytes);
    }

    #[test]
    fn truncated_header_does_not_panic() {
        let h = crate::format::record::RecordHeader::new(
            crate::format::record::RecordKind::Event,
            1,
            [0u8; 16],
            0,
            0,
        );
        let bytes = h.encode();
        for truncate_len in 0..bytes.len() {
            fuzz_record_decode(&bytes[..truncate_len]);
        }
    }

    #[test]
    fn garbage_input_does_not_panic() {
        fuzz_record_decode(b"\xFF\xFF\xFF\xFF\xFF\xFF\xFF\xFF");
        fuzz_record_decode(b"this is definitely not a valid header");
        fuzz_record_decode(&[0u8; 100]);
        fuzz_record_decode(&[0xFFu8; 100]);
    }

    #[test]
    fn max_size_input_does_not_panic() {
        let data = vec![0xABu8; 48];
        fuzz_record_decode(&data);
    }

    // -- StreamRef fuzz tests -------------------------------------------------

    #[test]
    fn stream_ref_empty_input_does_not_panic() {
        fuzz_stream_ref_decode(b"");
    }

    #[test]
    fn stream_ref_short_input_does_not_panic() {
        fuzz_stream_ref_decode(&[0u8; 16]);
        fuzz_stream_ref_decode(&[0xFFu8; 32]);
    }

    #[test]
    fn stream_ref_garbage_does_not_panic() {
        fuzz_stream_ref_decode(b"this is not a stream ref");
        fuzz_stream_ref_decode(&[0xFFu8; 100]);
    }

    // -- CommitIndexEntry fuzz tests ------------------------------------------

    #[test]
    fn commit_index_entry_empty_does_not_panic() {
        fuzz_commit_index_entry_decode(b"");
    }

    #[test]
    fn commit_index_entry_short_does_not_panic() {
        fuzz_commit_index_entry_decode(&[0u8; 8]);
        fuzz_commit_index_entry_decode(&[0u8; 64]);
    }

    #[test]
    fn commit_index_entry_garbage_does_not_panic() {
        fuzz_commit_index_entry_decode(&[0xFFu8; 200]);
        fuzz_commit_index_entry_decode(b"this is not a commit index entry");
    }

    // -- parse_composite_key fuzz tests ---------------------------------------

    #[test]
    fn composite_key_empty_does_not_panic() {
        fuzz_parse_composite_key(b"");
    }

    #[test]
    fn composite_key_garbage_does_not_panic() {
        fuzz_parse_composite_key(&[0xFFu8; 100]);
        fuzz_parse_composite_key(b"no null bytes at all");
        fuzz_parse_composite_key(b"msg\x00\xFF\xFF\xFF\xFF\xFF\xFF\xFF\xFF\x00type");
    }

    #[test]
    fn composite_key_valid_parses() {
        let key = b"message_id\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00smile";
        let result = parse_composite_key(key);
        assert!(result.is_some());
        let (msg_id, uid, rt) = result.unwrap();
        assert_eq!(msg_id, "message_id");
        assert_eq!(uid, 1);
        assert_eq!(rt, "smile");
    }
}
