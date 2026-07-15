use tokio::sync::broadcast;

#[derive(Debug, Clone)]
pub struct EphemeralEvent {
    pub event_type: String,
    pub payload: Vec<u8>,
}

pub type Subscription = broadcast::Receiver<EphemeralEvent>;

#[derive(Debug, Clone)]
pub struct EphemeralBus {
    tx: broadcast::Sender<EphemeralEvent>,
}

impl EphemeralBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    pub fn publish(&self, event: EphemeralEvent) -> usize {
        self.tx.send(event).unwrap_or(0)
    }

    pub fn subscribe(&self) -> Subscription {
        self.tx.subscribe()
    }

    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publish_to_zero_subscribers_returns_zero() {
        let bus = EphemeralBus::new(16);
        let count = bus.publish(EphemeralEvent {
            event_type: "typing".into(),
            payload: vec![],
        });
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn publish_to_two_subscribers_both_receive() {
        let bus = EphemeralBus::new(16);
        let mut sub1 = bus.subscribe();
        let mut sub2 = bus.subscribe();

        let count = bus.publish(EphemeralEvent {
            event_type: "typing".into(),
            payload: vec![1, 2, 3],
        });
        assert_eq!(count, 2);

        let msg1 = sub1.recv().await.unwrap();
        assert_eq!(msg1.event_type, "typing");
        assert_eq!(msg1.payload, vec![1, 2, 3]);

        let msg2 = sub2.recv().await.unwrap();
        assert_eq!(msg2.event_type, "typing");
        assert_eq!(msg2.payload, vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn drop_receiver_and_publish() {
        let bus = EphemeralBus::new(16);
        let mut sub1 = bus.subscribe();
        let sub2 = bus.subscribe();
        drop(sub2);

        bus.publish(EphemeralEvent {
            event_type: "test".into(),
            payload: vec![],
        });

        assert!(sub1.recv().await.is_ok());
    }
}
