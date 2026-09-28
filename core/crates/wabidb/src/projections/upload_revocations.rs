//! Durable upload revocations. The local JSON registry remains a compatibility
//! copy, but these events let a fenced database receiver retain revocation
//! decisions across incremental catch-up.

use crate::{
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    projections::handler::{DurableEvent, Projection},
};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

pub const INDEX: &str = "upload_revocations";
pub const EVENT: &str = "upload_revoked_v1";
pub const STREAM: &str = "upload-revocations:v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RevokedUploadRecord {
    pub schema_version: u8,
    pub filename: String,
}

pub fn valid_filename(filename: &str) -> bool {
    if filename.is_empty()
        || filename.len() > 512
        || filename.chars().any(|ch| matches!(ch, '/' | '\\' | '\0'))
    {
        return false;
    }
    let mut components = Path::new(filename).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

pub fn decode(bytes: &[u8]) -> Result<RevokedUploadRecord> {
    let bad = || WabiError::Corrupt {
        location: INDEX.into(),
        detail: "invalid upload revocation v1".into(),
    };
    if bytes.len() > 2048 {
        return Err(bad());
    }
    let record: RevokedUploadRecord = serde_json::from_slice(bytes).map_err(|_| bad())?;
    if record.schema_version != 1 || !valid_filename(&record.filename) {
        return Err(bad());
    }
    Ok(record)
}

pub struct UploadRevocationsProjection;

impl Projection for UploadRevocationsProjection {
    fn event_type(&self) -> &str {
        EVENT
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        if event.stream_id != STREAM {
            return Err(WabiError::Corrupt {
                location: INDEX.into(),
                detail: "upload revocation has wrong stream".into(),
            });
        }
        let record = decode(&event.payload)?;
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

    #[test]
    fn payload_is_versioned_and_filename_is_bounded() {
        assert_eq!(
            decode(br#"{"schemaVersion":1,"filename":"file.jpg"}"#)
                .unwrap()
                .filename,
            "file.jpg"
        );
        assert!(decode(br#"{"schemaVersion":2,"filename":"file.jpg"}"#).is_err());
        assert!(decode(br#"{"schemaVersion":1,"filename":"../file.jpg"}"#).is_err());
        assert!(decode(br#"{"schemaVersion":1,"filename":""}"#).is_err());
        assert!(decode(&vec![b'a'; 2049]).is_err());
    }

    #[test]
    fn event_projects_a_revocation_by_filename() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 7,
            stream_id: STREAM.into(),
            event_type: EVENT.into(),
            payload: br#"{"schemaVersion":1,"filename":"file.jpg"}"#.to_vec(),
        };
        UploadRevocationsProjection.apply(&event, &state).unwrap();
        assert!(state.get(INDEX, b"file.jpg").is_some());
        assert!(state.get(INDEX, b"other.jpg").is_none());
    }
}
