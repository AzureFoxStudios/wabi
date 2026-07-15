use std::collections::HashMap;
use std::sync::RwLock;

use crate::error::{Result, WabiError};

#[derive(Debug, Clone)]
pub struct WebSocketConn {
    pub conn_id: String,
    pub consumer_id: String,
    pub topic_pattern: String,
    pub since_commit_seq: u64,
    pub connected_at_micros: i64,
}

#[derive(Debug, Default)]
pub struct ConnectionRegistry {
    conns: RwLock<HashMap<String, WebSocketConn>>,
}

impl ConnectionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, conn: WebSocketConn) -> Result<()> {
        let mut conns = self.conns.write().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "connection registry lock poisoned".into(),
        })?;
        if conns.contains_key(&conn.conn_id) {
            return Err(WabiError::Validation {
                command: "ws_subscribe".into(),
                reason: format!("connection {} already registered", conn.conn_id),
            });
        }
        conns.insert(conn.conn_id.clone(), conn);
        Ok(())
    }

    pub fn unregister(&self, conn_id: &str) -> Result<WebSocketConn> {
        let mut conns = self.conns.write().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "connection registry lock poisoned".into(),
        })?;
        conns.remove(conn_id).ok_or_else(|| WabiError::NotFound {
            what: format!("connection {conn_id}"),
        })
    }

    pub fn get(&self, conn_id: &str) -> Result<WebSocketConn> {
        let conns = self.conns.read().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "connection registry lock poisoned".into(),
        })?;
        conns.get(conn_id).cloned().ok_or_else(|| WabiError::NotFound {
            what: format!("connection {conn_id}"),
        })
    }

    pub fn all(&self) -> Result<Vec<WebSocketConn>> {
        let conns = self.conns.read().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "connection registry lock poisoned".into(),
        })?;
        Ok(conns.values().cloned().collect())
    }

    pub fn len(&self) -> Result<usize> {
        let conns = self.conns.read().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "connection registry lock poisoned".into(),
        })?;
        Ok(conns.len())
    }
}

pub fn ws_subscribe(
    conn: WebSocketConn,
    registry: &ConnectionRegistry,
) -> Result<()> {
    registry.register(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn register_new_connection() {
        let registry = ConnectionRegistry::new();
        let conn = make_conn("conn_01");
        ws_subscribe(conn, &registry).unwrap();
        assert_eq!(registry.len().unwrap(), 1);
    }

    #[test]
    fn deregister_on_close() {
        let registry = ConnectionRegistry::new();
        let conn = make_conn("conn_01");
        ws_subscribe(conn, &registry).unwrap();
        registry.unregister("conn_01").unwrap();
        assert_eq!(registry.len().unwrap(), 0);
    }

    #[test]
    fn no_duplicate_subs() {
        let registry = ConnectionRegistry::new();
        let conn = make_conn("conn_01");
        ws_subscribe(conn, &registry).unwrap();
        let dup = make_conn("conn_01");
        let err = ws_subscribe(dup, &registry).unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }
}
