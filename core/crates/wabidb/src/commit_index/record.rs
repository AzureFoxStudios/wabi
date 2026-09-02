//! Global commit index record format: single-entry serialization.
//!
//! See `docs/architecture/STORAGE_FORMAT.md` §3 for the full byte layout.
//!
//! Each commit index entry is a length-prefixed flat buffer:
//!
//! ```text
//! offset  size  field
//! 0       4     entry_len (u32)                  — length of the entry body (bytes [4..entry_crc32c))
//! 4       8     commit_seq (u64)
//! 12      8     timestamp_micros (i64)
//! 20      8     caller_user_id (u64)
//! 28      16    caller_device_id_hash ([u8; 16])
//! 44      16    command_name_hash ([u8; 16])
//! 60      1     has_idempotency_key (u8)         — 0 or 1
//! 61      32    idempotency_key_hash ([u8; 32])  — present iff has_idempotency_key == 1
//! 93/61   4     event_ref_count (u32)            — number of StreamRef entries
//! 97/65   N*33  event_refs (StreamRef[])
//! ...     4     payload_hash_count (u32)         — number of payload hash entries
//! ...     M*32  payload_hashes ([u8; 32][])
//! ...     4     entry_crc32c (u32)               — CRC32C of bytes [4..entry_crc32c)
//! ```
//!
//! The `header_crc32c` field is not present for index entries — integrity is
//! provided by the per-entry CRC at the end of each entry. The file-level
//! header (magic + version + CRC) is defined in `STORAGE_FORMAT.md` §3.1 and
//! is handled by the file reader (`wabidb-14`).

use crate::error::{Result, WabiError};

/// Magic bytes for a commit index file header.
pub const COMMIT_INDEX_MAGIC: [u8; 4] = *b"WIDX";

/// Current commit index format version.
pub const COMMIT_INDEX_FORMAT_VERSION: u16 = 1;

// ---------------------------------------------------------------------------
// StreamRef — a reference to a record in a stream segment
// ---------------------------------------------------------------------------

/// A reference to a single event record within a stream segment.
///
/// The on-disk format (STORAGE_FORMAT.md §3.3):
///
/// | Offset | Size | Field |
/// |--------|------|-------|
/// | 0      | 16   | `stream_id_hash` |
/// | 16     | 1    | `stream_kind` |
/// | 17     | 8    | `segment_id` |
/// | 25     | 4    | `offset` |
/// | 29     | 4    | `length` |
///
/// **Total: 33 bytes** (the "29 bytes" note in earlier versions of the
/// design was a calculation error — each field sums to 16 + 1 + 8 + 4 + 4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamRef {
    /// First 16 bytes of `BLAKE3(stream_id)`.
    pub stream_id_hash: [u8; 16],
    /// Numeric kind: 1=channel, 2=dm, 3=whiteboard, 4=place, 5=kanban, 6=other.
    pub stream_kind: u8,
    /// Which `.wseg` file the record lives in.
    pub segment_id: u64,
    /// Byte offset within the segment (the start of the record header).
    pub offset: u32,
    /// Total record size on disk (header + payload + padding).
    pub length: u32,
}

impl StreamRef {
    /// The exact byte size of a serialized `StreamRef`.
    pub const ENCODED_SIZE: usize = 33;

    /// Serialize this reference to its 33-byte canonical form.
    pub fn encode(&self) -> [u8; Self::ENCODED_SIZE] {
        let mut buf = [0u8; Self::ENCODED_SIZE];
        buf[0..16].copy_from_slice(&self.stream_id_hash);
        buf[16] = self.stream_kind;
        buf[17..25].copy_from_slice(&self.segment_id.to_le_bytes());
        buf[25..29].copy_from_slice(&self.offset.to_le_bytes());
        buf[29..33].copy_from_slice(&self.length.to_le_bytes());
        buf
    }

    /// Deserialize from a byte slice, returning an error if the slice is too short.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < Self::ENCODED_SIZE {
            return Err(WabiError::Corrupt {
                location: "commit index StreamRef".into(),
                detail: format!("buffer too short: {} bytes", bytes.len()),
            });
        }
        let mut stream_id_hash = [0u8; 16];
        stream_id_hash.copy_from_slice(&bytes[0..16]);
        let stream_kind = bytes[16];
        let segment_id = u64::from_le_bytes(bytes[17..25].try_into().unwrap());
        let offset = u32::from_le_bytes(bytes[25..29].try_into().unwrap());
        let length = u32::from_le_bytes(bytes[29..33].try_into().unwrap());
        Ok(Self {
            stream_id_hash,
            stream_kind,
            segment_id,
            offset,
            length,
        })
    }
}

// ---------------------------------------------------------------------------
// CommitIndexEntry — a single entry in the global commit index
// ---------------------------------------------------------------------------

/// A single commit index entry, representing one committed mutation.
///
/// Each entry is serialized as a length-prefixed flat buffer with CRC32C
/// integrity. The on-disk format is described in `STORAGE_FORMAT.md` §3.2.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitIndexEntry {
    /// Monotonic, never reused (burned commit_seq is also never reused).
    pub commit_seq: u64,
    /// Server time when the commit was assigned (micros since Unix epoch).
    pub timestamp_micros: i64,
    /// `0` = system caller.
    pub caller_user_id: u64,
    /// First 16 bytes of `BLAKE3(device_id)`.
    pub caller_device_id_hash: [u8; 16],
    /// First 16 bytes of `BLAKE3(command_name)`.
    pub command_name_hash: [u8; 16],
    /// Whether an idempotency key was provided.
    pub has_idempotency_key: bool,
    /// `BLAKE3(caller_user_id || caller_device_id || client_request_id)`,
    /// present only when `has_idempotency_key` is true.
    pub idempotency_key_hash: Option<[u8; 32]>,
    /// References to the stream records produced by this commit.
    pub event_refs: Vec<StreamRef>,
    /// BLAKE3 hashes of the encrypted payloads for fast dedup / integrity checks.
    pub payload_hashes: Vec<[u8; 32]>,
}

impl CommitIndexEntry {
    /// Encode this entry into its canonical wire format (length-prefixed + CRC).
    ///
    /// Returns a `Vec<u8>` whose layout is:
    ///
    /// ```text
    /// [0..4)      entry_len (u32, little-endian)
    /// [4..4+body) entry body (all fields serialized in order)
    /// [4+body..)  entry_crc32c (u32, little-endian)
    /// ```
    pub fn encode(&self) -> Vec<u8> {
        let body = self.encode_body();
        let crc = crc32c::crc32c(&body);

        let mut result = Vec::with_capacity(4 + body.len() + 4);
        result.extend_from_slice(&(body.len() as u32).to_le_bytes());
        result.extend_from_slice(&body);
        result.extend_from_slice(&crc.to_le_bytes());
        result
    }

    /// Decode a `CommitIndexEntry` from its canonical wire format.
    ///
    /// Returns an error if the buffer is too short, the CRC is bad, or there
    /// is trailing data after the declared body length.
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < 8 {
            return Err(WabiError::Corrupt {
                location: "commit index entry".into(),
                detail: format!("buffer too short: {} bytes", bytes.len()),
            });
        }

        let entry_len = u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
        let total_len = 4 + entry_len + 4;

        if bytes.len() < total_len {
            return Err(WabiError::Corrupt {
                location: "commit index entry".into(),
                detail: format!(
                    "buffer too short: need {total_len} bytes, have {}",
                    bytes.len()
                ),
            });
        }

        let body = &bytes[4..4 + entry_len];

        // Minimum body: 8+8+8+16+16+1+4+4 = 65 bytes (no idempotency key,
        // no event_refs, no payload_hashes).
        if entry_len < 65 {
            return Err(WabiError::Corrupt {
                location: "commit index entry".into(),
                detail: format!("body too short: {entry_len} bytes, minimum is 65"),
            });
        }

        let stored_crc =
            u32::from_le_bytes(bytes[4 + entry_len..4 + entry_len + 4].try_into().unwrap());
        let computed_crc = crc32c::crc32c(body);

        if stored_crc != computed_crc {
            return Err(WabiError::Corrupt {
                location: "commit index entry".into(),
                detail: format!(
                    "CRC mismatch: stored={stored_crc:#010x}, computed={computed_crc:#010x}"
                ),
            });
        }

        let mut off = 0usize;

        // --- commit_seq ---
        let commit_seq = u64::from_le_bytes(body[off..off + 8].try_into().unwrap());
        off += 8;

        // --- timestamp_micros ---
        let timestamp_micros = i64::from_le_bytes(body[off..off + 8].try_into().unwrap());
        off += 8;

        // --- caller_user_id ---
        let caller_user_id = u64::from_le_bytes(body[off..off + 8].try_into().unwrap());
        off += 8;

        // --- caller_device_id_hash ---
        let mut caller_device_id_hash = [0u8; 16];
        caller_device_id_hash.copy_from_slice(&body[off..off + 16]);
        off += 16;

        // --- command_name_hash ---
        let mut command_name_hash = [0u8; 16];
        command_name_hash.copy_from_slice(&body[off..off + 16]);
        off += 16;

        // --- has_idempotency_key ---
        let has_idempotency_key = body[off] != 0;
        off += 1;

        // --- idempotency_key_hash (optional) ---
        let idempotency_key_hash = if has_idempotency_key {
            let mut hash = [0u8; 32];
            hash.copy_from_slice(&body[off..off + 32]);
            off += 32;
            Some(hash)
        } else {
            None
        };

        // --- event_ref_count ---
        let event_ref_count =
            u32::from_le_bytes(body[off..off + 4].try_into().unwrap()) as usize;
        off += 4;

        // --- event_refs ---
        let mut event_refs = Vec::with_capacity(event_ref_count);
        for _ in 0..event_ref_count {
            let sr = StreamRef::decode(&body[off..off + StreamRef::ENCODED_SIZE])?;
            off += StreamRef::ENCODED_SIZE;
            event_refs.push(sr);
        }

        // --- payload_hash_count ---
        let payload_hash_count =
            u32::from_le_bytes(body[off..off + 4].try_into().unwrap()) as usize;
        off += 4;

        // --- payload_hashes ---
        let mut payload_hashes = Vec::with_capacity(payload_hash_count);
        for _ in 0..payload_hash_count {
            let mut hash = [0u8; 32];
            hash.copy_from_slice(&body[off..off + 32]);
            off += 32;
            payload_hashes.push(hash);
        }

        // All body bytes must be consumed.
        if off != body.len() {
            return Err(WabiError::Corrupt {
                location: "commit index entry".into(),
                detail: format!(
                    "trailing data after all fields: consumed {off} of {} body bytes",
                    body.len()
                ),
            });
        }

        Ok(Self {
            commit_seq,
            timestamp_micros,
            caller_user_id,
            caller_device_id_hash,
            command_name_hash,
            has_idempotency_key,
            idempotency_key_hash,
            event_refs,
            payload_hashes,
        })
    }

    /// Serialize just the body (everything after `entry_len` and before
    /// `entry_crc32c`) into a `Vec<u8>`.
    fn encode_body(&self) -> Vec<u8> {
        let has_idem = self.has_idempotency_key;
        let idem_bytes: usize = if has_idem { 32 } else { 0 };
        let ref_count = self.event_refs.len();
        let hash_count = self.payload_hashes.len();
        let body_len = 8 + 8 + 8 + 16 + 16 + 1 + idem_bytes
            + 4
            + ref_count * StreamRef::ENCODED_SIZE
            + 4
            + hash_count * 32;
        let mut buf = Vec::with_capacity(body_len);

        buf.extend_from_slice(&self.commit_seq.to_le_bytes());
        buf.extend_from_slice(&self.timestamp_micros.to_le_bytes());
        buf.extend_from_slice(&self.caller_user_id.to_le_bytes());
        buf.extend_from_slice(&self.caller_device_id_hash);
        buf.extend_from_slice(&self.command_name_hash);
        buf.push(self.has_idempotency_key as u8);
        if let Some(ref h) = self.idempotency_key_hash {
            buf.extend_from_slice(h);
        }

        let ref_count_u32 = ref_count as u32;
        buf.extend_from_slice(&ref_count_u32.to_le_bytes());
        for sr in &self.event_refs {
            buf.extend_from_slice(&sr.encode());
        }

        let hash_count_u32 = hash_count as u32;
        buf.extend_from_slice(&hash_count_u32.to_le_bytes());
        for h in &self.payload_hashes {
            buf.extend_from_slice(h);
        }

        debug_assert_eq!(buf.len(), body_len, "encode_body size mismatch");
        buf
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_stream_ref(seed: u8) -> StreamRef {
        let mut hash = [0u8; 16];
        hash[0] = seed;
        hash[15] = seed;
        StreamRef {
            stream_id_hash: hash,
            stream_kind: 1,
            segment_id: seed as u64,
            offset: seed as u32 * 100,
            length: seed as u32 * 50,
        }
    }

    fn sample_entry(include_idempotency: bool) -> CommitIndexEntry {
        let mut device_hash = [0u8; 16];
        device_hash[0] = 0xAB;
        let mut cmd_hash = [0u8; 16];
        cmd_hash[0] = 0xCD;
        let idempotency_hash = if include_idempotency {
            let mut h = [0u8; 32];
            h[0] = 0xEF;
            Some(h)
        } else {
            None
        };
        CommitIndexEntry {
            commit_seq: 42,
            timestamp_micros: 1_718_901_234_567_890,
            caller_user_id: 12345,
            caller_device_id_hash: device_hash,
            command_name_hash: cmd_hash,
            has_idempotency_key: include_idempotency,
            idempotency_key_hash: idempotency_hash,
            event_refs: vec![sample_stream_ref(1), sample_stream_ref(2)],
            payload_hashes: vec![[1u8; 32], [2u8; 32]],
        }
    }

    #[test]
    fn round_trip_all_fields() {
        let entry = sample_entry(true);
        let bytes = entry.encode();
        let decoded = CommitIndexEntry::decode(&bytes).unwrap();
        assert_eq!(entry, decoded);
    }

    #[test]
    fn round_trip_no_idempotency() {
        let entry = sample_entry(false);
        let bytes = entry.encode();
        let decoded = CommitIndexEntry::decode(&bytes).unwrap();
        assert_eq!(entry, decoded);
        assert!(decoded.idempotency_key_hash.is_none());
    }

    #[test]
    fn round_trip_multiple_refs_and_hashes() {
        let mut entry = sample_entry(true);
        entry.event_refs = (0..10).map(|i| sample_stream_ref(i as u8)).collect();
        entry.payload_hashes = (0..5).map(|i| [i; 32]).collect();
        let bytes = entry.encode();
        let decoded = CommitIndexEntry::decode(&bytes).unwrap();
        assert_eq!(entry, decoded);
    }

    #[test]
    fn bad_crc_rejected() {
        let entry = sample_entry(true);
        let mut bytes = entry.encode();
        // Flip a bit in the trailing CRC.
        let last = bytes.len() - 1;
        bytes[last] ^= 0xFF;
        let err = CommitIndexEntry::decode(&bytes).unwrap_err();
        assert!(
            matches!(err, WabiError::Corrupt { .. }),
            "expected Corrupt, got {err:?}"
        );
    }

    #[test]
    fn truncated_data_rejected() {
        let entry = sample_entry(true);
        let bytes = entry.encode();
        // Truncate to just the entry_len field.
        let err = CommitIndexEntry::decode(&bytes[..4]).unwrap_err();
        assert!(
            matches!(err, WabiError::Corrupt { .. }),
            "expected Corrupt, got {err:?}"
        );
    }

    #[test]
    fn byte_identical_round_trip() {
        let entry = sample_entry(true);
        let bytes = entry.encode();
        let decoded = CommitIndexEntry::decode(&bytes).unwrap();
        let re_encoded = decoded.encode();
        assert_eq!(bytes, re_encoded);
    }

    #[test]
    fn empty_event_refs_and_hashes() {
        let entry = CommitIndexEntry {
            event_refs: vec![],
            payload_hashes: vec![],
            ..sample_entry(true)
        };
        let bytes = entry.encode();
        let decoded = CommitIndexEntry::decode(&bytes).unwrap();
        assert_eq!(entry, decoded);
        assert!(decoded.event_refs.is_empty());
        assert!(decoded.payload_hashes.is_empty());
    }

    #[test]
    fn stream_ref_round_trip() {
        let sr = sample_stream_ref(7);
        let bytes = sr.encode();
        assert_eq!(bytes.len(), StreamRef::ENCODED_SIZE);
        let decoded = StreamRef::decode(&bytes).unwrap();
        assert_eq!(sr, decoded);
    }

    #[test]
    fn stream_ref_truncated_rejected() {
        let err = StreamRef::decode(&[0u8; 16]).unwrap_err();
        assert!(
            matches!(err, WabiError::Corrupt { .. }),
            "expected Corrupt, got {err:?}"
        );
    }

    #[test]
    fn trailing_body_bytes_rejected() {
        let entry = sample_entry(true);
        let bytes = entry.encode();
        let body_len =
            u32::from_le_bytes(bytes[0..4].try_into().unwrap()) as usize;
        // Build a new buffer where the body is 4 bytes longer than the actual
        // serialized fields so the decode finds unconsumed trailing data.
        let mut padded_body = Vec::from(&bytes[4..4 + body_len]);
        padded_body.extend_from_slice(b"XXXX");
        let new_crc = crc32c::crc32c(&padded_body);
        let mut new_bytes = Vec::with_capacity(4 + padded_body.len() + 4);
        new_bytes.extend_from_slice(&(padded_body.len() as u32).to_le_bytes());
        new_bytes.extend_from_slice(&padded_body);
        new_bytes.extend_from_slice(&new_crc.to_le_bytes());

        let err = CommitIndexEntry::decode(&new_bytes).unwrap_err();
        assert!(
            matches!(err, WabiError::Corrupt { .. }),
            "expected Corrupt, got {err:?}"
        );
    }

    #[test]
    fn zero_entry_len_rejected() {
        // entry_len=0 means no body, but we require at least the CRC.
        let bytes = [0u8; 8];
        let err = CommitIndexEntry::decode(&bytes).unwrap_err();
        assert!(
            matches!(err, WabiError::Corrupt { .. }),
            "expected Corrupt, got {err:?}"
        );
    }
}
