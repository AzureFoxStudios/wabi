//! Authentication and session protocol types.
//!
//! These types define the wire protocol for user authentication, session management,
//! and JWT token claims. Shared between frontend, backend, and desktop clients.

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::UserView;

/// JWT token payload structure.
///
/// This is the canonical shape of Wabi's JWT tokens. The backend signs these,
/// and all clients (frontend, desktop, TUI) validate them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct JwtClaims {
    /// Session ID (matches SessionView.id)
    pub session_id: String,
    /// User ID (database primary key)
    pub user_id: Option<i64>,
    /// True if this is a temporary/guest session
    pub is_temporary: bool,
    /// Token expiration timestamp (Unix epoch seconds)
    pub exp: u64,
    /// Issued-at timestamp (Unix epoch seconds)
    pub iat: u64,
}

/// User role in the system.
///
/// Roles are hierarchical: owner > admin > mod > contributor > viewer
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum UserRole {
    Owner,
    Admin,
    Mod,
    Contributor,
    Viewer,
}

impl UserRole {
    /// Returns the role hierarchy level (higher = more permissions)
    pub const fn level(self) -> u8 {
        match self {
            Self::Owner => 5,
            Self::Admin => 4,
            Self::Mod => 3,
            Self::Contributor => 2,
            Self::Viewer => 1,
        }
    }

    /// Check if this role has at least the given level
    pub const fn has_at_least(self, other: Self) -> bool {
        self.level() >= other.level()
    }

    /// Parse role from string (case-insensitive)
    pub fn parse_role(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "owner" => Some(Self::Owner),
            "admin" => Some(Self::Admin),
            "mod" => Some(Self::Mod),
            "contributor" => Some(Self::Contributor),
            "viewer" => Some(Self::Viewer),
            _ => None,
        }
    }
}

/// Authentication command: login with username/email and password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct LoginCommand {
    pub username: String,
    pub password: String,
    /// Optional: request a temporary session (no password stored)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temporary: Option<bool>,
}

/// Authentication command: register a new user account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct RegisterCommand {
    pub username: String,
    pub password: String,
    pub email: Option<String>,
    /// Guest access code (if joining via invite)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guest_code: Option<String>,
}

/// Authentication response: successful login/registration result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct AuthResponse {
    /// JWT token for authenticated session
    pub token: String,
    /// Session information
    pub session: AuthSessionView,
    /// User information
    pub user: UserView,
}

/// Auth session view: represents an authenticated user session with full details.
///
/// This is different from the workspace `SessionView` which is just a session ID reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct AuthSessionView {
    /// Unique session identifier
    pub id: String,
    /// Associated user ID
    pub user_id: i64,
    /// Session creation timestamp (Unix epoch milliseconds)
    pub created_at: u64,
    /// Session expiration timestamp (Unix epoch milliseconds)
    pub expires_at: u64,
    /// True if this is a temporary/guest session
    pub is_temporary: bool,
    /// User agent / client identifier
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    /// IP address of session creator
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ip_address: Option<String>,
    /// True if session has been revoked
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked: Option<bool>,
}

/// Session created event: emitted when a new session is established.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct SessionCreatedEvent {
    pub session: AuthSessionView,
}

/// Session destroyed event: emitted when a session ends (logout, expire, revoke).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct SessionDestroyedEvent {
    pub session_id: String,
    pub reason: SessionEndReason,
}

/// Reason for session termination.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum SessionEndReason {
    Logout,
    Expired,
    Revoked,
    Kicked,
}

/// Guest access code for temporary/join-by-invite flows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct GuestCode {
    /// The code string (user-facing)
    pub code: String,
    /// Workspace/server this code grants access to
    pub workspace_id: String,
    /// Expiration timestamp (Unix epoch milliseconds)
    pub expires_at: u64,
    /// Max uses (None = unlimited)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_uses: Option<u32>,
    /// Current use count
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_count: Option<u32>,
    /// Creator user ID
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_role_hierarchy_is_correct() {
        assert!(UserRole::Owner.has_at_least(UserRole::Admin));
        assert!(UserRole::Admin.has_at_least(UserRole::Mod));
        assert!(UserRole::Mod.has_at_least(UserRole::Contributor));
        assert!(UserRole::Contributor.has_at_least(UserRole::Viewer));

        assert!(!UserRole::Viewer.has_at_least(UserRole::Mod));
        assert!(!UserRole::Mod.has_at_least(UserRole::Admin));
    }

    #[test]
    fn user_role_parsing_is_case_insensitive() {
        assert_eq!(UserRole::parse_role("owner"), Some(UserRole::Owner));
        assert_eq!(UserRole::parse_role("OWNER"), Some(UserRole::Owner));
        assert_eq!(UserRole::parse_role("Owner"), Some(UserRole::Owner));
        assert_eq!(UserRole::parse_role("admin"), Some(UserRole::Admin));
        assert_eq!(UserRole::parse_role("invalid"), None);
    }

    #[test]
    fn session_view_serializes_camelcase() {
        let session = AuthSessionView {
            id: "ses_123".to_owned(),
            user_id: 42,
            created_at: 1000,
            expires_at: 2000,
            is_temporary: false,
            user_agent: Some("Mozilla/5.0".to_owned()),
            ip_address: Some("127.0.0.1".to_owned()),
            revoked: None,
        };

        let json = serde_json::to_value(&session).unwrap();
        assert_eq!(json["id"], "ses_123");
        assert_eq!(json["userId"], 42);
        assert_eq!(json["userAgent"], "Mozilla/5.0");
    }
}
