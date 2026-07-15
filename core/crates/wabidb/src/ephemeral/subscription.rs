use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SubscriptionHandle {
    pub user_id: u64,
    pub topic: String,
    pub id: u64,
}

#[derive(Debug, Clone, Default)]
pub struct SubscriptionRegistry {
    subscriptions: HashMap<(u64, String), Vec<SubscriptionHandle>>,
    next_id: u64,
}

impl SubscriptionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe(&mut self, user_id: u64, topic: String) -> SubscriptionHandle {
        let id = self.next_id;
        self.next_id += 1;
        let handle = SubscriptionHandle {
            user_id,
            topic: topic.clone(),
            id,
        };
        self.subscriptions
            .entry((user_id, topic))
            .or_insert_with(Vec::new)
            .push(handle.clone());
        handle
    }

    pub fn unsubscribe(&mut self, handle: &SubscriptionHandle) -> bool {
        let key = (handle.user_id, handle.topic.clone());
        let mut removed = false;
        if let Some(handles) = self.subscriptions.get_mut(&key) {
            let before = handles.len();
            handles.retain(|h| h.id != handle.id);
            removed = handles.len() < before;
        }
        if removed {
            if let Some(handles) = self.subscriptions.get(&key) {
                if handles.is_empty() {
                    self.subscriptions.remove(&key);
                }
            }
        }
        removed
    }

    pub fn list_for_user(&self, user_id: u64) -> Vec<&SubscriptionHandle> {
        self.subscriptions
            .iter()
            .filter(|((uid, _), _)| *uid == user_id)
            .flat_map(|(_, handles)| handles.iter())
            .collect()
    }

    pub fn len(&self) -> usize {
        self.subscriptions.values().map(|v| v.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subscribe_and_list() {
        let mut reg = SubscriptionRegistry::new();
        let _h1 = reg.subscribe(1, "channel:ch_01".into());
        let _h2 = reg.subscribe(1, "channel:ch_02".into());

        let subs = reg.list_for_user(1);
        assert_eq!(subs.len(), 2);

        let topics: Vec<&str> = subs.iter().map(|s| s.topic.as_str()).collect();
        assert!(topics.contains(&"channel:ch_01"));
        assert!(topics.contains(&"channel:ch_02"));
    }

    #[test]
    fn unsubscribe_removes() {
        let mut reg = SubscriptionRegistry::new();
        let h = reg.subscribe(1, "topic:a".into());
        assert!(!reg.is_empty());

        let removed = reg.unsubscribe(&h);
        assert!(removed);
        assert!(reg.is_empty());
    }

    #[test]
    fn multiple_users_independent() {
        let mut reg = SubscriptionRegistry::new();
        reg.subscribe(1, "topic:x".into());
        reg.subscribe(2, "topic:y".into());

        assert_eq!(reg.list_for_user(1).len(), 1);
        assert_eq!(reg.list_for_user(2).len(), 1);
        assert_eq!(reg.list_for_user(3).len(), 0);
    }

    #[test]
    fn unsubscribe_nonexistent_returns_false() {
        let mut reg = SubscriptionRegistry::new();
        let h = SubscriptionHandle {
            user_id: 99,
            topic: "ghost".into(),
            id: 999,
        };
        assert!(!reg.unsubscribe(&h));
    }
}
