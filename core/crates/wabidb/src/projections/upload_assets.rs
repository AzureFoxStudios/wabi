//! Published upload expectations. Bytes remain outside WabiDB; this index
//! records the immutable name, metadata, size and digest needed to verify a
//! passive receiver's copy before treating an upload as recoverable.

use crate::{
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    projections::{
        handler::{DurableEvent, Projection},
        upload_revocations::valid_filename,
    },
};
use serde::{Deserialize, Serialize};

pub const INDEX: &str = "upload_assets";
pub const EVENT: &str = "upload_published_v1";
pub const STREAM: &str = "upload-assets:v1";

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadAssetRecord {
    pub schema_version: u8,
    pub filename: String,
    pub original_name: String,
    pub channel_id: Option<String>,
    pub uploader_id: Option<i64>,
    pub kind: String,
    pub size: u64,
    pub sha256: String,
    pub created_at_micros: i64,
}

pub fn decode(bytes: &[u8]) -> Result<UploadAssetRecord> {
    let bad = || WabiError::Corrupt {
        location: INDEX.into(),
        detail: "invalid upload asset v1".into(),
    };
    if bytes.len() > 64 * 1024 {
        return Err(bad());
    }
    let record: UploadAssetRecord = serde_json::from_slice(bytes).map_err(|_| bad())?;
    if record.schema_version != 1
        || !valid_filename(&record.filename)
        || record.original_name.len() > 4096
        || record.channel_id.as_ref().is_some_and(|id| id.len() > 256)
        || !matches!(
            record.kind.as_str(),
            "attachment" | "avatar" | "profile" | "branding" | "whiteboard" | "other"
        )
        || record.sha256.len() != 64
        || hex::decode(&record.sha256).is_err()
        || record.created_at_micros <= 0
    {
        return Err(bad());
    }
    Ok(record)
}

pub struct UploadAssetsProjection;

impl Projection for UploadAssetsProjection {
    fn event_type(&self) -> &str {
        EVENT
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        if event.stream_id != STREAM {
            return Err(WabiError::Corrupt {
                location: INDEX.into(),
                detail: "upload asset has wrong stream".into(),
            });
        }
        let record = decode(&event.payload)?;
        if let Some(existing) = state.get(INDEX, record.filename.as_bytes()) {
            if decode(&existing)? != record {
                return Err(WabiError::Corrupt {
                    location: INDEX.into(),
                    detail: "upload asset filename changed".into(),
                });
            }
            return Ok(());
        }
        state.insert(
            INDEX,
            record.filename.as_bytes().to_vec(),
            event.payload.clone(),
            event.commit_seq,
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(hash: &str) -> Vec<u8> {
        serde_json::json!({
            "schemaVersion": 1,
            "filename": "a.bin",
            "originalName": "example.bin",
            "channelId": null,
            "uploaderId": 1,
            "kind": "attachment",
            "size": 3,
            "sha256": hash,
            "createdAtMicros": 1,
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn asset_payload_is_versioned_and_hash_bounded() {
        let hash = "a".repeat(64);
        assert_eq!(decode(&payload(&hash)).unwrap().size, 3);
        assert!(decode(&payload("bad")).is_err());
        assert!(decode(&vec![0; 64 * 1024 + 1]).is_err());
        let bad_name = payload(&hash)
            .windows(5)
            .position(|window| window == b"a.bin")
            .unwrap();
        let mut bytes = payload(&hash);
        bytes.splice(bad_name..bad_name + 5, b"../ab".iter().copied());
        assert!(decode(&bytes).is_err());
    }

    #[test]
    fn filename_cannot_change_to_another_hash() {
        let state = ProjectionState::new();
        let projection = UploadAssetsProjection;
        let event = |seq, hash: String| DurableEvent {
            commit_seq: seq,
            stream_id: STREAM.into(),
            event_type: EVENT.into(),
            payload: payload(&hash),
        };
        let first = event(1, "a".repeat(64));
        projection.apply(&first, &state).unwrap();
        projection.apply(&event(2, "a".repeat(64)), &state).unwrap();
        assert!(projection.apply(&event(3, "b".repeat(64)), &state).is_err());
    }
}
