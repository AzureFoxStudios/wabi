use std::collections::HashMap;
use std::sync::RwLock;

use crate::error::{Result, WabiError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum PresenceStatus {
    Offline = 0,
    Online = 1,
    Away = 2,
    DoNotDisturb = 3,
}

impl PresenceStatus {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Offline),
            1 => Some(Self::Online),
            2 => Some(Self::Away),
            3 => Some(Self::DoNotDisturb),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PresenceInfo {
    pub user_id: u64,
    pub device_id: String,
    pub last_seen_micros: i64,
    pub status: PresenceStatus,
}

#[derive(Debug, Default)]
pub struct PresenceTracker {
    presences: RwLock<HashMap<(u64, String), PresenceInfo>>,
}

impl PresenceTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update_presence(&self, user_id: u64, device_id: &str, status: PresenceStatus, now_micros: i64) -> Result<()> {
        let mut presences = self.presences.write().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "presence tracker lock poisoned".into(),
        })?;
        presences.insert(
            (user_id, device_id.to_string()),
            PresenceInfo {
                user_id,
                device_id: device_id.to_string(),
                last_seen_micros: now_micros,
                status,
            },
        );
        Ok(())
    }

    pub fn get_presence(&self, user_id: u64, device_id: &str) -> Result<Option<PresenceInfo>> {
        let presences = self.presences.read().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "presence tracker lock poisoned".into(),
        })?;
        Ok(presences.get(&(user_id, device_id.to_string())).cloned())
    }

    pub fn list_online_users(&self) -> Result<Vec<PresenceInfo>> {
        let presences = self.presences.read().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "presence tracker lock poisoned".into(),
        })?;
        Ok(presences
            .values()
            .filter(|p| p.status != PresenceStatus::Offline)
            .cloned()
            .collect())
    }

    pub fn remove_stale(&self, older_than_micros: i64) -> Result<Vec<PresenceInfo>> {
        let mut presences = self.presences.write().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "presence tracker lock poisoned".into(),
        })?;
        let stale: Vec<(u64, String)> = presences
            .iter()
            .filter(|(_, info)| info.last_seen_micros < older_than_micros)
            .map(|(key, _)| key.clone())
            .collect();
        let mut removed = Vec::new();
        for key in &stale {
            if let Some(info) = presences.remove(key) {
                removed.push(info);
            }
        }
        Ok(removed)
    }

    pub fn len(&self) -> Result<usize> {
        let presences = self.presences.read().map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "presence tracker lock poisoned".into(),
        })?;
        Ok(presences.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker() -> PresenceTracker {
        PresenceTracker::new()
    }

    #[test]
    fn update_and_get_presence() {
        let t = tracker();
        t.update_presence(1, "dev_a", PresenceStatus::Online, 1000).unwrap();
        let info = t.get_presence(1, "dev_a").unwrap().expect("should be present");
        assert_eq!(info.user_id, 1);
        assert_eq!(info.device_id, "dev_a");
        assert_eq!(info.status, PresenceStatus::Online);
        assert_eq!(info.last_seen_micros, 1000);
    }

    #[test]
    fn get_nonexistent_presence() {
        let t = tracker();
        assert!(t.get_presence(99, "dev_none").unwrap().is_none());
    }

    #[test]
    fn list_online_users() {
        let t = tracker();
        t.update_presence(1, "dev_a", PresenceStatus::Online, 1000).unwrap();
        t.update_presence(2, "dev_b", PresenceStatus::Away, 2000).unwrap();
        t.update_presence(3, "dev_c", PresenceStatus::Offline, 3000).unwrap();
        t.update_presence(3, "dev_d", PresenceStatus::DoNotDisturb, 4000).unwrap();

        let online = t.list_online_users().unwrap();
        assert_eq!(online.len(), 3);
        for p in &online {
            assert_ne!(p.status, PresenceStatus::Offline);
        }
    }

    #[test]
    fn remove_stale() {
        let t = tracker();
        t.update_presence(1, "dev_a", PresenceStatus::Online, 100).unwrap();
        t.update_presence(2, "dev_b", PresenceStatus::Online, 500).unwrap();
        t.update_presence(3, "dev_c", PresenceStatus::Online, 1000).unwrap();

        let removed = t.remove_stale(400).unwrap();
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].user_id, 1);

        let online = t.list_online_users().unwrap();
        assert_eq!(online.len(), 2);
    }

    #[test]
    fn update_overwrites_existing() {
        let t = tracker();
        t.update_presence(1, "dev_a", PresenceStatus::Online, 100).unwrap();
        t.update_presence(1, "dev_a", PresenceStatus::Away, 200).unwrap();
        let info = t.get_presence(1, "dev_a").unwrap().unwrap();
        assert_eq!(info.status, PresenceStatus::Away);
        assert_eq!(info.last_seen_micros, 200);
    }
}
