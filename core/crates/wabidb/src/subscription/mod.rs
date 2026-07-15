//! subscription module — WebSocket lifecycle, ticket auth, and presence.

pub mod consumer_offsets;
pub mod engine;
pub mod membership_revalidation;
pub mod ws_tickets;
pub mod presence;
pub mod ticket_auth;
pub mod ws_resume;
pub mod ws_send;
pub mod ws_subscribe;
pub mod ws_ticket_endpoint;
pub mod ws_unsubscribe;
