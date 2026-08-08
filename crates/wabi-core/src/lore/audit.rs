//! Audit events for Lore workspace operations.

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// Audit event types for Lore workspace operations.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum LoreAuditEventType {
    PolicyChanged,
    EgressPaused,
    EgressResumed,
    BreakGlassUsed,
    TokenRevoked,
    RefPolicyUpdated,
    PathPolicyUpdated,
    RoleCapabilityUpdated,
}

/// Audit log entry for Lore operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct LoreAuditEntry {
    /// Unix epoch milliseconds
    pub timestamp: u64,
    /// User who performed the action
    pub user_id: u64,
    /// Type of event
    pub event_type: LoreAuditEventType,
    /// Human-readable description
    pub description: String,
    /// Structured details (varies by event type)
    #[cfg_attr(feature = "ts", ts(type = "unknown"))]
    pub details: serde_json::Value,
}

impl LoreAuditEntry {
    pub fn new(
        user_id: u64,
        event_type: LoreAuditEventType,
        description: impl Into<String>,
        details: serde_json::Value,
    ) -> Self {
        Self {
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            user_id,
            event_type,
            description: description.into(),
            details,
        }
    }
}