//! Path policy — rules for file paths in the repo.

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// Policy rules for file paths in the repo.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct PathPolicy {
    /// Glob pattern for paths (e.g., "assets/**", "src/net/**")
    pub path_pattern: String,
    /// Roles that can write to this path
    pub write_roles: Vec<String>,
    /// Require lock before edit (default false)
    #[serde(default)]
    pub require_lock: bool,
    /// Read-only for all (override write_roles)
    #[serde(default)]
    pub read_only: bool,
}

impl PathPolicy {
    /// Default permissive policy.
    pub fn permissive() -> Self {
        Self {
            path_pattern: "*".into(),
            write_roles: vec!["owner".into(), "admin".into(), "developer".into()],
            require_lock: false,
            read_only: false,
        }
    }
}

/// Repository-level path policy collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct PathPolicySet {
    pub policies: Vec<PathPolicy>,
    /// Default policy when no pattern matches
    pub default_policy: PathPolicy,
}

impl PathPolicySet {
    pub fn new() -> Self {
        Self {
            policies: vec![],
            default_policy: PathPolicy::permissive(),
        }
    }

    /// Find the effective policy for a file path. Returns the first matching
    /// policy, or the default if nothing matches.
    pub fn effective_policy(&self, path: &str) -> &PathPolicy {
        for policy in &self.policies {
            if Self::glob_matches(&policy.path_pattern, path) {
                return policy;
            }
        }
        &self.default_policy
    }

    fn glob_matches(pattern: &str, path: &str) -> bool {
        glob::Pattern::new(pattern)
            .ok()
            .map(|p| p.matches(path))
            .unwrap_or(pattern == path)
    }
}

impl Default for PathPolicySet {
    fn default() -> Self {
        Self::new()
    }
}