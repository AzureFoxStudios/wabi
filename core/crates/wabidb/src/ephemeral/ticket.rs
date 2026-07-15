use std::collections::HashMap;

use crate::error::{Result, WabiError};

#[derive(Debug, Clone)]
pub struct Ticket {
    pub ticket_id: String,
    pub user_id: u64,
    pub created_at_micros: i64,
    pub expires_at_micros: i64,
    pub used: bool,
}

#[derive(Debug, Clone, Default)]
pub struct TicketRegistry {
    tickets: HashMap<String, Ticket>,
}

impl TicketRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(&mut self, user_id: u64, ttl_micros: i64) -> Ticket {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0);
        let ticket_id = format!(
            "tkt_{:016x}{:016x}",
            now as u64,
            rand::random::<u64>()
        );
        let ticket = Ticket {
            ticket_id: ticket_id.clone(),
            user_id,
            created_at_micros: now,
            expires_at_micros: now + ttl_micros,
            used: false,
        };
        self.tickets.insert(ticket_id, ticket.clone());
        ticket
    }

    pub fn validate(&mut self, ticket_id: &str) -> Result<Ticket> {
        let ticket = self
            .tickets
            .get_mut(ticket_id)
            .ok_or_else(|| WabiError::TicketInvalid {
                reason: "not found",
            })?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0);

        if ticket.used {
            return Err(WabiError::TicketInvalid {
                reason: "already used",
            });
        }

        if now > ticket.expires_at_micros {
            return Err(WabiError::TicketInvalid {
                reason: "expired",
            });
        }

        ticket.used = true;
        Ok(ticket.clone())
    }

    pub fn revoke(&mut self, ticket_id: &str) -> Result<()> {
        let ticket = self.tickets.get_mut(ticket_id).ok_or_else(|| {
            WabiError::TicketInvalid {
                reason: "not found",
            }
        })?;
        ticket.used = true;
        Ok(())
    }

    pub fn get(&self, ticket_id: &str) -> Option<&Ticket> {
        self.tickets.get(ticket_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_validate_and_use() {
        let mut reg = TicketRegistry::new();
        let ticket = reg.create(42, 60_000_000);
        assert!(!ticket.used);

        let result = reg.validate(&ticket.ticket_id).unwrap();
        assert_eq!(result.user_id, 42);
    }

    #[test]
    fn expired_ticket_rejected() {
        let mut reg = TicketRegistry::new();
        let ticket = reg.create(1, -1);
        let err = reg.validate(&ticket.ticket_id).unwrap_err();
        assert!(matches!(err, WabiError::TicketInvalid { reason: "expired" }));
    }

    #[test]
    fn revoked_ticket_rejected() {
        let mut reg = TicketRegistry::new();
        let ticket = reg.create(2, 60_000_000);
        reg.revoke(&ticket.ticket_id).unwrap();
        let err = reg.validate(&ticket.ticket_id).unwrap_err();
        assert!(matches!(err, WabiError::TicketInvalid { reason: "already used" }));
    }

    #[test]
    fn used_ticket_rejected_on_second_use() {
        let mut reg = TicketRegistry::new();
        let ticket = reg.create(3, 60_000_000);
        reg.validate(&ticket.ticket_id).unwrap();
        let err = reg.validate(&ticket.ticket_id).unwrap_err();
        assert!(matches!(err, WabiError::TicketInvalid { reason: "already used" }));
    }

    #[test]
    fn nonexistent_ticket_rejected() {
        let mut reg = TicketRegistry::new();
        let err = reg.validate("bogus").unwrap_err();
        assert!(matches!(err, WabiError::TicketInvalid { reason: "not found" }));
    }
}
