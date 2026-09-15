use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct FileAttachment {
    pub file_url: String,
    pub file_name: String,
    pub file_size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_encryption: Option<AttachmentEncryptionMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_storage: Option<AttachmentStorageMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct AttachmentEncryptionMeta {
    pub scheme: AttachmentEncryptionScheme,
    /// Legacy single-blob IV. Chunked E2EE files leave this as the nonce
    /// prefix for compatibility; `nonce_prefix` is the explicit field.
    pub iv: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_size: Option<u64>,
    /// Room-key epoch used to encrypt the file. Required for operator-blind
    /// attachments so old files remain decryptable after a room rekey.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<u64>,
    /// Plaintext chunk size for independently authenticated AES-GCM chunks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_size: Option<u64>,
    /// 64-bit random prefix; chunk index supplies the final 32 nonce bits.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce_prefix: Option<String>,
    /// Random opaque identifier bound into per-chunk authenticated data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct AttachmentStorageMeta {
    pub scheme: AttachmentStorageScheme,
    pub compressed: bool,
    pub codec: AttachmentStorageCodec,
    pub original_size: u64,
    pub stored_size: u64,
    pub at_rest_encrypted: bool,
}

#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum AttachmentEncryptionScheme {
    #[serde(rename = "dm-e2ee-v1")]
    #[cfg_attr(feature = "ts", ts(rename = "dm-e2ee-v1"))]
    DmE2eeV1,
}

#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub enum AttachmentStorageScheme {
    #[serde(rename = "wabi-storage-v1")]
    #[cfg_attr(feature = "ts", ts(rename = "wabi-storage-v1"))]
    WabiStorageV1,
}

#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum AttachmentStorageCodec {
    Identity,
    Gzip,
}
