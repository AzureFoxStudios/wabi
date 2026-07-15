//! Stream segment record format: read, write, and verify.
//!
//! See `core/crates/wabidb/docs/STORAGE_FORMAT.md` §2 for the full byte layout.
//!
//! The header is 48 bytes (not 36 as the endstate doc originally stated — the
//! header was extended to include `payload_crc32c` as a separate field for
//! fast corruption detection before the expensive decryption step).
//!
//! ```text
//! offset  size  field
//! 0       4     magic            = b"WABI"
//! 4       2     format_version   = 1
//! 6       2     header_len       = 48
//! 8       2     record_kind
//! 10      2     flags            = 0
//! 12      8     commit_seq
//! 20      16    stream_id_hash
//! 36      4     payload_len
//! 40      4     header_crc32c    (CRC32C of bytes [0..40))
//! 44      4     payload_crc32c   (CRC32C of bytes [52..52+payload_len))
//! 48      ...   payload
//! ```
//!
//! Records are followed by zero-padding to the next 16-byte boundary.

use crate::error::{Result, WabiError};

/// The 4-byte magic at the start of every record header.
pub const RECORD_MAGIC: [u8; 4] = *b"WABI";

/// Current format version. Bump on incompatible changes.
pub const FORMAT_VERSION: u16 = 1;

/// Current header length in bytes. Records with a different value are rejected.
pub const HEADER_LEN: u16 = 48;

/// Maximum payload size in bytes (16 MiB). Records with a larger payload are rejected.
pub const MAX_PAYLOAD_LEN: u32 = 16 * 1024 * 1024;

/// Record alignment. Records are padded to a multiple of this many bytes.
pub const RECORD_ALIGNMENT: usize = 16;

/// What kind of record this is. Determines how the payload is interpreted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum RecordKind {
    /// A durable event (message, DM, whiteboard patch, etc.).
    Event = 1,
    /// A snapshot of the projection state at this point in the commit log.
    Snapshot = 2,
    /// A tombstone marker. The stream has been cryptographically deleted.
    Tombstone = 3,
    /// A high-water-mark checkpoint for projection rebuilds.
    Checkpoint = 4,
}

impl RecordKind {
    /// Convert from the wire `u16` value, returning `None` for unsupported kinds.
    pub fn from_u16(v: u16) -> Option<Self> {
        match v {
            1 => Some(Self::Event),
            2 => Some(Self::Snapshot),
            3 => Some(Self::Tombstone),
            4 => Some(Self::Checkpoint),
            _ => None,
        }
    }
}

/// The 48-byte header that prefixes every record.
///
/// Use [`RecordHeader::encode`] to serialize to bytes, [`RecordHeader::decode`]
/// to deserialize from bytes (verifying the magic, version, header length, and
/// header CRC in the process). The `payload_crc32c` field is verified separately
/// against the payload bytes by [`verify_payload_crc`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordHeader {
    /// The format version. Must equal [`FORMAT_VERSION`] for this build.
    pub format_version: u16,
    /// The kind of record. See [`RecordKind`].
    pub record_kind: RecordKind,
    /// Reserved flags. Must be 0.
    pub flags: u16,
    /// Monotonic per-stream commit sequence number.
    pub commit_seq: u64,
    /// First 16 bytes of BLAKE3(stream_id).
    pub stream_id_hash: [u8; 16],
    /// Length of the payload in bytes. Range `[0, MAX_PAYLOAD_LEN]`.
    pub payload_len: u32,
    /// CRC32C of the payload. Set by the writer; verified by the reader.
    pub payload_crc32c: u32,
}

impl RecordHeader {
    /// Create a new record header. The `header_crc32c` and `payload_crc32c` are
    /// not set by the constructor — they are computed by [`encode`] and stored
    /// in the wire format.
    pub fn new(
        record_kind: RecordKind,
        commit_seq: u64,
        stream_id_hash: [u8; 16],
        payload_len: u32,
        payload_crc32c: u32,
    ) -> Self {
        Self {
            format_version: FORMAT_VERSION,
            record_kind,
            flags: 0,
            commit_seq,
            stream_id_hash,
            payload_len,
            payload_crc32c,
        }
    }

    /// Total record size in bytes (header + payload + padding to 16-byte boundary).
    pub fn total_size(&self) -> usize {
        let body = HEADER_LEN as usize + self.payload_len as usize;
        let aligned = (body + RECORD_ALIGNMENT - 1) & !(RECORD_ALIGNMENT - 1);
        aligned
    }

    /// Serialize the header to a 48-byte array. The `header_crc32c` field is
    /// computed and inserted at offset 40.
    pub fn encode(&self) -> [u8; HEADER_LEN as usize] {
        let mut buf = [0u8; HEADER_LEN as usize];
        buf[0..4].copy_from_slice(&RECORD_MAGIC);
        buf[4..6].copy_from_slice(&self.format_version.to_le_bytes());
        buf[6..8].copy_from_slice(&HEADER_LEN.to_le_bytes());
        buf[8..10].copy_from_slice(&(self.record_kind as u16).to_le_bytes());
        buf[10..12].copy_from_slice(&self.flags.to_le_bytes());
        buf[12..20].copy_from_slice(&self.commit_seq.to_le_bytes());
        buf[20..36].copy_from_slice(&self.stream_id_hash);
        buf[36..40].copy_from_slice(&self.payload_len.to_le_bytes());
        let header_crc = crc32c::crc32c(&buf[0..40]);
        buf[40..44].copy_from_slice(&header_crc.to_le_bytes());
        buf[44..48].copy_from_slice(&self.payload_crc32c.to_le_bytes());
        buf
    }

    /// Decode a header from a 48-byte slice, verifying magic, version, header
    /// length, and header CRC. Does NOT verify the payload CRC — the caller
    /// must do that against the payload bytes via [`verify_payload_crc`].
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < HEADER_LEN as usize {
            return Err(WabiError::Corrupt {
                location: "record header".into(),
                detail: format!("buffer too short: {} bytes", bytes.len()),
            });
        }

        // Magic
        if bytes[0..4] != RECORD_MAGIC {
            return Err(WabiError::BadMagic {
                expected: "WABI",
                found: format_magic(&bytes[0..4]),
            });
        }

        // Format version
        let format_version = u16::from_le_bytes(bytes[4..6].try_into().unwrap());
        if format_version != FORMAT_VERSION {
            return Err(WabiError::UnsupportedFormatVersion {
                found: format_version,
                supported: vec![FORMAT_VERSION],
            });
        }

        // Header length (currently always 48; reserved for future expansion)
        let header_len = u16::from_le_bytes(bytes[6..8].try_into().unwrap());
        if header_len != HEADER_LEN {
            return Err(WabiError::Corrupt {
                location: "record header".into(),
                detail: format!("header_len={header_len}, expected {HEADER_LEN}"),
            });
        }

        // Header CRC (covers bytes [0..40))
        let stored_crc = u32::from_le_bytes(bytes[40..44].try_into().unwrap());
        let computed_crc = crc32c::crc32c(&bytes[0..40]);
        if stored_crc != computed_crc {
            return Err(WabiError::Corrupt {
                location: "record header".into(),
                detail: format!(
                    "header CRC mismatch: stored={stored_crc:#010x}, computed={computed_crc:#010x}"
                ),
            });
        }

        let record_kind_raw = u16::from_le_bytes(bytes[8..10].try_into().unwrap());
        let record_kind = RecordKind::from_u16(record_kind_raw).ok_or_else(|| {
            WabiError::Corrupt {
                location: "record header".into(),
                detail: format!("unsupported record_kind: {record_kind_raw}"),
            }
        })?;

        let flags = u16::from_le_bytes(bytes[10..12].try_into().unwrap());
        if flags != 0 {
            return Err(WabiError::Corrupt {
                location: "record header".into(),
                detail: format!("non-zero flags: {flags}"),
            });
        }

        let commit_seq = u64::from_le_bytes(bytes[12..20].try_into().unwrap());
        let mut stream_id_hash = [0u8; 16];
        stream_id_hash.copy_from_slice(&bytes[20..36]);
        let payload_len = u32::from_le_bytes(bytes[36..40].try_into().unwrap());
        if payload_len > MAX_PAYLOAD_LEN {
            return Err(WabiError::Corrupt {
                location: "record header".into(),
                detail: format!("payload_len {payload_len} exceeds max {MAX_PAYLOAD_LEN}"),
            });
        }
        let payload_crc32c = u32::from_le_bytes(bytes[44..48].try_into().unwrap());

        Ok(Self {
            format_version,
            record_kind,
            flags,
            commit_seq,
            stream_id_hash,
            payload_len,
            payload_crc32c,
        })
    }

    /// Verify the payload CRC against the actual payload bytes.
    ///
    /// A `payload_crc32c` of `0` means "no CRC check" — the record relies on a
    /// higher-level integrity mechanism (e.g., the AES-256-GCM authentication tag
    /// for encrypted records). This convention allows the `SegmentReader` to
    /// process both plaintext records (with CRC) and encrypted records (with GCM
    /// tag) without knowing which is which.
    pub fn verify_payload_crc(&self, payload: &[u8]) -> Result<()> {
        if self.payload_crc32c == 0 {
            // CRC = 0 means "use GCM tag for integrity, skip CRC check".
            return Ok(());
        }
        if payload.len() != self.payload_len as usize {
            return Err(WabiError::Corrupt {
                location: "record payload".into(),
                detail: format!(
                    "payload length mismatch: stored={}, actual={}",
                    self.payload_len,
                    payload.len()
                ),
            });
        }
        let computed = crc32c::crc32c(payload);
        if computed != self.payload_crc32c {
            return Err(WabiError::Corrupt {
                location: "record payload".into(),
                detail: format!(
                    "payload CRC mismatch: stored={:#010x}, computed={computed:#010x}",
                    self.payload_crc32c
                ),
            });
        }
        Ok(())
    }
}

/// Compute the CRC32C of a payload. Convenience for the writer.
pub fn payload_crc32c(payload: &[u8]) -> u32 {
    crc32c::crc32c(payload)
}

/// Compute the number of padding bytes needed to align a record to 16 bytes.
pub fn padding_for(body_size: usize) -> usize {
    (RECORD_ALIGNMENT - (body_size & (RECORD_ALIGNMENT - 1))) & (RECORD_ALIGNMENT - 1)
}

/// Format a small byte slice as `[0xHH, 0xHH, ...]` for error messages.
/// Used in the `BadMagic` error path so we don't need a hex dependency.
fn format_magic(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 6);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 {
            s.push_str(", ");
        }
        s.push_str(&format!("0x{b:02X}"));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_header() -> RecordHeader {
        let mut stream_hash = [0u8; 16];
        stream_hash[0] = 0xAB;
        stream_hash[15] = 0xCD;
        RecordHeader::new(RecordKind::Event, 42, stream_hash, 1024, 0xDEAD_BEEF)
    }

    #[test]
    fn round_trip_event() {
        let h = sample_header();
        let bytes = h.encode();
        assert_eq!(bytes.len(), HEADER_LEN as usize);
        assert_eq!(&bytes[0..4], b"WABI");
        let decoded = RecordHeader::decode(&bytes).unwrap();
        assert_eq!(h, decoded);
    }

    #[test]
    fn round_trip_all_kinds() {
        for kind in [RecordKind::Event, RecordKind::Snapshot, RecordKind::Tombstone, RecordKind::Checkpoint] {
            let mut sh = [0u8; 16];
            sh[0] = kind as u8;
            let h = RecordHeader::new(kind, 100, sh, 0, 0);
            let bytes = h.encode();
            let decoded = RecordHeader::decode(&bytes).unwrap();
            assert_eq!(decoded.record_kind, kind);
        }
    }

    #[test]
    fn bad_magic_rejected() {
        let mut bytes = sample_header().encode();
        bytes[0] = b'X';
        let err = RecordHeader::decode(&bytes).unwrap_err();
        assert!(matches!(err, WabiError::BadMagic { .. }), "got {err:?}");
    }

    #[test]
    fn unsupported_version_rejected() {
        let mut bytes = sample_header().encode();
        bytes[4..6].copy_from_slice(&99u16.to_le_bytes());
        let err = RecordHeader::decode(&bytes).unwrap_err();
        assert!(matches!(err, WabiError::UnsupportedFormatVersion { .. }), "got {err:?}");
    }

    #[test]
    fn wrong_header_len_rejected() {
        let mut bytes = sample_header().encode();
        bytes[6..8].copy_from_slice(&99u16.to_le_bytes());
        let err = RecordHeader::decode(&bytes).unwrap_err();
        assert!(matches!(err, WabiError::Corrupt { .. }), "got {err:?}");
    }

    #[test]
    fn header_crc_mismatch_rejected() {
        let mut bytes = sample_header().encode();
        bytes[12] ^= 0x01; // flip a bit in commit_seq
        let err = RecordHeader::decode(&bytes).unwrap_err();
        assert!(matches!(err, WabiError::Corrupt { .. }), "got {err:?}");
    }

    #[test]
    fn non_zero_flags_rejected() {
        let mut bytes = sample_header().encode();
        bytes[10..12].copy_from_slice(&1u16.to_le_bytes());
        let err = RecordHeader::decode(&bytes).unwrap_err();
        assert!(matches!(err, WabiError::Corrupt { .. }), "got {err:?}");
    }

    #[test]
    fn unknown_record_kind_rejected() {
        let mut bytes = sample_header().encode();
        bytes[8..10].copy_from_slice(&99u16.to_le_bytes());
        let err = RecordHeader::decode(&bytes).unwrap_err();
        assert!(matches!(err, WabiError::Corrupt { .. }), "got {err:?}");
    }

    #[test]
    fn oversized_payload_rejected() {
        let h = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], MAX_PAYLOAD_LEN + 1, 0);
        let bytes = h.encode();
        let err = RecordHeader::decode(&bytes).unwrap_err();
        assert!(matches!(err, WabiError::Corrupt { .. }), "got {err:?}");
    }

    #[test]
    fn payload_crc_verification() {
        let payload = b"hello, world";
        let crc = payload_crc32c(payload);
        let h = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], payload.len() as u32, crc);
        assert!(h.verify_payload_crc(payload).is_ok());

        // Wrong payload
        let wrong = b"goodbye, world";
        let err = h.verify_payload_crc(wrong).unwrap_err();
        assert!(matches!(err, WabiError::Corrupt { .. }), "got {err:?}");

        // Wrong length
        let err = h.verify_payload_crc(&payload[..payload.len() - 1]).unwrap_err();
        assert!(matches!(err, WabiError::Corrupt { .. }), "got {err:?}");
    }

    #[test]
    fn total_size_includes_alignment_padding() {
        // Header is 48 bytes, which is already 16-byte aligned.
        // So a 0-payload record is exactly 48 bytes; no padding.
        let h = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], 0, 0);
        assert_eq!(h.total_size(), 48);

        // 48 + 1 = 49, padded up to 64.
        let h = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], 1, 0);
        assert_eq!(h.total_size(), 64);

        // 48 + 16 = 64, already aligned, no padding.
        let h = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], 16, 0);
        assert_eq!(h.total_size(), 64);

        // 48 + 17 = 65, padded up to 80.
        let h = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], 17, 0);
        assert_eq!(h.total_size(), 80);
    }

    #[test]
    fn padding_for_aligns_to_16() {
        assert_eq!(padding_for(0), 0);
        assert_eq!(padding_for(1), 15);
        assert_eq!(padding_for(15), 1);
        assert_eq!(padding_for(16), 0);
        assert_eq!(padding_for(48), 0);
        assert_eq!(padding_for(49), 15);
        assert_eq!(padding_for(64), 0);
    }
}
