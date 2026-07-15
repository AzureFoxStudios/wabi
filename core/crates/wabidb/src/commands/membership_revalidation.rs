use crate::error::{Result, WabiError};

/// What kind of membership change occurred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    /// The user was added to the channel.
    Added,
    /// The user was removed from the channel.
    Removed,
    /// The user's role in the channel changed.
    RoleChanged,
}

/// Re-validate a user's authorization after a membership change.
///
/// This function checks whether the user is still authorized to access the
/// channel after the given `change_kind`. For `Removed`, the user is always
/// rejected. For `Added` and `RoleChanged`, the user is still authorized
/// (the addition / role change itself does not revoke access).
///
/// The `is_member` callback is provided by the caller to check the actual
/// membership state (e.g., from the `MembershipStore`).
///
/// # Errors
///
/// Returns [`WabiError::Forbidden`] if the user is no longer authorized.
pub fn revalidate_membership_change<F>(
    user_id: u64,
    channel_id: &str,
    change_kind: ChangeKind,
    is_member: F,
) -> Result<()>
where
    F: FnOnce() -> Result<bool>,
{
    match change_kind {
        ChangeKind::Removed => {
            // User was removed — no further check needed; they are definitely
            // unauthorized.
            Err(WabiError::Forbidden {
                user_id,
                command: format!("channel:{channel_id}"),
            })
        }
        ChangeKind::Added | ChangeKind::RoleChanged => {
            // Verify through the membership store that the user is still
            // a member (the change itself should have granted or maintained
            // membership).
            if is_member()? {
                Ok(())
            } else {
                Err(WabiError::Forbidden {
                    user_id,
                    command: format!("channel:{channel_id}"),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member() -> Result<bool> {
        Ok(true)
    }

    fn non_member() -> Result<bool> {
        Ok(false)
    }

    #[test]
    fn added_user_is_validated() {
        let result = revalidate_membership_change(42, "ch_01", ChangeKind::Added, member);
        assert!(result.is_ok(), "added user should be authorized");
    }

    #[test]
    fn removed_user_is_rejected() {
        let result = revalidate_membership_change(42, "ch_01", ChangeKind::Removed, member);
        match result {
            Err(WabiError::Forbidden { user_id, .. }) => {
                assert_eq!(user_id, 42);
            }
            _ => panic!("expected Forbidden, got {result:?}"),
        }
    }

    #[test]
    fn role_changed_user_is_validated() {
        let result =
            revalidate_membership_change(42, "ch_01", ChangeKind::RoleChanged, member);
        assert!(result.is_ok(), "role-changed user should be authorized");
    }

    #[test]
    fn role_changed_user_rejected_if_not_member() {
        let result =
            revalidate_membership_change(42, "ch_01", ChangeKind::RoleChanged, non_member);
        match result {
            Err(WabiError::Forbidden { user_id, .. }) => {
                assert_eq!(user_id, 42);
            }
            _ => panic!("expected Forbidden, got {result:?}"),
        }
    }

    #[test]
    fn added_user_rejected_if_not_member() {
        let result = revalidate_membership_change(42, "ch_01", ChangeKind::Added, non_member);
        match result {
            Err(WabiError::Forbidden { user_id, .. }) => {
                assert_eq!(user_id, 42);
            }
            _ => panic!("expected Forbidden, got {result:?}"),
        }
    }
}
