use crate::error::Result;
use serde::de::DeserializeOwned;
use serde::Serialize;

/// Trait for projection record types that can be encoded/decoded.
///
/// Provides a default postcard-based implementation for any type that
/// implements `Serialize + DeserializeOwned`. Types with custom encoding
/// (e.g. JSON-based addon-object projections) can override.
///
/// This trait is the interface used by the Schema Registry (Phase 1a)
/// to generically encode/decode records without knowing concrete types.
pub trait RecordCodec: Sized + Serialize + DeserializeOwned {
    /// Human-readable name for error messages (default: "RecordCodec").
    fn codec_name() -> &'static str {
        "RecordCodec"
    }

    /// Encode this record to bytes for storage.
    fn encode(&self) -> Vec<u8> {
        postcard::to_allocvec(self).expect("postcard serialization failed")
    }

    /// Decode a record from bytes.
    fn decode(buf: &[u8]) -> Result<Self> {
        postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
            location: Self::codec_name().into(),
            detail: format!("postcard decode failed: {e}"),
        })
    }
}
