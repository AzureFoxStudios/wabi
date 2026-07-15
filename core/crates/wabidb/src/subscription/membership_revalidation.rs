use std::sync::RwLock;

use crate::error::{Result, WabiError};

#[derive(Debug, Default)]
pub struct MembershipStore {
    memberships: RwLock<Vec<(u64, String)>>,
}

impl MembershipStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_member(&self, user_id: u64, channel_id: &str) -> Result<()> {
        let mut memberships = self.memberships.write().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "membership store lock poisoned".into(),
        })?;
        memberships.push((user_id, channel_id.to_string()));
        Ok(())
    }

    pub fn remove_member(&self, user_id: u64, channel_id: &str) -> Result<()> {
        let mut memberships = self.memberships.write().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "membership store lock poisoned".into(),
        })?;
        memberships.retain(|(uid, cid)| *uid != user_id || cid != channel_id);
        Ok(())
    }

    pub fn is_member(&self, user_id: u64, channel_id: &str) -> Result<bool> {
        let memberships = self.memberships.read().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "membership store lock poisoned".into(),
        })?;
        Ok(memberships.iter().any(|(uid, cid)| *uid == user_id && cid == channel_id))
    }
}

pub fn revalidate_membership(
    user_id: u64,
    channel_id: &str,
    store: &MembershipStore,
) -> Result<bool> {
    store.is_member(user_id, channel_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_returns_true() {
        let store = MembershipStore::new();
        store.add_member(42, "ch_01").unwrap();
        assert!(revalidate_membership(42, "ch_01", &store).unwrap());
    }

    #[test]
    fn non_member_returns_false() {
        let store = MembershipStore::new();
        assert!(!revalidate_membership(42, "ch_01", &store).unwrap());
    }

    #[test]
    fn removed_member_returns_false() {
        let store = MembershipStore::new();
        store.add_member(42, "ch_01").unwrap();
        store.remove_member(42, "ch_01").unwrap();
        assert!(!revalidate_membership(42, "ch_01", &store).unwrap());
    }

    #[test]
    fn different_channel_not_affected() {
        let store = MembershipStore::new();
        store.add_member(42, "ch_01").unwrap();
        store.remove_member(42, "ch_01").unwrap();
        store.add_member(42, "ch_02").unwrap();
        assert!(!revalidate_membership(42, "ch_01", &store).unwrap());
        assert!(revalidate_membership(42, "ch_02", &store).unwrap());
    }
}
