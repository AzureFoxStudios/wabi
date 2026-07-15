use crate::engine::locks::DispatchItem;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Subscription {
    pub consumer_id: String,
    pub topic_pattern: String,
    pub since_commit_seq: u64,
}

#[derive(Debug)]
pub struct SubscriptionEngine {
    subs: HashMap<String, Vec<Subscription>>,
}

impl SubscriptionEngine {
    pub fn new() -> Self {
        Self {
            subs: HashMap::new(),
        }
    }

    pub fn subscribe(&mut self, consumer_id: &str, topic: &str, since: u64) -> Subscription {
        let sub = Subscription {
            consumer_id: consumer_id.to_string(),
            topic_pattern: topic.to_string(),
            since_commit_seq: since,
        };
        self.subs
            .entry(consumer_id.to_string())
            .or_default()
            .push(sub.clone());
        sub
    }

    pub fn unsubscribe(&mut self, consumer_id: &str, topic: &str) -> bool {
        let mut removed = false;
        if let Some(subs) = self.subs.get_mut(consumer_id) {
            let before = subs.len();
            subs.retain(|s| s.topic_pattern != topic);
            removed = subs.len() < before;
            if subs.is_empty() {
                self.subs.remove(consumer_id);
            }
        }
        removed
    }

    pub fn deliver(&self, topic: &str, item: &DispatchItem) -> Vec<(String, DispatchItem)> {
        let mut result = Vec::new();
        for subs in self.subs.values() {
            for sub in subs {
                if sub.topic_pattern == topic && item.commit_seq > sub.since_commit_seq {
                    result.push((sub.consumer_id.clone(), item.clone()));
                }
            }
        }
        result
    }

    pub fn ack(&mut self, consumer_id: &str, commit_seq: u64) {
        if let Some(subs) = self.subs.get_mut(consumer_id) {
            for sub in subs.iter_mut() {
                if commit_seq > sub.since_commit_seq {
                    sub.since_commit_seq = commit_seq;
                }
            }
        }
    }
}

impl Default for SubscriptionEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_item(seq: u64, event_type: &str) -> DispatchItem {
        DispatchItem {
            commit_seq: seq,
            event_type: event_type.into(),
            stream_id: "sub_test".into(),
            payload: vec![],
        }
    }

    #[test]
    fn subscribe_and_deliver() {
        let mut engine = SubscriptionEngine::new();
        engine.subscribe("alice", "channel:ch_01", 0);

        let results = engine.deliver("channel:ch_01", &make_item(1, "message_created"));
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].0, "alice");
        assert_eq!(results[0].1.commit_seq, 1);
    }

    #[test]
    fn multiple_consumers_same_topic() {
        let mut engine = SubscriptionEngine::new();
        engine.subscribe("alice", "channel:ch_01", 0);
        engine.subscribe("bob", "channel:ch_01", 0);

        let results = engine.deliver("channel:ch_01", &make_item(1, "message_created"));
        assert_eq!(results.len(), 2);
    }

    #[test]
    fn unsubscribe() {
        let mut engine = SubscriptionEngine::new();
        engine.subscribe("alice", "channel:ch_01", 0);
        assert!(engine.unsubscribe("alice", "channel:ch_01"));

        let results = engine.deliver("channel:ch_01", &make_item(1, "message_created"));
        assert!(results.is_empty());
    }

    #[test]
    fn ack_updates_since() {
        let mut engine = SubscriptionEngine::new();
        engine.subscribe("alice", "channel:ch_01", 0);

        // Deliver item at seq 1
        let results = engine.deliver("channel:ch_01", &make_item(1, "message_created"));
        assert_eq!(results.len(), 1);

        // Ack seq 1
        engine.ack("alice", 1);

        // Same item should not be delivered again
        let results = engine.deliver("channel:ch_01", &make_item(1, "message_created"));
        assert!(results.is_empty());

        // Newer item should still be delivered
        let results = engine.deliver("channel:ch_01", &make_item(2, "message_created"));
        assert_eq!(results.len(), 1);
    }

    #[test]
    fn no_subscribers() {
        let engine = SubscriptionEngine::new();
        let results = engine.deliver("channel:ch_01", &make_item(1, "message_created"));
        assert!(results.is_empty());
    }

    #[test]
    fn different_topic_not_delivered() {
        let mut engine = SubscriptionEngine::new();
        engine.subscribe("alice", "channel:ch_01", 0);

        let results = engine.deliver("channel:ch_02", &make_item(1, "message_created"));
        assert!(results.is_empty());
    }
}
