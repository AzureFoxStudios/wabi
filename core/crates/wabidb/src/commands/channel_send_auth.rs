use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Member = 0,
    Moderator = 1,
    Admin = 2,
}

#[derive(Debug, Clone)]
pub struct ChannelMemberChecker {
    members: HashMap<(u64, u64), Role>,
}

impl ChannelMemberChecker {
    pub fn new() -> Self {
        Self {
            members: HashMap::new(),
        }
    }

    pub fn add_member(&mut self, channel_id: u64, user_id: u64, role: Role) {
        self.members.insert((channel_id, user_id), role);
    }

    pub fn remove_member(&mut self, channel_id: u64, user_id: u64) -> bool {
        self.members.remove(&(channel_id, user_id)).is_some()
    }

    pub fn can_send(&self, channel_id: u64, user_id: u64) -> bool {
        self.members.contains_key(&(channel_id, user_id))
    }

    pub fn can_admin(&self, channel_id: u64, user_id: u64) -> bool {
        self.members
            .get(&(channel_id, user_id))
            .is_some_and(|role| *role >= Role::Admin)
    }

    pub fn get_role(&self, channel_id: u64, user_id: u64) -> Option<Role> {
        self.members.get(&(channel_id, user_id)).copied()
    }

    pub fn channel_members(&self, channel_id: u64) -> Vec<u64> {
        self.members
            .iter()
            .filter(|((cid, _), _)| *cid == channel_id)
            .map(|((_, uid), _)| *uid)
            .collect()
    }
}

impl Default for ChannelMemberChecker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_member_allows_send() {
        let mut checker = ChannelMemberChecker::new();
        checker.add_member(1, 100, Role::Member);
        assert!(checker.can_send(1, 100));
    }

    #[test]
    fn remove_member_denies_send() {
        let mut checker = ChannelMemberChecker::new();
        checker.add_member(1, 100, Role::Member);
        assert!(checker.remove_member(1, 100));
        assert!(!checker.can_send(1, 100));
    }

    #[test]
    fn remove_nonexistent_returns_false() {
        let mut checker = ChannelMemberChecker::new();
        assert!(!checker.remove_member(1, 99));
    }

    #[test]
    fn non_member_cannot_send() {
        let checker = ChannelMemberChecker::new();
        assert!(!checker.can_send(1, 100));
    }

    #[test]
    fn member_from_other_channel_denied() {
        let mut checker = ChannelMemberChecker::new();
        checker.add_member(1, 100, Role::Member);
        assert!(!checker.can_send(2, 100));
    }

    #[test]
    fn member_cannot_admin() {
        let mut checker = ChannelMemberChecker::new();
        checker.add_member(1, 100, Role::Member);
        assert!(!checker.can_admin(1, 100));
    }

    #[test]
    fn moderator_cannot_admin() {
        let mut checker = ChannelMemberChecker::new();
        checker.add_member(1, 100, Role::Moderator);
        assert!(!checker.can_admin(1, 100));
    }

    #[test]
    fn admin_can_admin() {
        let mut checker = ChannelMemberChecker::new();
        checker.add_member(1, 100, Role::Admin);
        assert!(checker.can_admin(1, 100));
    }

    #[test]
    fn get_role_returns_correct_role() {
        let mut checker = ChannelMemberChecker::new();
        checker.add_member(1, 100, Role::Admin);
        assert_eq!(checker.get_role(1, 100), Some(Role::Admin));
        assert_eq!(checker.get_role(1, 101), None);
    }

    #[test]
    fn channel_members_returns_all_for_channel() {
        let mut checker = ChannelMemberChecker::new();
        checker.add_member(1, 100, Role::Member);
        checker.add_member(1, 101, Role::Admin);
        checker.add_member(2, 200, Role::Member);
        let members = checker.channel_members(1);
        assert_eq!(members.len(), 2);
        assert!(members.contains(&100));
        assert!(members.contains(&101));
    }
}
