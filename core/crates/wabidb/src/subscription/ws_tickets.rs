use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::{Result, WabiError};

#[derive(Debug, Clone)]
pub struct WsTicket {
    pub ticket_id: String,
    pub user_id: u64,
    pub device_id: String,
    pub scope: String,
    pub issued_at_micros: i64,
    pub expires_at_micros: i64,
    pub used: bool,
}

#[derive(Debug, Default)]
pub struct WsTicketsTable {
    tickets: Mutex<HashMap<String, WsTicket>>,
}

impl WsTicketsTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn issue(
        &self,
        ticket_id: String,
        user_id: u64,
        device_id: String,
        scope: String,
        ttl_micros: i64,
    ) -> Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as i64;
        let ticket = WsTicket {
            ticket_id: ticket_id.clone(),
            user_id,
            device_id,
            scope,
            issued_at_micros: now,
            expires_at_micros: now + ttl_micros,
            used: false,
        };
        let mut tickets = self.tickets.lock().unwrap();
        tickets.insert(ticket_id, ticket);
        Ok(())
    }

    pub fn get_unused(&self, ticket_id: &str) -> Option<WsTicket> {
        let tickets = self.tickets.lock().unwrap();
        tickets.get(ticket_id).filter(|t| !t.used).cloned()
    }

    pub fn redeem(&self, ticket_id: &str) -> Result<WsTicket> {
        let mut tickets = self.tickets.lock().unwrap();
        let ticket = tickets.get_mut(ticket_id).ok_or_else(|| {
            WabiError::TicketInvalid { reason: "unknown ticket" }
        })?;
        if ticket.used {
            return Err(WabiError::TicketInvalid {
                reason: "ticket already used",
            });
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as i64;
        if ticket.expires_at_micros < now {
            return Err(WabiError::TicketInvalid {
                reason: "ticket expired",
            });
        }
        ticket.used = true;
        Ok(ticket.clone())
    }

    pub fn purge_expired(&self) -> usize {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as i64;
        let mut tickets = self.tickets.lock().unwrap();
        let before = tickets.len();
        tickets.retain(|_, t| t.expires_at_micros > now && !t.used);
        before - tickets.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_table() -> WsTicketsTable {
        WsTicketsTable::new()
    }

    #[test]
    fn issue_and_get_unused() {
        let table = make_table();
        table.issue("tkt_1".into(), 42, "dev_1".into(), "ws".into(), 60_000_000).unwrap();
        let ticket = table.get_unused("tkt_1").unwrap();
        assert_eq!(ticket.user_id, 42);
        assert!(!ticket.used);
    }

    #[test]
    fn redeem_once_succeeds() {
        let table = make_table();
        table.issue("tkt_2".into(), 7, "dev_2".into(), "ws".into(), 60_000_000).unwrap();
        let ticket = table.redeem("tkt_2").unwrap();
        assert_eq!(ticket.user_id, 7);
    }

    #[test]
    fn redeem_twice_fails() {
        let table = make_table();
        table.issue("tkt_3".into(), 1, "dev_3".into(), "ws".into(), 60_000_000).unwrap();
        table.redeem("tkt_3").unwrap();
        let err = table.redeem("tkt_3").unwrap_err();
        assert!(matches!(err, WabiError::TicketInvalid { reason: "ticket already used" }));
    }

    #[test]
    fn unknown_ticket_rejected() {
        let table = make_table();
        let err = table.redeem("no_such").unwrap_err();
        assert!(matches!(err, WabiError::TicketInvalid { reason: "unknown ticket" }));
    }

    #[test]
    fn expired_ticket_rejected() {
        let table = make_table();
        table.issue("tkt_exp".into(), 1, "dev_1".into(), "ws".into(), 1).unwrap();
        std::thread::sleep(std::time::Duration::from_micros(2));
        let err = table.redeem("tkt_exp").unwrap_err();
        assert!(matches!(err, WabiError::TicketInvalid { reason: "ticket expired" }));
    }

    #[test]
    fn purge_expired_removes_stale() {
        let table = make_table();
        table.issue("tkt_keep".into(), 1, "dev_1".into(), "ws".into(), 60_000_000).unwrap();
        table.issue("tkt_gone".into(), 2, "dev_2".into(), "ws".into(), 1).unwrap();
        std::thread::sleep(std::time::Duration::from_micros(2));
        let purged = table.purge_expired();
        assert_eq!(purged, 1);
        assert!(table.get_unused("tkt_keep").is_some());
        assert!(table.get_unused("tkt_gone").is_none());
    }

    #[test]
    fn scope_validation() {
        let table = make_table();
        table.issue("tkt_scoped".into(), 1, "dev_1".into(), "api".into(), 60_000_000).unwrap();
        let ticket = table.get_unused("tkt_scoped").unwrap();
        assert_eq!(ticket.scope, "api");
    }

    #[test]
    fn multiple_users() {
        let table = make_table();
        table.issue("tkt_a".into(), 1, "dev_a".into(), "ws".into(), 60_000_000).unwrap();
        table.issue("tkt_b".into(), 2, "dev_b".into(), "ws".into(), 60_000_000).unwrap();
        let a = table.redeem("tkt_a").unwrap();
        let b = table.redeem("tkt_b").unwrap();
        assert_eq!(a.user_id, 1);
        assert_eq!(b.user_id, 2);
    }
}
