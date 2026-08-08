//! Role → Capability mapping.
//!
//! Bridges Wabi's existing role system and Lore capabilities.

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use super::capability::{LoreCapability, LoreCapabilitySet};

/// Maps a role name to a set of Lore capabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct RoleCapabilityMap {
    /// Role name (e.g., "owner", "admin", "developer", "artist", "viewer")
    pub role: String,
    /// Capabilities granted to this role
    pub capabilities: Vec<LoreCapability>,
}

/// Repository-level role→capability mapping collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct RoleCapabilityMapSet {
    pub mappings: Vec<RoleCapabilityMap>,
}

impl RoleCapabilityMapSet {
    pub fn new() -> Self {
        Self {
            mappings: Self::default_mappings(),
        }
    }

    /// Get all capabilities for a role name.
    pub fn capabilities_for_role(&self, role: &str) -> Vec<LoreCapability> {
        let role_lower = role.to_ascii_lowercase();
        self.mappings
            .iter()
            .find(|m| m.role.to_ascii_lowercase() == role_lower)
            .map(|m| m.capabilities.clone())
            .unwrap_or_default()
    }

    /// Get capabilities as a set for a role name.
    pub fn capability_set_for_role(&self, role: &str) -> LoreCapabilitySet {
        LoreCapabilitySet::from_iter(self.capabilities_for_role(role))
    }

    /// Default role→capability mappings.
    fn default_mappings() -> Vec<RoleCapabilityMap> {
        vec![
            // Owner: everything
            RoleCapabilityMap {
                role: "owner".into(),
                capabilities: LoreCapability::all().to_vec(),
            },
            // Admin: all except EgressPause
            RoleCapabilityMap {
                role: "admin".into(),
                capabilities: vec![
                    LoreCapability::RefPush,
                    LoreCapability::RefMerge,
                    LoreCapability::RefForcePush,
                    LoreCapability::RefDelete,
                    LoreCapability::PathWriteAll,
                    LoreCapability::PathWritePattern,
                    LoreCapability::Lock,
                    LoreCapability::ReviewApprove,
                    LoreCapability::PolicyEdit,
                    LoreCapability::AuditView,
                ],
            },
            // Developer: code write + review
            RoleCapabilityMap {
                role: "developer".into(),
                capabilities: vec![
                    LoreCapability::RefPush,
                    LoreCapability::RefMerge,
                    LoreCapability::PathWriteAll,
                    LoreCapability::Lock,
                    LoreCapability::ReviewApprove,
                    LoreCapability::AuditView,
                ],
            },
            // Artist: asset paths + locks
            RoleCapabilityMap {
                role: "artist".into(),
                capabilities: vec![
                    LoreCapability::PathWritePattern,
                    LoreCapability::Lock,
                    LoreCapability::AuditView,
                ],
            },
            // Viewer: read-only audit
            RoleCapabilityMap {
                role: "viewer".into(),
                capabilities: vec![LoreCapability::AuditView],
            },
        ]
    }
}

impl Default for RoleCapabilityMapSet {
    fn default() -> Self {
        Self::new()
    }
}