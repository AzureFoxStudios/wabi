//! One versioning pattern for durable postcard records.
//!
//! Postcard decodes a fixed sequence of fields, so `#[serde(default)]` cannot
//! supply a missing trailing field, and adding, removing or reordering a field
//! breaks every stored record of that type. A versioned record states its
//! layout, so a decoder can pick the right shape:
//!
//! ```text
//! offset  size  field
//! 0       10    MARKER   = 0xFF x 10
//! 10      4     tag      = the record type, 4 ASCII bytes (e.g. b"CMEM")
//! 14      1     version  = layout version of this record type, starting at 1
//! 15      ...   payload  = postcard encoding of that layout version
//! ```
//!
//! Records written before this header existed are raw postcard with no
//! header. They stay readable: when the marker is absent, the caller's legacy
//! decoder reads the bytes exactly as before.
//!
//! The marker cannot be the start of a legacy record. Postcard writes every
//! integer wider than one byte, every string or sequence length, every enum
//! discriminant, and every `bool`/`Option` tag as a varint of at most ten
//! bytes, and a byte with the high bit set means "more bytes follow". Ten
//! such bytes in a row are never a valid varint (postcard returns
//! `DeserializeBadVarint`), and `0xFF` is not a valid `bool` or `Option` tag.
//! So for a record whose first field is any of those kinds, legacy bytes never
//! begin with the marker, and new bytes never decode as legacy. The only
//! first-field kinds this argument does not cover are raw single bytes
//! (`u8`, `i8`), floats, and fixed-size arrays; do not use this helper for a
//! record that starts with one of those without adding a different check.
//!
//! To change a record's fields later: keep the old layout as its own struct,
//! bump the version, encode the new layout, and keep a decoder arm for every
//! version ever written. Never change the bytes a published version decodes.

use crate::error::{Result, WabiError};
use serde::de::DeserializeOwned;
use serde::Serialize;

/// Leading bytes of every versioned record. See the module docs for why no
/// legacy postcard record can start with them.
pub const MARKER: [u8; 10] = [0xFF; 10];

/// Length of the full header: marker, tag, version byte.
pub const HEADER_LEN: usize = MARKER.len() + 4 + 1;

/// Identity of one durable record type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordFormat {
    /// Four ASCII bytes naming the record type in the header.
    pub tag: [u8; 4],
    /// Used as the `location` of decode errors (e.g. "channel_members projection").
    pub location: &'static str,
}

impl RecordFormat {
    pub const fn new(tag: [u8; 4], location: &'static str) -> Self {
        Self { tag, location }
    }

    fn corrupt(&self, detail: String) -> WabiError {
        WabiError::Corrupt {
            location: self.location.into(),
            detail,
        }
    }
}

/// Encode `value` as layout `version` of `format`.
pub fn encode<T: Serialize + ?Sized>(format: &RecordFormat, version: u8, value: &T) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(HEADER_LEN + 64);
    bytes.extend_from_slice(&MARKER);
    bytes.extend_from_slice(&format.tag);
    bytes.push(version);
    postcard::to_extend(value, bytes).expect("postcard serialization failed")
}

/// True when `bytes` start with the versioned-record marker.
pub fn is_versioned(bytes: &[u8]) -> bool {
    bytes.starts_with(&MARKER)
}

/// Decode a record of `format`.
///
/// With the marker present, the tag must match and `versions` is called with
/// the version byte and the payload; it returns `None` for a version it does
/// not know, which is an error (a newer binary wrote it). With the marker
/// absent, `legacy` decodes the bytes as they were written before versioning.
pub fn decode<T>(
    format: &RecordFormat,
    bytes: &[u8],
    versions: impl FnOnce(u8, &[u8]) -> Option<Result<T>>,
    legacy: impl FnOnce(&[u8]) -> Result<T>,
) -> Result<T> {
    let Some(rest) = bytes.strip_prefix(&MARKER) else {
        return legacy(bytes);
    };
    if rest.len() < 5 {
        return Err(format.corrupt(format!(
            "versioned record header truncated at {} bytes",
            bytes.len()
        )));
    }
    let (tag, rest) = rest.split_at(4);
    if tag != format.tag {
        return Err(format.corrupt(format!(
            "record tag {:?} is not {:?}",
            String::from_utf8_lossy(tag),
            String::from_utf8_lossy(&format.tag)
        )));
    }
    let (version, payload) = (rest[0], &rest[1..]);
    versions(version, payload).unwrap_or_else(|| {
        Err(format.corrupt(format!(
            "unknown record version {version}; written by a newer build?"
        )))
    })
}

/// Strict postcard decode of a versioned payload: every byte must be used, so
/// a payload whose layout does not match its version byte is an error rather
/// than a silently truncated value.
pub fn payload<T: DeserializeOwned>(format: &RecordFormat, payload: &[u8]) -> Result<T> {
    let (value, rest) = postcard::take_from_bytes::<T>(payload)
        .map_err(|e| format.corrupt(format!("postcard decode failed: {e}")))?;
    if !rest.is_empty() {
        return Err(format.corrupt(format!(
            "{} unread bytes after versioned payload",
            rest.len()
        )));
    }
    Ok(value)
}

/// Lenient postcard decode for legacy (unversioned) bytes, exactly as records
/// were decoded before this module existed: trailing bytes are ignored.
pub fn legacy_postcard<T: DeserializeOwned>(format: &RecordFormat, bytes: &[u8]) -> Result<T> {
    postcard::from_bytes(bytes).map_err(|e| format.corrupt(format!("postcard decode failed: {e}")))
}

/// Encode layout version 1. Every record type starts here when it is first
/// versioned; a later field change moves its encoder to [`encode`] with 2.
pub fn encode_v1<T: Serialize + ?Sized>(format: &RecordFormat, value: &T) -> Vec<u8> {
    encode(format, 1, value)
}

/// Decode a record type whose only versioned layout is version 1 and whose
/// legacy bytes are raw postcard of the same struct. When the type gets a
/// version 2, replace this call with [`decode`] and keep an arm for 1.
pub fn decode_v1<T: DeserializeOwned>(format: &RecordFormat, bytes: &[u8]) -> Result<T> {
    decode(
        format,
        bytes,
        |version, body| (version == 1).then(|| payload(format, body)),
        |raw| legacy_postcard(format, raw),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    const FORMAT: RecordFormat = RecordFormat::new(*b"TEST", "test record");

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    struct V1 {
        id: String,
        n: u64,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    struct V2 {
        id: String,
        n: u64,
        note: Option<String>,
    }

    impl From<V1> for V2 {
        fn from(v: V1) -> Self {
            Self { id: v.id, n: v.n, note: None }
        }
    }

    fn decode_v2(bytes: &[u8]) -> Result<V2> {
        decode(
            &FORMAT,
            bytes,
            |version, body| match version {
                1 => Some(payload::<V1>(&FORMAT, body).map(V2::from)),
                2 => Some(payload::<V2>(&FORMAT, body)),
                _ => None,
            },
            |raw| legacy_postcard::<V1>(&FORMAT, raw).map(V2::from),
        )
    }

    fn sample_v1() -> V1 {
        V1 { id: "abc".into(), n: 300 }
    }

    #[test]
    fn v1_shorthand_matches_the_general_form() {
        let bytes = encode_v1(&FORMAT, &sample_v1());
        assert_eq!(bytes, encode(&FORMAT, 1, &sample_v1()));
        assert_eq!(decode_v1::<V1>(&FORMAT, &bytes).unwrap(), sample_v1());
        let raw = postcard::to_allocvec(&sample_v1()).unwrap();
        assert_eq!(decode_v1::<V1>(&FORMAT, &raw).unwrap(), sample_v1());
        assert!(decode_v1::<V1>(&FORMAT, &encode(&FORMAT, 2, &sample_v1())).is_err());
    }

    #[test]
    fn header_layout_is_marker_tag_version_payload() {
        let bytes = encode(&FORMAT, 7, &sample_v1());
        assert_eq!(&bytes[..10], &[0xFF; 10]);
        assert_eq!(&bytes[10..14], b"TEST");
        assert_eq!(bytes[14], 7);
        assert_eq!(&bytes[HEADER_LEN..], postcard::to_allocvec(&sample_v1()).unwrap());
        assert!(is_versioned(&bytes));
    }

    #[test]
    fn current_version_round_trips() {
        let value = V2 { id: "x".into(), n: u64::MAX, note: Some("hi".into()) };
        assert_eq!(decode_v2(&encode(&FORMAT, 2, &value)).unwrap(), value);
    }

    #[test]
    fn older_version_dispatches_to_its_own_decoder() {
        let bytes = encode(&FORMAT, 1, &sample_v1());
        assert_eq!(decode_v2(&bytes).unwrap(), V2::from(sample_v1()));
    }

    #[test]
    fn missing_marker_uses_the_legacy_decoder() {
        let raw = postcard::to_allocvec(&sample_v1()).unwrap();
        assert!(!is_versioned(&raw));
        assert_eq!(decode_v2(&raw).unwrap(), V2::from(sample_v1()));
    }

    #[test]
    fn legacy_decoder_keeps_ignoring_trailing_bytes() {
        let mut raw = postcard::to_allocvec(&sample_v1()).unwrap();
        raw.push(0);
        assert_eq!(decode_v2(&raw).unwrap(), V2::from(sample_v1()));
    }

    #[test]
    fn unknown_version_is_an_error_naming_the_version() {
        let err = decode_v2(&encode(&FORMAT, 9, &sample_v1())).unwrap_err();
        assert!(err.to_string().contains("unknown record version 9"), "{err}");
    }

    #[test]
    fn wrong_tag_is_an_error() {
        let other = RecordFormat::new(*b"OTHR", "other");
        let err = decode_v2(&encode(&other, 1, &sample_v1())).unwrap_err();
        assert!(err.to_string().contains("is not"), "{err}");
    }

    #[test]
    fn truncated_header_is_an_error() {
        for len in 10..HEADER_LEN {
            let bytes = &encode(&FORMAT, 1, &sample_v1())[..len];
            assert!(decode_v2(bytes).is_err(), "header of {len} bytes accepted");
        }
    }

    #[test]
    fn versioned_payload_must_be_fully_used() {
        // A V2 payload labelled V1 leaves the `note` bytes unread.
        let value = V2 { id: "x".into(), n: 1, note: Some("left over".into()) };
        let mislabelled = encode(&FORMAT, 1, &value);
        assert!(decode_v2(&mislabelled).is_err());
    }

    /// The marker must never be a valid start of a legacy record whose first
    /// field is a string, a sequence, an integer, a bool, an Option, or an enum.
    #[test]
    #[allow(dead_code)] // fields exist only to be decoded
    fn marker_is_never_a_legacy_postcard_prefix() {
        #[derive(Deserialize)]
        struct S(String, u64);
        #[derive(Deserialize)]
        struct U64(u64, String);
        #[derive(Deserialize)]
        struct I64(i64, String);
        #[derive(Deserialize)]
        struct U32(u32);
        #[derive(Deserialize)]
        struct B(bool);
        #[derive(Deserialize)]
        struct O(Option<String>);
        #[derive(Deserialize)]
        struct V(Vec<u8>);
        #[derive(Deserialize)]
        enum E {
            A,
        }
        let mut tails: Vec<Vec<u8>> = vec![vec![], vec![0], vec![1], vec![0x7F; 64]];
        tails.push(b"CMEM\x01\x03abc\x05".to_vec());
        tails.push((0..=255u8).collect());
        for tail in tails {
            let mut bytes = MARKER.to_vec();
            bytes.extend_from_slice(&tail);
            assert!(postcard::from_bytes::<S>(&bytes).is_err());
            assert!(postcard::from_bytes::<U64>(&bytes).is_err());
            assert!(postcard::from_bytes::<I64>(&bytes).is_err());
            assert!(postcard::from_bytes::<U32>(&bytes).is_err());
            assert!(postcard::from_bytes::<B>(&bytes).is_err());
            assert!(postcard::from_bytes::<O>(&bytes).is_err());
            assert!(postcard::from_bytes::<V>(&bytes).is_err());
            assert!(postcard::from_bytes::<E>(&bytes).is_err());
        }
    }

    /// And the converse: a value whose varint first field is as large as
    /// possible still does not start with the marker.
    #[test]
    fn largest_legacy_varints_do_not_start_with_the_marker() {
        for bytes in [
            postcard::to_allocvec(&(u64::MAX, "x")).unwrap(),
            postcard::to_allocvec(&(i64::MIN, "x")).unwrap(),
            postcard::to_allocvec(&(i64::MAX, "x")).unwrap(),
        ] {
            assert!(!is_versioned(&bytes), "{bytes:02x?}");
        }
    }
}
