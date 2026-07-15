use crate::error::Result;

#[cfg(test)]
use crate::error::WabiError;

use super::ws_subscribe::ConnectionRegistry;

pub fn ws_unsubscribe(conn_id: &str, registry: &ConnectionRegistry) -> Result<()> {
    registry.unregister(conn_id).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subscription::ws_subscribe::{ws_subscribe, WebSocketConn};

    fn make_conn(id: &str) -> WebSocketConn {
        WebSocketConn {
            conn_id: id.to_string(),
            consumer_id: "consumer_1".into(),
            topic_pattern: "channel:ch_01".into(),
            since_commit_seq: 0,
            connected_at_micros: 1000,
        }
    }

    #[test]
    fn unsubscribe_removes_connection() {
        let registry = ConnectionRegistry::new();
        ws_subscribe(make_conn("conn_01"), &registry).unwrap();
        assert!(ws_unsubscribe("conn_01", &registry).is_ok());
        assert_eq!(registry.len().unwrap(), 0);
    }

    #[test]
    fn double_unsubscribe_errors() {
        let registry = ConnectionRegistry::new();
        ws_subscribe(make_conn("conn_01"), &registry).unwrap();
        ws_unsubscribe("conn_01", &registry).unwrap();
        let err = ws_unsubscribe("conn_01", &registry).unwrap_err();
        assert!(matches!(err, WabiError::NotFound { .. }));
    }

    #[test]
    fn unknown_id_errors() {
        let registry = ConnectionRegistry::new();
        let err = ws_unsubscribe("nonexistent", &registry).unwrap_err();
        assert!(matches!(err, WabiError::NotFound { .. }));
    }
}
