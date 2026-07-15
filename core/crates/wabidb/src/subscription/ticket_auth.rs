use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use crate::error::{Result, WabiError};

#[derive(Debug, Clone)]
pub struct HandshakeRequest {
    pub ticket: String,
    pub device_id: String,
}

#[derive(Debug, Clone)]
pub struct HandshakeResponse {
    pub session_id: String,
    pub user_id: u64,
    pub device_id: String,
    pub expires_at_micros: i64,
}

#[derive(Debug, Clone)]
pub struct TicketEntry {
    user_id: u64,
    device_id: String,
    expires_at_micros: i64,
    used: bool,
}

#[derive(Debug, Default)]
pub struct TicketStore {
    tickets: RwLock<HashMap<String, TicketEntry>>,
    next_session_id: AtomicU64,
    session_ttl_micros: i64,
}

impl TicketStore {
    pub fn new(session_ttl_micros: i64) -> Self {
        Self {
            tickets: RwLock::new(HashMap::new()),
            next_session_id: AtomicU64::new(1),
            session_ttl_micros,
        }
    }

    pub fn issue_ticket(&self, ticket: String, user_id: u64, device_id: String, expires_at_micros: i64) -> Result<()> {
        let mut tickets = self.tickets.write().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "ticket store lock poisoned".into(),
        })?;
        tickets.insert(
            ticket.clone(),
            TicketEntry {
                user_id,
                device_id,
                expires_at_micros,
                used: false,
            },
        );
        Ok(())
    }

    pub fn redeem(&self, ticket: &str) -> Result<TicketEntry> {
        let mut tickets = self.tickets.write().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "ticket store lock poisoned".into(),
        })?;
        let entry = tickets.get_mut(ticket).ok_or_else(|| WabiError::TicketInvalid {
            reason: "unknown ticket",
        })?;
        if entry.used {
            return Err(WabiError::TicketInvalid {
                reason: "ticket already used",
            });
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0);
        if entry.expires_at_micros < now {
            return Err(WabiError::TicketInvalid {
                reason: "ticket expired",
            });
        }
        entry.used = true;
        Ok(entry.clone())
    }
}

pub fn ticket_handshake(
    req: HandshakeRequest,
    store: &TicketStore,
) -> Result<HandshakeResponse> {
    let entry = store.redeem(&req.ticket)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);
    Ok(HandshakeResponse {
        session_id: format!("session_{}", store.next_session_id.fetch_add(1, Ordering::SeqCst)),
        user_id: entry.user_id,
        device_id: entry.device_id,
        expires_at_micros: now + store.session_ttl_micros,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_store() -> TicketStore {
        TicketStore::new(3_600_000_000)
    }

    fn make_req(ticket: &str, device: &str) -> HandshakeRequest {
        HandshakeRequest {
            ticket: ticket.to_string(),
            device_id: device.to_string(),
        }
    }

    #[test]
    fn valid_ticket_returns_session() {
        let store = make_store();
        let far_future = 4_000_000_000_000_000i64;
        store.issue_ticket("tkt_01".into(), 42, "dev_01".into(), far_future).unwrap();

        let resp = ticket_handshake(make_req("tkt_01", "dev_01"), &store).unwrap();
        assert_eq!(resp.user_id, 42);
        assert_eq!(resp.device_id, "dev_01");
        assert!(resp.session_id.starts_with("session_"));
        assert!(resp.expires_at_micros > 0);
    }

    #[test]
    fn invalid_ticket_rejected() {
        let store = make_store();
        let err = ticket_handshake(make_req("no_such_ticket", "dev_01"), &store).unwrap_err();
        assert!(matches!(err, WabiError::TicketInvalid { reason: "unknown ticket" }));
    }

    #[test]
    fn expired_ticket_rejected() {
        let store = make_store();
        store.issue_ticket("tkt_exp".into(), 1, "dev_01".into(), 1).unwrap();
        let err = ticket_handshake(make_req("tkt_exp", "dev_01"), &store).unwrap_err();
        assert!(matches!(err, WabiError::TicketInvalid { reason: "ticket expired" }));
    }

    #[test]
    fn used_ticket_rejected() {
        let store = make_store();
        let far_future = 4_000_000_000_000_000i64;
        store.issue_ticket("tkt_used".into(), 1, "dev_01".into(), far_future).unwrap();
        ticket_handshake(make_req("tkt_used", "dev_01"), &store).unwrap();
        let err = ticket_handshake(make_req("tkt_used", "dev_01"), &store).unwrap_err();
        assert!(matches!(err, WabiError::TicketInvalid { reason: "ticket already used" }));
    }
}
