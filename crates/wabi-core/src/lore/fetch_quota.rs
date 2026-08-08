//! Fetch quotas for Lore blob downloads.

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// Per-user fetch quotas for Lore blobs.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct FetchQuota {
    /// Max concurrent file transfers per user
    #[serde(default = "default_concurrent")]
    pub max_concurrent: u32,
    /// Max bytes per day per user (0 = unlimited)
    #[serde(default)]
    pub daily_bytes: u64,
    /// Max bytes per single export job (0 = unlimited)
    #[serde(default)]
    pub max_export_bytes: u64,
}

fn default_concurrent() -> u32 {
    3
}

impl FetchQuota {
    /// Default generous quota for developers.
    pub fn developer() -> Self {
        Self {
            max_concurrent: 5,
            daily_bytes: 0, // unlimited
            max_export_bytes: 0,
        }
    }

    /// Default restricted quota for viewers.
    pub fn viewer() -> Self {
        Self {
            max_concurrent: 2,
            daily_bytes: 1_073_741_824, // 1 GB/day
            max_export_bytes: 107_374_182, // 100 MB per export
        }
    }
}

impl Default for FetchQuota {
    fn default() -> Self {
        Self {
            max_concurrent: 3,
            daily_bytes: 0,
            max_export_bytes: 0,
        }
    }
}

/// Workspace-level fetch ceiling.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct WorkspaceFetchCeiling {
    /// Total concurrent transfers across all users
    #[serde(default = "default_workspace_concurrent")]
    pub max_concurrent: u32,
    /// Total bytes per day across all users (0 = unlimited)
    #[serde(default)]
    pub daily_bytes: u64,
}

fn default_workspace_concurrent() -> u32 {
    20
}

impl Default for WorkspaceFetchCeiling {
    fn default() -> Self {
        Self {
            max_concurrent: 20,
            daily_bytes: 0,
        }
    }
}