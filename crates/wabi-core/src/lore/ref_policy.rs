//! Ref policy — rules for branches and refs.

use globset::{Glob, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use super::capability::LoreCapability;

/// Policy rules for a specific branch or ref pattern.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct RefPolicy {
    /// Branch name or glob pattern (e.g., "main", "release/*")
    pub ref_pattern: String,
    /// Who can push to this ref (capability names)
    pub push_capabilities: Vec<LoreCapability>,
    /// Who can merge into this ref
    pub merge_capabilities: Vec<LoreCapability>,
    /// Require N approvals before merge (None = no requirement)
    pub required_approvals: Option<u32>,
    /// Allow force push (default false)
    #[serde(default)]
    pub allow_force_push: bool,
    /// Allow branch deletion (default true)
    #[serde(default = "default_true")]
    pub allow_delete: bool,
    /// Break-glass: these roles can override (with audit)
    #[serde(default)]
    pub break_glass_roles: Vec<String>,
}

fn default_true() -> bool {
    true
}

impl RefPolicy {
    /// Default permissive policy (solo mode).
    pub fn permissive() -> Self {
        Self {
            ref_pattern: "*".into(),
            push_capabilities: vec![LoreCapability::RefPush],
            merge_capabilities: vec![LoreCapability::RefMerge],
            required_approvals: None,
            allow_force_push: true,
            allow_delete: true,
            break_glass_roles: vec![],
        }
    }

    /// Default strict policy (team mode).
    pub fn strict() -> Self {
        Self {
            ref_pattern: "main".into(),
            push_capabilities: vec![],
            merge_capabilities: vec![LoreCapability::RefMerge],
            required_approvals: Some(1),
            allow_force_push: false,
            allow_delete: false,
            break_glass_roles: vec!["owner".into(), "admin".into()],
        }
    }
}

/// Repository-level ref policy collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct RefPolicySet {
    pub policies: Vec<RefPolicy>,
    /// Default policy when no pattern matches
    pub default_policy: RefPolicy,
}

impl RefPolicySet {
    pub fn new() -> Self {
        Self {
            policies: vec![],
            default_policy: RefPolicy::permissive(),
        }
    }

    /// Match a branch name against the policy set. Returns the first matching
    /// policy, or the default if nothing matches.
    pub fn matching_policy(&self, branch_name: &str) -> &RefPolicy {
        for policy in &self.policies {
            if Self::glob_matches(&policy.ref_pattern, branch_name) {
                return policy;
            }
        }
        &self.default_policy
    }

    fn glob_matches(pattern: &str, path: &str) -> bool {
        Glob::new(pattern)
            .ok()
            .map(|g| g.compile_matcher().is_match(path))
            .unwrap_or(pattern == path)
    }

    /// Build a compiled GlobSet for efficient matching (cached).
    pub fn build_globset(&self) -> Result<GlobSet, globset::Error> {
        let mut builder = GlobSetBuilder::new();
        for policy in &self.policies {
            builder.add(Glob::new(&policy.ref_pattern)?);
        }
        builder.build()
    }
}

impl Default for RefPolicySet {
    fn default() -> Self {
        Self::new()
    }
}