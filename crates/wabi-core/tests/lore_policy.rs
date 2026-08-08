//! Unit tests for Lore policy engine.

use wabi_core::lore::*;

#[test]
fn test_owner_has_all_capabilities() {
    let map = RoleCapabilityMapSet::new();
    let caps = map.capabilities_for_role("owner");
    assert_eq!(caps.len(), LoreCapability::all().len());
    for cap in LoreCapability::all() {
        assert!(caps.contains(cap), "Owner should have {:?}", cap);
    }
}

#[test]
fn test_developer_capabilities() {
    let map = RoleCapabilityMapSet::new();
    let caps = map.capability_set_for_role("developer");
    assert!(caps.contains(LoreCapability::RefPush));
    assert!(caps.contains(LoreCapability::RefMerge));
    assert!(caps.contains(LoreCapability::PathWriteAll));
    assert!(caps.contains(LoreCapability::Lock));
    assert!(caps.contains(LoreCapability::ReviewApprove));
    assert!(!caps.contains(LoreCapability::RefForcePush));
    assert!(!caps.contains(LoreCapability::PolicyEdit));
    assert!(!caps.contains(LoreCapability::EgressPause));
}

#[test]
fn test_artist_capabilities() {
    let map = RoleCapabilityMapSet::new();
    let caps = map.capability_set_for_role("artist");
    assert!(caps.contains(LoreCapability::PathWritePattern));
    assert!(caps.contains(LoreCapability::Lock));
    assert!(!caps.contains(LoreCapability::RefPush));
    assert!(!caps.contains(LoreCapability::RefMerge));
    assert!(!caps.contains(LoreCapability::PathWriteAll));
}

#[test]
fn test_viewer_capabilities() {
    let map = RoleCapabilityMapSet::new();
    let caps = map.capability_set_for_role("viewer");
    assert!(caps.contains(LoreCapability::AuditView));
    assert!(!caps.contains(LoreCapability::RefPush));
    assert!(!caps.contains(LoreCapability::PathWriteAll));
}

#[test]
fn test_unknown_role_has_no_capabilities() {
    let map = RoleCapabilityMapSet::new();
    let caps = map.capabilities_for_role("unknown-role");
    assert!(caps.is_empty());
}

#[test]
fn test_policy_check_owner_can_push() {
    let map = RoleCapabilityMapSet::new();
    let ref_policy = RefPolicySet::new();
    let path_policy = PathPolicySet::new();
    let result = check_policy("owner", &map, &ref_policy, &path_policy, "push", "main", None);
    assert!(matches!(result, PolicyResult::Allow));
}

#[test]
fn test_policy_check_developer_can_push() {
    let map = RoleCapabilityMapSet::new();
    let ref_policy = RefPolicySet::new();
    let path_policy = PathPolicySet::new();
    let result = check_policy("developer", &map, &ref_policy, &path_policy, "push", "feature-x", None);
    assert!(matches!(result, PolicyResult::Allow));
}

#[test]
fn test_policy_check_viewer_cannot_push() {
    let map = RoleCapabilityMapSet::new();
    let ref_policy = RefPolicySet::new();
    let path_policy = PathPolicySet::new();
    let result = check_policy("viewer", &map, &ref_policy, &path_policy, "push", "main", None);
    assert!(matches!(result, PolicyResult::Deny { .. }));
}

#[test]
fn test_policy_check_developer_can_write() {
    let map = RoleCapabilityMapSet::new();
    let ref_policy = RefPolicySet::new();
    let path_policy = PathPolicySet::new();
    let result = check_policy("developer", &map, &ref_policy, &path_policy, "write", "main", Some("src/main.rs"));
    assert!(matches!(result, PolicyResult::Allow));
}

#[test]
fn test_policy_check_viewer_cannot_write() {
    let map = RoleCapabilityMapSet::new();
    let ref_policy = RefPolicySet::new();
    let path_policy = PathPolicySet::new();
    let result = check_policy("viewer", &map, &ref_policy, &path_policy, "write", "main", Some("src/main.rs"));
    assert!(matches!(result, PolicyResult::Deny { .. }));
}

#[test]
fn test_policy_check_read_only_path() {
    let map = RoleCapabilityMapSet::new();
    let ref_policy = RefPolicySet::new();
    let mut path_policy = PathPolicySet::new();
    path_policy.policies.push(PathPolicy {
        path_pattern: "config/**".into(),
        write_roles: vec!["owner".into()],
        require_lock: false,
        read_only: true,
    });
    let result = check_policy("developer", &map, &ref_policy, &path_policy, "write", "main", Some("config/settings.json"));
    assert!(matches!(result, PolicyResult::Deny { reason } => reason.contains("read-only")));
}

#[test]
fn test_policy_check_strict_ref_policy() {
    let map = RoleCapabilityMapSet::new();
    let mut ref_policy = RefPolicySet::new();
    ref_policy.policies.push(RefPolicy::strict());
    let path_policy = PathPolicySet::new();
    // Developer cannot push to main under strict policy (push_capabilities is empty)
    let result = check_policy("developer", &map, &ref_policy, &path_policy, "push", "main", None);
    assert!(matches!(result, PolicyResult::Deny { .. }));
}

#[test]
fn test_ref_policy_matching() {
    let mut ref_policy = RefPolicySet::new();
    ref_policy.policies.push(RefPolicy {
        ref_pattern: "release/*".into(),
        push_capabilities: vec![LoreCapability::RefPush],
        merge_capabilities: vec![],
        required_approvals: Some(2),
        allow_force_push: false,
        allow_delete: false,
        break_glass_roles: vec!["owner".into()],
    });
    let policy = ref_policy.matching_policy("release/v1.0");
    assert_eq!(policy.ref_pattern, "release/*");
    assert_eq!(policy.required_approvals, Some(2));
    // Non-matching branch falls back to default
    let default = ref_policy.matching_policy("feature-x");
    assert_eq!(default, &ref_policy.default_policy);
}

#[test]
fn test_path_policy_matching() {
    let mut path_policy = PathPolicySet::new();
    path_policy.policies.push(PathPolicy {
        path_pattern: "assets/**".into(),
        write_roles: vec!["artist".into(), "developer".into()],
        require_lock: true,
        read_only: false,
    });
    let policy = path_policy.effective_policy("assets/textures/hero.png");
    assert_eq!(policy.path_pattern, "assets/**");
    assert!(policy.require_lock);
    // Non-matching path falls back to default
    let default = path_policy.effective_policy("src/main.rs");
    assert_eq!(default, &path_policy.default_policy);
}

#[test]
fn test_force_push_denied_when_not_allowed() {
    let map = RoleCapabilityMapSet::new();
    let mut ref_policy = RefPolicySet::new();
    ref_policy.default_policy.allow_force_push = false;
    let path_policy = PathPolicySet::new();
    let result = check_policy("owner", &map, &ref_policy, &path_policy, "force_push", "main", None);
    assert!(matches!(result, PolicyResult::Deny { reason } => reason.contains("not allowed")));
}

#[test]
fn test_branch_delete_denied_when_not_allowed() {
    let map = RoleCapabilityMapSet::new();
    let mut ref_policy = RefPolicySet::new();
    ref_policy.default_policy.allow_delete = false;
    let path_policy = PathPolicySet::new();
    let result = check_policy("owner", &map, &ref_policy, &path_policy, "delete_branch", "main", None);
    assert!(matches!(result, PolicyResult::Deny { reason } => reason.contains("not allowed")));
}

#[test]
fn test_capability_set_operations() {
    let mut set1 = LoreCapabilitySet::new();
    set1.insert(LoreCapability::RefPush);
    set1.insert(LoreCapability::Lock);
    let mut set2 = LoreCapabilitySet::new();
    set2.insert(LoreCapability::Lock);
    set2.insert(LoreCapability::ReviewApprove);
    assert!(set1.contains(LoreCapability::RefPush));
    assert!(set1.contains(LoreCapability::Lock));
    assert!(!set1.contains(LoreCapability::ReviewApprove));
    let union = set1.union(&set2);
    assert_eq!(union.len(), 3);
    let intersection = set1.intersection(&set2);
    assert_eq!(intersection.len(), 1);
    assert!(intersection.contains(LoreCapability::Lock));
}

#[test]
fn test_audit_entry_creation() {
    let entry = LoreAuditEntry::new(
        42,
        LoreAuditEventType::PolicyChanged,
        "Updated ref policy for main branch",
        serde_json::json!({ "branch": "main" }),
    );
    assert_eq!(entry.user_id, 42);
    assert_eq!(entry.event_type, LoreAuditEventType::PolicyChanged);
    assert!(entry.timestamp > 0);
}

#[test]
fn test_fetch_quota_defaults() {
    let quota = FetchQuota::default();
    assert_eq!(quota.max_concurrent, 3);
    assert_eq!(quota.daily_bytes, 0); // unlimited
    let dev_quota = FetchQuota::developer();
    assert_eq!(dev_quota.max_concurrent, 5);
    let viewer_quota = FetchQuota::viewer();
    assert_eq!(viewer_quota.max_concurrent, 2);
}

#[test]
fn test_workspace_fetch_ceiling_defaults() {
    let ceiling = WorkspaceFetchCeiling::default();
    assert_eq!(ceiling.max_concurrent, 20);
    assert_eq!(ceiling.daily_bytes, 0);
}

#[test]
fn test_policy_edit_capability() {
    let map = RoleCapabilityMapSet::new();
    let ref_policy = RefPolicySet::new();
    let path_policy = PathPolicySet::new();
    // Owner can edit policy
    assert!(matches!(check_policy("owner", &map, &ref_policy, &path_policy, "policy_edit", "", None), PolicyResult::Allow));
    // Admin can edit policy
    assert!(matches!(check_policy("admin", &map, &ref_policy, &path_policy, "policy_edit", "", None), PolicyResult::Allow));
    // Developer cannot
    assert!(matches!(check_policy("developer", &map, &ref_policy, &path_policy, "policy_edit", "", None), PolicyResult::Deny { .. }));
}

#[test]
fn test_egress_pause_owner_only() {
    let map = RoleCapabilityMapSet::new();
    let ref_policy = RefPolicySet::new();
    let path_policy = PathPolicySet::new();
    // Owner can pause egress
    assert!(matches!(check_policy("owner", &map, &ref_policy, &path_policy, "egress_pause", "", None), PolicyResult::Allow));
    // Admin cannot (by default mapping)
    assert!(matches!(check_policy("admin", &map, &ref_policy, &path_policy, "egress_pause", "", None), PolicyResult::Deny { .. }));
}

#[test]
fn test_case_insensitive_role_lookup() {
    let map = RoleCapabilityMapSet::new();
    let caps_lower = map.capabilities_for_role("developer");
    let caps_upper = map.capabilities_for_role("Developer");
    let caps_mixed = map.capabilities_for_role("DEVELOPER");
    assert_eq!(caps_lower.len(), caps_upper.len());
    assert_eq!(caps_lower.len(), caps_mixed.len());
}