use crate::error::Result;
use crate::sequencer::types::DurableEvent;

use super::ws_subscribe::ConnectionRegistry;

pub fn ws_resume(
    conn_id: &str,
    since_commit_seq: u64,
    registry: &ConnectionRegistry,
    events: &[DurableEvent],
) -> Result<Vec<DurableEvent>> {
    let _conn = registry.get(conn_id)?;
    let filtered: Vec<DurableEvent> = events
        .iter()
        .filter(|e| e.commit_seq > since_commit_seq)
        .cloned()
        .collect();
    Ok(filtered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscription::ws_subscribe::{ws_subscribe, WebSocketConn, ConnectionRegistry};

    fn with_registry() -> ConnectionRegistry {
        let reg = ConnectionRegistry::new();
        let conn = WebSocketConn {
            conn_id: "conn_01".into(),
            consumer_id: "test_consumer".into(),
            topic_pattern: "channel:ch_01".into(),
            since_commit_seq: 0,
            connected_at_micros: 1000,
        };
        ws_subscribe(conn, &reg).unwrap();
        reg
    }

    fn make_event(commit_seq: u64, stream_id: &str) -> DurableEvent {
        DurableEvent {
            commit_seq,
            stream_id: stream_id.to_string(),
            event_type: "message_created".into(),
            ciphertext: vec![],
            record_bytes: vec![],
        }
    }

    fn make_events() -> Vec<DurableEvent> {
        (1..=10).map(|i| make_event(i, "ch_01")).collect()
    }

    #[test]
    fn resume_from_n_returns_n_plus_one_through_m() {
        let reg = with_registry();
        let events = make_events();
        let result = ws_resume("conn_01", 5, &reg, &events).unwrap();
        assert_eq!(result.len(), 5);
        assert_eq!(result[0].commit_seq, 6);
        assert_eq!(result[4].commit_seq, 10);
    }

    #[test]
    fn resume_from_0_returns_all() {
        let reg = with_registry();
        let events = make_events();
        let result = ws_resume("conn_01", 0, &reg, &events).unwrap();
        assert_eq!(result.len(), 10);
    }

    #[test]
    fn resume_past_end_returns_empty() {
        let reg = with_registry();
        let events = make_events();
        let result = ws_resume("conn_01", 100, &reg, &events).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn resume_excludes_since_seq() {
        let reg = with_registry();
        let events = make_events();
        let result = ws_resume("conn_01", 10, &reg, &events).unwrap();
        assert!(result.is_empty());
    }
}
