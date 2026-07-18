use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::projections::codec::RecordCodec;
use crate::projections::handler::{DurableEvent, Projection};
use crate::projections::query::{apply_limit, IncidentsFilter, QueryableProjection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IncidentRecord {
    pub incident_id: String,
    pub channel_id: String,
    pub title: String,
    pub description: String,
    pub severity: String,
    pub status: String,
    pub reporter_user_id: u64,
    pub assigned_user_id: Option<u64>,
    pub created_at_micros: i64,
    pub updated_at_micros: i64,
    pub resolved_at_micros: Option<i64>,
    pub is_deleted: bool,
}

impl RecordCodec for IncidentRecord {
    fn codec_name() -> &'static str {
        "incidents"
    }
}

pub fn encode_record(r: &IncidentRecord) -> Vec<u8> {
    postcard::to_allocvec(r).expect("postcard serialization failed")
}

pub fn decode_record(buf: &[u8]) -> Result<IncidentRecord> {
    postcard::from_bytes(buf).map_err(|e| crate::error::WabiError::Corrupt {
        location: "incident projection".into(),
        detail: format!("postcard decode failed: {e}"),
    })
}

pub fn encode_key(channel_id: &str, incident_id: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    buf.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(channel_id.as_bytes());
    buf.extend_from_slice(&(incident_id.len() as u64).to_le_bytes());
    buf.extend_from_slice(incident_id.as_bytes());
    buf
}

impl IncidentProjection {
    /// Look up a single incident.
    pub fn get_incident(state: &ProjectionState, channel_id: &str, incident_id: &str) -> Result<Option<IncidentRecord>> {
        let key = encode_key(channel_id, incident_id);
        match state.get("incidents", &key) {
            None => Ok(None),
            Some(bytes) => decode_record(&bytes).map(Some),
        }
    }

    /// List incidents in a channel. When `include_deleted` is false (the
    /// common case), soft-deleted records are filtered out.
    pub fn list_incidents(state: &ProjectionState, channel_id: &str, include_deleted: bool) -> Result<Vec<IncidentRecord>> {
        let mut prefix = Vec::new();
        prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
        prefix.extend_from_slice(channel_id.as_bytes());
        let mut results = Vec::new();
        state.prefix_scan("incidents", &prefix, |_key, value| {
            if let Ok(record) = decode_record(value) {
                if include_deleted || !record.is_deleted {
                    results.push(record);
                }
            }
        });
        Ok(results)
    }

    /// Remove all soft-deleted records from the `incidents` index.
    pub fn compact(state: &ProjectionState) -> usize {
        state.compact_index("incidents", |_key, value| {
            postcard::from_bytes::<IncidentRecord>(value)
                .ok()
                .map_or(false, |r| r.is_deleted)
        })
    }
}

pub struct IncidentProjection;

impl Projection for IncidentProjection {
    fn event_type(&self) -> &str {
        "incident_created"
    }

    fn event_types(&self) -> Vec<&str> {
        vec!["incident_created", "incident_updated", "incident_resolved"]
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        match event.event_type.as_str() {
            "incident_created" => self.apply_created(event, state),
            "incident_updated" => self.apply_updated(event, state),
            "incident_resolved" => self.apply_resolved(event, state),
            _ => Ok(()),
        }
    }
}

impl IncidentProjection {
    fn apply_created(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let mut record: IncidentRecord = decode_record(&event.payload)?;
        record.incident_id = format!("inc_{:x}", event.commit_seq);
        let key = encode_key(&record.channel_id, &record.incident_id);
        let value = encode_record(&record);
        state.insert("incidents", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_updated(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: IncidentRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.channel_id, &record.incident_id);
        let value = encode_record(&record);
        state.insert("incidents", key, value, event.commit_seq);
        Ok(())
    }

    fn apply_resolved(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let record: IncidentRecord = decode_record(&event.payload)?;
        let key = encode_key(&record.channel_id, &record.incident_id);
        let value = encode_record(&record);
        state.insert("incidents", key, value, event.commit_seq);
        Ok(())
    }
}

impl QueryableProjection for IncidentProjection {
    type Record = IncidentRecord;
    type Filter = IncidentsFilter;

    fn query(&self, state: &ProjectionState, filter: &IncidentsFilter) -> Result<Vec<IncidentRecord>> {
        let mut results = Vec::new();
        match &filter.channel_id {
            // channel_id is the leading key component; incident_id narrows further.
            Some(channel_id) => {
                let mut prefix = Vec::new();
                prefix.extend_from_slice(&(channel_id.len() as u64).to_le_bytes());
                prefix.extend_from_slice(channel_id.as_bytes());
                if let Some(incident_id) = &filter.incident_id {
                    prefix.extend_from_slice(&(incident_id.len() as u64).to_le_bytes());
                    prefix.extend_from_slice(incident_id.as_bytes());
                }
                state.prefix_scan("incidents", &prefix, |_key, value| {
                    if let Ok(record) = decode_record(value) {
                        if !filter.include_deleted && record.is_deleted {
                            return;
                        }
                        results.push(record);
                    }
                });
            }
            None => {
                state.for_each("incidents", |_key, value| {
                    if let Ok(record) = decode_record(value) {
                        if let Some(incident_id) = &filter.incident_id {
                            if &record.incident_id != incident_id {
                                return;
                            }
                        }
                        if !filter.include_deleted && record.is_deleted {
                            return;
                        }
                        results.push(record);
                    }
                });
            }
        }
        apply_limit(&mut results, filter.limit);
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projections::handler::DispatchTable;
    use std::sync::Arc;

    fn sample_incident() -> IncidentRecord {
        IncidentRecord {
            incident_id: String::new(),
            channel_id: "ch_inc".into(),
            title: "Database latency spike".into(),
            description: "P95 latency increased to 5s".into(),
            severity: "high".into(),
            status: "investigating".into(),
            reporter_user_id: 1,
            assigned_user_id: None,
            created_at_micros: 1_000_000,
            updated_at_micros: 1_000_000,
            resolved_at_micros: None,
            is_deleted: false,
        }
    }

    fn make_event(seq: u64, event_type: &str, record: &IncidentRecord) -> DurableEvent {
        DurableEvent {
            commit_seq: seq,
            stream_id: record.channel_id.clone(),
            event_type: event_type.to_string(),
            payload: encode_record(record),
        }
    }

    #[test]
    fn encode_decode_roundtrip() {
        let r = sample_incident();
        let buf = encode_record(&r);
        let decoded = decode_record(&buf).unwrap();
        assert_eq!(r, decoded);
    }

    #[test]
    fn event_type_returns_correct() {
        let proj = IncidentProjection;
        assert_eq!(proj.event_type(), "incident_created");
        assert!(proj.event_types().contains(&"incident_updated"));
        assert!(proj.event_types().contains(&"incident_resolved"));
    }

    #[test]
    fn insert_and_lookup() {
        let state = ProjectionState::new();
        let proj = IncidentProjection;
        let r = sample_incident();
        let event = make_event(1, "incident_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("inc_{:x}", event.commit_seq);
        let key = encode_key("ch_inc", &expected_id);
        let stored = state.get("incidents", &key).unwrap();
        let decoded = decode_record(&stored).unwrap();
        assert_eq!(decoded.incident_id, expected_id);
        assert_eq!(decoded.severity, "high");
    }

    #[test]
    fn dispatch_table_routes_incident_events() {
        let table = DispatchTable::new(vec![Arc::new(IncidentProjection)]).unwrap();
        let state = ProjectionState::new();
        let r = sample_incident();
        let event = make_event(1, "incident_created", &r);
        let handler = table.get("incident_created").unwrap();
        handler.apply(&event, &state).unwrap();
        let expected_id = format!("inc_{:x}", event.commit_seq);
        let key = encode_key("ch_inc", &expected_id);
        assert!(state.get("incidents", &key).is_some());
    }

    #[test]
    fn updated_overwrites_record() {
        let state = ProjectionState::new();
        let proj = IncidentProjection;
        let r = sample_incident();
        let event = make_event(1, "incident_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("inc_{:x}", event.commit_seq);
        let key = encode_key("ch_inc", &expected_id);
        let stored = state.get("incidents", &key).unwrap();
        let mut stored_record = decode_record(&stored).unwrap();
        stored_record.status = "identified".into();
        stored_record.assigned_user_id = Some(42);
        let update_event = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_inc".into(),
            event_type: "incident_updated".into(),
            payload: encode_record(&stored_record),
        };
        proj.apply(&update_event, &state).unwrap();
        let decoded = decode_record(&state.get("incidents", &key).unwrap()).unwrap();
        assert_eq!(decoded.status, "identified");
        assert_eq!(decoded.assigned_user_id, Some(42));
    }

    #[test]
    fn resolve_sets_resolved_at() {
        let state = ProjectionState::new();
        let proj = IncidentProjection;
        let r = sample_incident();
        let event = make_event(1, "incident_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("inc_{:x}", event.commit_seq);
        let key = encode_key("ch_inc", &expected_id);
        let stored = state.get("incidents", &key).unwrap();
        let mut stored_record = decode_record(&stored).unwrap();
        stored_record.status = "resolved".into();
        stored_record.resolved_at_micros = Some(2_000_000);
        let resolve_event = DurableEvent {
            commit_seq: 2,
            stream_id: "ch_inc".into(),
            event_type: "incident_resolved".into(),
            payload: encode_record(&stored_record),
        };
        proj.apply(&resolve_event, &state).unwrap();
        let decoded = decode_record(&state.get("incidents", &key).unwrap()).unwrap();
        assert_eq!(decoded.status, "resolved");
        assert_eq!(decoded.resolved_at_micros, Some(2_000_000));
    }

    #[test]
    fn typed_get_incident_after_insert() {
        let state = ProjectionState::new();
        let proj = IncidentProjection;
        let r = sample_incident();
        let event = make_event(1, "incident_created", &r);
        proj.apply(&event, &state).unwrap();
        let expected_id = format!("inc_{:x}", event.commit_seq);
        let loaded = IncidentProjection::get_incident(&state, "ch_inc", &expected_id).unwrap().unwrap();
        assert_eq!(loaded.incident_id, expected_id);
    }

    #[test]
    fn typed_list_incidents_returns_all() {
        let state = ProjectionState::new();
        let proj = IncidentProjection;
        for seq in 1..=3 {
            let mut r = sample_incident();
            r.title = format!("Incident {seq}");
            let event = make_event(seq, "incident_created", &r);
            proj.apply(&event, &state).unwrap();
        }
        let incidents = IncidentProjection::list_incidents(&state, "ch_inc", false).unwrap();
        assert_eq!(incidents.len(), 3);
    }

    #[test]
    fn list_incidents_filters_deleted() {
        let state = ProjectionState::new();
        let proj = IncidentProjection;
        for seq in 1..=3 {
            let mut r = sample_incident();
            r.title = format!("Incident {seq}");
            proj.apply(&make_event(seq, "incident_created", &r), &state).unwrap();
        }
        // There's no dedicated delete event type; simulate via updated.
        let key = encode_key("ch_inc", &format!("inc_{:x}", 2));
        let stored = state.get("incidents", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(4, "incident_updated", &deleted), &state).unwrap();

        let all = IncidentProjection::list_incidents(&state, "ch_inc", false).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|i| !i.is_deleted));

        let with_deleted = IncidentProjection::list_incidents(&state, "ch_inc", true).unwrap();
        assert_eq!(with_deleted.len(), 3);
        assert!(with_deleted.iter().any(|i| i.is_deleted));
    }

    #[test]
    fn compact_removes_deleted_incidents() {
        let state = ProjectionState::new();
        let proj = IncidentProjection;
        for seq in 1..=3 {
            let mut r = sample_incident();
            r.title = format!("Incident {seq}");
            proj.apply(&make_event(seq, "incident_created", &r), &state).unwrap();
        }
        let key = encode_key("ch_inc", &format!("inc_{:x}", 2));
        let stored = state.get("incidents", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(4, "incident_updated", &deleted), &state).unwrap();

        assert_eq!(IncidentProjection::list_incidents(&state, "ch_inc", true).unwrap().len(), 3);
        let removed = IncidentProjection::compact(&state);
        assert_eq!(removed, 1);
        assert_eq!(IncidentProjection::list_incidents(&state, "ch_inc", true).unwrap().len(), 2);
    }

    #[test]
    fn bad_payload_returns_error() {
        let state = ProjectionState::new();
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "ch_inc".into(),
            event_type: "incident_created".into(),
            payload: vec![0xde, 0xad],
        };
        let result = IncidentProjection.apply(&event, &state);
        assert!(result.is_err());
    }

    // --- IncidentProjection query tests ------------------------------------

    #[test]
    fn query_by_channel_uses_prefix() {
        let state = ProjectionState::new();
        let proj = IncidentProjection;
        for seq in 1..=3 {
            let mut r = sample_incident();
            r.title = format!("Incident {seq}");
            proj.apply(&make_event(seq, "incident_created", &r), &state).unwrap();
        }
        let mut other = sample_incident();
        other.channel_id = "ch_other".into();
        proj.apply(&make_event(9, "incident_created", &other), &state).unwrap();

        let results = proj.query(&state, &IncidentsFilter { channel_id: Some("ch_inc".into()), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(|i| i.channel_id == "ch_inc"));
    }

    #[test]
    fn query_by_incident_id_narrows() {
        let state = ProjectionState::new();
        let proj = IncidentProjection;
        for seq in 1..=2 {
            let mut r = sample_incident();
            r.title = format!("Incident {seq}");
            proj.apply(&make_event(seq, "incident_created", &r), &state).unwrap();
        }
        let inc_id = format!("inc_{:x}", 1);
        let results = proj.query(&state, &IncidentsFilter { channel_id: Some("ch_inc".into()), incident_id: Some(inc_id.clone()), ..Default::default() }).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].incident_id, inc_id);
    }

    #[test]
    fn query_filters_deleted() {
        let state = ProjectionState::new();
        let proj = IncidentProjection;
        for seq in 1..=2 {
            let mut r = sample_incident();
            r.title = format!("Incident {seq}");
            proj.apply(&make_event(seq, "incident_created", &r), &state).unwrap();
        }
        let key = encode_key("ch_inc", &format!("inc_{:x}", 2));
        let stored = state.get("incidents", &key).unwrap();
        let mut deleted = decode_record(&stored).unwrap();
        deleted.is_deleted = true;
        proj.apply(&make_event(3, "incident_updated", &deleted), &state).unwrap();

        assert_eq!(proj.query(&state, &IncidentsFilter { channel_id: Some("ch_inc".into()), ..Default::default() }).unwrap().len(), 1);
        assert_eq!(proj.query(&state, &IncidentsFilter { channel_id: Some("ch_inc".into()), include_deleted: true, ..Default::default() }).unwrap().len(), 2);
    }
}
