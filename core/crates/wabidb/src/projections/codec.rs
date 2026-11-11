use crate::error::Result;
use serde::de::DeserializeOwned;
use serde::Serialize;

/// Trait for durable projection record types that can be encoded/decoded.
///
/// `encode` and `decode` have no default bodies on purpose. They once
/// defaulted to raw postcard, so an implementor that did not override them
/// wrote unversioned bytes through any `T: RecordCodec` path (for example
/// `payments::encode_record`). Every implementor now states its own durable
/// layout, normally by delegating to `format::versioned` (see that module for
/// how to change a record's fields). `record_codec_never_writes_unversioned_bytes`
/// in `tests/golden_records.rs` checks each implementor.
pub trait RecordCodec: Sized + Serialize + DeserializeOwned {
    /// Human-readable name for error messages (default: "RecordCodec").
    fn codec_name() -> &'static str {
        "RecordCodec"
    }

    /// Encode this record to bytes for storage, with the versioned header.
    fn encode(&self) -> Vec<u8>;

    /// Decode a record from bytes: versioned, or the legacy raw postcard that
    /// builds before versioning wrote.
    fn decode(buf: &[u8]) -> Result<Self>;
}
