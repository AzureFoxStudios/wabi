use crate::error::{Result, WabiError};
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct DmAuth {
    participants: HashSet<u64>,
}

impl DmAuth {
    pub fn new(participants: Vec<u64>) -> Self {
        Self {
            participants: participants.into_iter().collect(),
        }
    }

    pub fn add_participant(&mut self, user_id: u64) {
        self.participants.insert(user_id);
    }

    pub fn remove_participant(&mut self, user_id: u64) -> bool {
        self.participants.remove(&user_id)
    }

    pub fn is_authorized(&self, user_id: u64) -> Result<()> {
        if self.participants.contains(&user_id) {
            Ok(())
        } else {
            Err(WabiError::Forbidden {
                user_id,
                command: "dm_auth".into(),
            })
        }
    }

    pub fn is_participant(&self, user_id: u64) -> bool {
        self.participants.contains(&user_id)
    }

    pub fn participants(&self) -> impl Iterator<Item = &u64> {
        self.participants.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_creates_participant_set() {
        let auth = DmAuth::new(vec![1, 2, 3]);
        assert!(auth.is_participant(1));
        assert!(auth.is_participant(2));
        assert!(auth.is_participant(3));
        assert!(!auth.is_participant(4));
    }

    #[test]
    fn add_participant_includes_new_user() {
        let mut auth = DmAuth::new(vec![1]);
        auth.add_participant(2);
        assert!(auth.is_participant(2));
    }

    #[test]
    fn add_participant_idempotent() {
        let mut auth = DmAuth::new(vec![1]);
        auth.add_participant(1);
        assert!(auth.is_participant(1));
    }

    #[test]
    fn remove_participant_excludes_user() {
        let mut auth = DmAuth::new(vec![1, 2]);
        assert!(auth.remove_participant(1));
        assert!(!auth.is_participant(1));
        assert!(auth.is_participant(2));
    }

    #[test]
    fn remove_nonexistent_returns_false() {
        let mut auth = DmAuth::new(vec![1]);
        assert!(!auth.remove_participant(99));
    }

    #[test]
    fn is_authorized_returns_ok_for_participant() {
        let auth = DmAuth::new(vec![1, 2]);
        assert!(auth.is_authorized(1).is_ok());
    }

    #[test]
    fn is_authorized_returns_forbidden_for_non_participant() {
        let auth = DmAuth::new(vec![1]);
        let err = auth.is_authorized(99).unwrap_err();
        assert!(matches!(err, WabiError::Forbidden { user_id: 99, .. }));
    }

    #[test]
    fn multiple_participants_all_authorized() {
        let auth = DmAuth::new(vec![10, 20, 30]);
        assert!(auth.is_authorized(10).is_ok());
        assert!(auth.is_authorized(20).is_ok());
        assert!(auth.is_authorized(30).is_ok());
        assert!(auth.is_authorized(40).is_err());
    }

    #[test]
    fn participants_iterator_returns_all() {
        let auth = DmAuth::new(vec![1, 2, 3]);
        let ids: HashSet<&u64> = auth.participants().collect();
        assert!(ids.contains(&1));
        assert!(ids.contains(&2));
        assert!(ids.contains(&3));
    }
}
