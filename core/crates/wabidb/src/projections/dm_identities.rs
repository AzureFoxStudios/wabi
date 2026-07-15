use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DmIdentityRecord {
    pub user_id: u64,
    pub device_id: String,
    pub identity_key: String,
    pub signed_pre_key: String,
    pub signed_pre_key_signature: String,
    pub one_time_prekeys: Vec<String>,
    pub created_at_micros: i64,
    pub last_seen_micros: i64,
}

impl RecordCodec for DmIdentityRecord {
    fn codec_name() -> &'static str {
        "dm_identities"
    }
}

pub fn encode_record(r: &DmIdentityRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<DmIdentityRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "dm_identities projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(user_id: u64, device_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&user_id.to_be_bytes());
    buf.extend_from_slice(&(device_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(device_id.as_bytes());
    buf
}

impl DmIdentitiesProjection {
    /// Look up a single device identity for a user.
    pub fn get_identity(state: &ProjectionState, user_id: u64, device_id: &str) -> Result<Option<DmIdentityRecord>> {
        let key = encode_key(user_id, device_id);
        match state.get("dm_identities", &key) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }

    /// List all device identities for a user.
    pub fn list_identities(state: &ProjectionState, user_id: u64) -> Result<Vec<DmIdentityRecord>> {
        let prefix = user_id.to_be_bytes().to_vec();
        let mut results = Vec::new();
        state.prefix_scan("dm_identities", &prefix, |_key, value| {
            if let Ok(record) = decode_record(value) {
                results.push(record);
            }
        });
        Ok(results)
    }

    /// Pop a one-time prekey from a device's bundle, returning it if available.
    pub fn take_onetime_prekey(state: &ProjectionState, user_id: u64, device_id: &str) -> Result<Option<String>> {
        let key = encode_key(user_id, device_id);
        match state.get("dm_identities", &key) {
            None => Ok(None),
            Some(bytes) => {
                let mut record = decode_record(&bytes)?;
                if record.one_time_prekeys.is_empty() {
                    return Ok(None);
                }
                let prekey = record.one_time_prekeys.remove(0);
                let value = encode_record(&record);
                state.insert("dm_identities", key, value, 0);
                Ok(Some(prekey))
            }
        }
    }

    /// Remove a specific one-time prekey from a device's bundle.
    pub fn remove_onetime_prekey(state: &ProjectionState, user_id: u64, device_id: &str, prekey: &str) -> Result<bool> {
        let key = encode_key(user_id, device_id);
        match state.get("dm_identities", &key) {
            None => Ok(false),
            Some(bytes) => {
                let mut record = decode_record(&bytes)?;
                let len_before = record.one_time_prekeys.len();
                record.one_time_prekeys.retain(|k| k != prekey);
                let removed = record.one_time_prekeys.len() < len_before;
                if removed {
                    let value = encode_record(&record);
                    state.insert("dm_identities", key, value, 0);
                }
                Ok(removed)
            }
        }
    }
}

pub struct DmIdentitiesProjection;

impl Projection for DmIdentitiesProjection {
    fn event_type(&self) -> &str {
        "dm_identity_registered"
    }

    fn event_types(&self) -> Vec<&str> {
        vec![
            "dm_identity_registered",
            "dm_onetime_prekey_consumed",
        ]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "dm_identity_registered" => {
                let record: DmIdentityRecord = decode_record(&event.payload)?;
                let key = encode_key(record.user_id, &record.device_id);
                let value = encode_record(&record);
                state.insert("dm_identities", key, value, event.commit_seq);
                Ok(())
            }
            "dm_onetime_prekey_consumed" => {
                #[derive(Deserialize)]
                struct ConsumedPayload {
                    user_id: u64,
                    device_id: String,
                    prekey_public: String,
                }
                let payload: ConsumedPayload = postcard::from_bytes(&event.payload)
                    .map_err(|e| crate::error::WabiError::Corrupt {
                        location: "dm_identities projection".into(),
                        detail: format!("onetime_prekey_consumed decode failed: {e}"),
                    })?;
                DmIdentitiesProjection::remove_onetime_prekey(
                    state,
                    payload.user_id,
                    &payload.device_id,
                    &payload.prekey_public,
                )?;
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_identity(user_id: u64, device_id: &str, num_prekeys: usize) -> DmIdentityRecord {
        let prekeys: Vec<String> = (0..num_prekeys)
            .map(|i| format!("prekey_{}_{i}", device_id))
            .collect();
        DmIdentityRecord {
            user_id,
            device_id: device_id.into(),
            identity_key: format!("idkey_{}", device_id),
            signed_pre_key: format!("spk_{}", device_id),
            signed_pre_key_signature: format!("sig_{}", device_id),
            one_time_prekeys: prekeys,
            created_at_micros: 1_000_000,
            last_seen_micros: 1_000_000,
        }
    }

    fn apply_register(state: &ProjectionState, record: &DmIdentityRecord, seq: u64) {
        let event = DurableEvent {
            commit_seq: seq,
            stream_id: format!("dm_identity_{}", record.user_id),
            event_type: "dm_identity_registered".into(),
            payload: encode_record(record),
        };
        DmIdentitiesProjection.apply(&event, state).unwrap();
    }

    #[test]
    fn encode_decode_roundtrip() {
        let r = make_identity(42, "dev_a", 3);
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn insert_and_lookup_by_user_device() {
        let state = ProjectionState::new();
        let record = make_identity(42, "dev_a", 5);
        apply_register(&state, &record, 1);

        let loaded = DmIdentitiesProjection::get_identity(&state, 42, "dev_a")
            .unwrap()
            .unwrap();
        assert_eq!(loaded.identity_key, "idkey_dev_a");
        assert_eq!(loaded.one_time_prekeys.len(), 5);
    }

    #[test]
    fn list_identities_returns_all_devices() {
        let state = ProjectionState::new();
        for i in 0..3 {
            let record = make_identity(42, &format!("dev_{i}"), 2);
            apply_register(&state, &record, (i + 1) as u64);
        }
        let devices = DmIdentitiesProjection::list_identities(&state, 42).unwrap();
        assert_eq!(devices.len(), 3);
    }

    #[test]
    fn list_identities_scoped_by_user() {
        let state = ProjectionState::new();
        let alice = make_identity(42, "phone", 3);
        let bob = make_identity(99, "phone", 3);
        apply_register(&state, &alice, 1);
        apply_register(&state, &bob, 2);

        let alice_devices = DmIdentitiesProjection::list_identities(&state, 42).unwrap();
        assert_eq!(alice_devices.len(), 1);

        let bob_devices = DmIdentitiesProjection::list_identities(&state, 99).unwrap();
        assert_eq!(bob_devices.len(), 1);
    }

    #[test]
    fn missing_identity_returns_none() {
        let state = ProjectionState::new();
        assert!(
            DmIdentitiesProjection::get_identity(&state, 99, "ghost")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn take_onetime_prekey_pops_from_bundle() {
        let state = ProjectionState::new();
        let record = make_identity(42, "dev_a", 3);
        apply_register(&state, &record, 1);

        let taken = DmIdentitiesProjection::take_onetime_prekey(&state, 42, "dev_a")
            .unwrap()
            .unwrap();
        assert_eq!(taken, "prekey_dev_a_0");

        let remaining = DmIdentitiesProjection::get_identity(&state, 42, "dev_a")
            .unwrap()
            .unwrap();
        assert_eq!(remaining.one_time_prekeys.len(), 2);
        assert_eq!(remaining.one_time_prekeys[0], "prekey_dev_a_1");
    }

    #[test]
    fn take_onetime_prekey_empty_bundle_returns_none() {
        let state = ProjectionState::new();
        let record = make_identity(42, "dev_a", 0);
        apply_register(&state, &record, 1);
        assert!(
            DmIdentitiesProjection::take_onetime_prekey(&state, 42, "dev_a")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn consume_onetime_prekey_via_event() {
        let state = ProjectionState::new();
        let record = make_identity(42, "dev_a", 3);
        apply_register(&state, &record, 1);

        #[derive(Serialize)]
        struct ConsumedPayload {
            user_id: u64,
            device_id: String,
            prekey_public: String,
        }
        let payload = postcard::to_allocvec(&ConsumedPayload {
            user_id: 42,
            device_id: "dev_a".into(),
            prekey_public: "prekey_dev_a_1".into(),
        })
        .unwrap();
        let event = DurableEvent {
            commit_seq: 2,
            stream_id: "dm_identity_42".into(),
            event_type: "dm_onetime_prekey_consumed".into(),
            payload,
        };
        DmIdentitiesProjection.apply(&event, &state).unwrap();

        let remaining = DmIdentitiesProjection::get_identity(&state, 42, "dev_a")
            .unwrap()
            .unwrap();
        assert_eq!(remaining.one_time_prekeys.len(), 2);
        assert!(!remaining.one_time_prekeys.contains(&"prekey_dev_a_1".to_string()));
    }

    #[test]
    fn event_type_multiple() {
        let proj = DmIdentitiesProjection;
        let types = proj.event_types();
        assert!(types.contains(&"dm_identity_registered"));
        assert!(types.contains(&"dm_onetime_prekey_consumed"));
    }
}
