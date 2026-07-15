use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{Result, WabiError};
use crate::engine::WabiDbEngine;
use crate::subscription::ticket_auth::TicketStore;

/// Request to issue a WebSocket auth ticket.
#[derive(Debug, Clone)]
pub struct TicketRequest {
    /// The user requesting the ticket.
    pub user_id: u64,
    /// The device the user is connecting from.
    pub device_id: String,
    /// The scope of the ticket (e.g. `"ws"`, `"api"`).
    pub scope: String,
}

/// Response containing the issued ticket.
#[derive(Debug, Clone)]
pub struct TicketResponse {
    /// The one-time use ticket string.
    pub ticket: String,
    /// Absolute microsecond timestamp when the ticket expires.
    pub expires_at_micros: i64,
}

/// Issue a one-time WebSocket auth ticket.
///
/// The ticket is stored in the provided [`TicketStore`] with a default TTL
/// of 15 seconds. The caller must include the ticket in the WebSocket
/// handshake to authenticate.
///
/// # Errors
///
/// Returns [`WabiError::DeviceRevoked`] if the engine's device-revocation
/// state indicates the device is no longer active (the current engine stub
/// always allows — this check is wired when the identity module is complete).
///
/// Returns [`WabiError::Validation`] if the scope is empty.
pub fn ticket_endpoint(
    req: TicketRequest,
    engine: Arc<WabiDbEngine>,
    store: &TicketStore,
) -> Result<TicketResponse> {
    if req.scope.is_empty() {
        return Err(WabiError::Validation {
            command: "ticket_endpoint".into(),
            reason: "scope must not be empty".into(),
        });
    }

    // Revocation check (stub: always passes until the identity module lands).
    let _ = engine;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as i64;

    let ttl_micros = 15_000_000; // 15 seconds
    let expires_at = now + ttl_micros;

    let ticket = format!("tkt_{}_{}_{}", req.user_id, req.device_id, now);

    store
        .issue_ticket(
            ticket.clone(),
            req.user_id,
            req.device_id,
            expires_at,
        )
        .map(|()| TicketResponse {
            ticket,
            expires_at_micros: expires_at,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_engine() -> Arc<WabiDbEngine> {
        Arc::new(WabiDbEngine::new_for_tests())
    }

    fn make_store() -> TicketStore {
        TicketStore::new(3_600_000_000)
    }

    #[test]
    fn valid_request_issues_ticket() {
        let engine = test_engine();
        let store = make_store();
        let req = TicketRequest {
            user_id: 42,
            device_id: "dev_01".into(),
            scope: "ws".into(),
        };

        let resp = ticket_endpoint(req, engine, &store).unwrap();
        assert!(resp.ticket.starts_with("tkt_"));
        assert!(resp.expires_at_micros > 0);
    }

    #[test]
    fn empty_scope_rejected() {
        let engine = test_engine();
        let store = make_store();
        let req = TicketRequest {
            user_id: 1,
            device_id: "dev_01".into(),
            scope: "".into(),
        };

        let err = ticket_endpoint(req, engine, &store).unwrap_err();
        assert!(
            matches!(err, WabiError::Validation { .. }),
            "expected Validation, got {err:?}"
        );
    }

    #[test]
    fn issued_ticket_can_be_redeemed() {
        let engine = test_engine();
        let store = make_store();
        let req = TicketRequest {
            user_id: 7,
            device_id: "dev_02".into(),
            scope: "ws".into(),
        };

        let resp = ticket_endpoint(req, engine, &store).unwrap();

        // Redeem the ticket via the existing ticket_auth machinery.
        use crate::subscription::ticket_auth::{ticket_handshake, HandshakeRequest};
        let hs_req = HandshakeRequest {
            ticket: resp.ticket.clone(),
            device_id: "dev_02".into(),
        };
        let hs_resp = ticket_handshake(hs_req, &store).unwrap();
        assert_eq!(hs_resp.user_id, 7);
    }

    #[test]
    fn expired_ticket_rejected() {
        let store = TicketStore::new(1);
        let _engine = test_engine();

        // Manually issue an already-expired ticket.
        store
            .issue_ticket("tkt_expired".into(), 1, "dev_01".into(), 1)
            .unwrap();

        use crate::subscription::ticket_auth::{ticket_handshake, HandshakeRequest};
        let hs_req = HandshakeRequest {
            ticket: "tkt_expired".into(),
            device_id: "dev_01".into(),
        };
        let err = ticket_handshake(hs_req, &store).unwrap_err();
        assert!(
            matches!(err, WabiError::TicketInvalid { reason: "ticket expired" }),
            "expected expired, got {err:?}"
        );
    }
}
