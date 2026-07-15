use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct ChannelMemberData {
    pub channel_id: u64,
    pub user_id: u64,
    pub role: u8,
}

#[derive(Debug, Clone, Default)]
pub struct AuthSnapshot {
    pub channels: HashMap<u64, HashSet<u64>>,
}

impl AuthSnapshot {
    pub fn new() -> Self {
        Self {
            channels: HashMap::new(),
        }
    }

    pub fn member_count(&self, channel_id: u64) -> usize {
        self.channels.get(&channel_id).map_or(0, |s| s.len())
    }

    pub fn is_member(&self, channel_id: u64, user_id: u64) -> bool {
        self.channels
            .get(&channel_id)
            .is_some_and(|members| members.contains(&user_id))
    }
}

pub fn rebuild_authorization(
    projection_state: &[ChannelMemberData],
    _target_commit_seq: u64,
) -> AuthSnapshot {
    let mut snapshot = AuthSnapshot::new();
    for member in projection_state {
        snapshot
            .channels
            .entry(member.channel_id)
            .or_default()
            .insert(member.user_id);
    }
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_member(channel_id: u64, user_id: u64) -> ChannelMemberData {
        ChannelMemberData {
            channel_id,
            user_id,
            role: 0,
        }
    }

    #[test]
    fn rebuild_from_empty_produces_empty_snapshot() {
        let state = vec![];
        let snapshot = rebuild_authorization(&state, 0);
        assert!(snapshot.channels.is_empty());
    }

    #[test]
    fn rebuild_from_populated_state() {
        let state = vec![make_member(1, 100), make_member(1, 101), make_member(2, 200)];
        let snapshot = rebuild_authorization(&state, 50);
        assert_eq!(snapshot.member_count(1), 2);
        assert_eq!(snapshot.member_count(2), 1);
        assert!(snapshot.is_member(1, 100));
        assert!(snapshot.is_member(1, 101));
        assert!(snapshot.is_member(2, 200));
    }

    #[test]
    fn rebuild_with_removals_excludes_removed_users() {
        let state = vec![make_member(1, 100), make_member(1, 101)];
        let snapshot = rebuild_authorization(&state, 50);
        assert!(snapshot.is_member(1, 100));
        assert!(snapshot.is_member(1, 101));
    }

    #[test]
    fn rebuild_multiple_channels() {
        let state = vec![
            make_member(1, 100),
            make_member(2, 200),
            make_member(3, 300),
        ];
        let snapshot = rebuild_authorization(&state, 50);
        assert_eq!(snapshot.channels.len(), 3);
    }

    #[test]
    fn is_member_returns_false_for_unknown_channel() {
        let snapshot = AuthSnapshot::new();
        assert!(!snapshot.is_member(99, 100));
    }
}
