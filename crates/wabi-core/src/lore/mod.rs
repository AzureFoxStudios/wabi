//! Lore workspace: policy engine, citations, review, and templates.
//!
//! Fine-grained policy control for Lore repository operations:
//! ref policy (branch rules), path policy (file rules), role→capability mapping,
//! fetch quotas, audit logging, code citations (`^c/`), lightweight review,
//! and file template scaffolding.

pub mod audit;
pub mod capability;
pub mod citation;
pub mod fetch_quota;
pub mod path_policy;
pub mod ref_policy;
pub mod review;
pub mod role_mapping;
pub mod template;

pub use audit::*;
pub use capability::*;
pub use citation::*;
pub use fetch_quota::*;
pub use path_policy::*;
pub use ref_policy::*;
pub use review::*;
pub use role_mapping::*;
pub use template::*;

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

/// Result of a policy check.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum PolicyResult {
    Allow,
    Deny { reason: String },
}

/// Check if a user with the given role can perform the action on the target.
///
/// Actions: "push", "merge", "force_push", "delete_branch", "write", "lock", "review_approve",
/// "policy_edit", "egress_pause", "audit_view"
pub fn check_policy(
    role: &str,
    capability_map: &RoleCapabilityMapSet,
    ref_policy_set: &RefPolicySet,
    path_policy_set: &PathPolicySet,
    action: &str,
    branch: &str,
    path: Option<&str>,
) -> PolicyResult {
    let caps = capability_map.capability_set_for_role(role);

    // Ref-level actions
    match action {
        "push" => {
            let policy = ref_policy_set.matching_policy(branch);
            if policy.push_capabilities.iter().any(|c| caps.contains(*c)) {
                return PolicyResult::Allow;
            }
            PolicyResult::Deny {
                reason: format!("Role '{}' cannot push to branch '{}'", role, branch),
            }
        }
        "merge" => {
            let policy = ref_policy_set.matching_policy(branch);
            if policy.merge_capabilities.iter().any(|c| caps.contains(*c)) {
                // Check required approvals (caller must verify count; we check capability)
                return PolicyResult::Allow;
            }
            PolicyResult::Deny {
                reason: format!("Role '{}' cannot merge into branch '{}'", role, branch),
            }
        }
        "force_push" => {
            let policy = ref_policy_set.matching_policy(branch);
            if !policy.allow_force_push {
                return PolicyResult::Deny {
                    reason: format!("Force push not allowed on branch '{}'", branch),
                };
            }
            if caps.contains(LoreCapability::RefForcePush) {
                return PolicyResult::Allow;
            }
            PolicyResult::Deny {
                reason: format!("Role '{}' cannot force push to branch '{}'", role, branch),
            }
        }
        "delete_branch" => {
            let policy = ref_policy_set.matching_policy(branch);
            if !policy.allow_delete {
                return PolicyResult::Deny {
                    reason: format!("Branch deletion not allowed on '{}'", branch),
                };
            }
            if caps.contains(LoreCapability::RefDelete) {
                return PolicyResult::Allow;
            }
            PolicyResult::Deny {
                reason: format!("Role '{}' cannot delete branch '{}'", role, branch),
            }
        }
        // Path-level actions
        "write" => {
            if let Some(p) = path {
                let policy = path_policy_set.effective_policy(p);
                if policy.read_only {
                    return PolicyResult::Deny {
                        reason: format!("Path '{}' is read-only", p),
                    };
                }
                if policy.write_roles.iter().any(|r| r.to_ascii_lowercase() == role.to_ascii_lowercase()) {
                    return PolicyResult::Allow;
                }
                if caps.contains(LoreCapability::PathWriteAll) {
                    return PolicyResult::Allow;
                }
                if caps.contains(LoreCapability::PathWritePattern) {
                    // Artist role: check if path matches an asset pattern
                    // For now, allow if they have the capability; path_policy write_roles is the finer gate
                    return PolicyResult::Allow;
                }
                PolicyResult::Deny {
                    reason: format!("Role '{}' cannot write to path '{}'", role, p),
                }
            } else {
                if caps.contains(LoreCapability::PathWriteAll) {
                    return PolicyResult::Allow;
                }
                PolicyResult::Deny {
                    reason: "No path specified for write action".into(),
                }
            }
        }
        "lock" => {
            if caps.contains(LoreCapability::Lock) {
                return PolicyResult::Allow;
            }
            PolicyResult::Deny {
                reason: format!("Role '{}' cannot create locks", role),
            }
        }
        // Capability-level actions
        "review_approve" => {
            if caps.contains(LoreCapability::ReviewApprove) {
                return PolicyResult::Allow;
            }
            PolicyResult::Deny {
                reason: format!("Role '{}' cannot approve reviews", role),
            }
        }
        "policy_edit" => {
            if caps.contains(LoreCapability::PolicyEdit) {
                return PolicyResult::Allow;
            }
            PolicyResult::Deny {
                reason: format!("Role '{}' cannot edit policy", role),
            }
        }
        "egress_pause" => {
            if caps.contains(LoreCapability::EgressPause) {
                return PolicyResult::Allow;
            }
            PolicyResult::Deny {
                reason: format!("Role '{}' cannot pause egress", role),
            }
        }
        "audit_view" => {
            if caps.contains(LoreCapability::AuditView) {
                return PolicyResult::Allow;
            }
            PolicyResult::Deny {
                reason: format!("Role '{}' cannot view audit log", role),
            }
        }
        _ => PolicyResult::Deny {
            reason: format!("Unknown action: {}", action),
        },
    }
}