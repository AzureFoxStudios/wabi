use crate::error::{Result, WabiError};

#[derive(Debug, Clone)]
pub struct OutgoingMessage {
    pub conn_id: String,
    pub payload: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct MessageQueue {
    queue: std::collections::VecDeque<OutgoingMessage>,
    capacity: usize,
}

impl MessageQueue {
    pub fn new(capacity: usize) -> Self {
        Self {
            queue: std::collections::VecDeque::new(),
            capacity,
        }
    }

    pub fn enqueue(&mut self, msg: OutgoingMessage) -> Result<()> {
        if self.queue.len() >= self.capacity {
            return Err(WabiError::Backpressure { timeout_ms: 5000 });
        }
        self.queue.push_back(msg);
        Ok(())
    }

    pub fn dequeue(&mut self) -> Option<OutgoingMessage> {
        self.queue.pop_front()
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }
}

pub fn ws_send(conn_id: &str, msg: OutgoingMessage, queue: &mut MessageQueue) -> Result<()> {
    if msg.conn_id != conn_id {
        return Err(WabiError::Validation {
            command: "ws_send".into(),
            reason: format!("conn_id mismatch: msg has {} but caller specified {}", msg.conn_id, conn_id),
        });
    }
    queue.enqueue(msg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_ok() {
        let mut queue = MessageQueue::new(10);
        let msg = OutgoingMessage {
            conn_id: "conn_01".into(),
            payload: b"hello".to_vec(),
        };
        ws_send("conn_01", msg, &mut queue).unwrap();
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn unknown_conn_errors() {
        let mut queue = MessageQueue::new(10);
        let msg = OutgoingMessage {
            conn_id: "conn_unknown".into(),
            payload: b"test".to_vec(),
        };
        let err = ws_send("conn_different", msg, &mut queue).unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }

    #[test]
    fn queue_full_backpressure() {
        let mut queue = MessageQueue::new(2);
        let msg1 = OutgoingMessage {
            conn_id: "conn_01".into(),
            payload: b"msg1".to_vec(),
        };
        let msg2 = OutgoingMessage {
            conn_id: "conn_01".into(),
            payload: b"msg2".to_vec(),
        };
        let msg3 = OutgoingMessage {
            conn_id: "conn_01".into(),
            payload: b"msg3".to_vec(),
        };
        ws_send("conn_01", msg1, &mut queue).unwrap();
        ws_send("conn_01", msg2, &mut queue).unwrap();
        let err = ws_send("conn_01", msg3, &mut queue).unwrap_err();
        assert!(matches!(err, WabiError::Backpressure { .. }));
    }

    #[test]
    fn dequeue_returns_in_order() {
        let mut queue = MessageQueue::new(10);
        ws_send("conn_01", OutgoingMessage { conn_id: "conn_01".into(), payload: b"a".to_vec() }, &mut queue).unwrap();
        ws_send("conn_01", OutgoingMessage { conn_id: "conn_01".into(), payload: b"b".to_vec() }, &mut queue).unwrap();
        assert_eq!(queue.dequeue().unwrap().payload, b"a");
        assert_eq!(queue.dequeue().unwrap().payload, b"b");
        assert!(queue.dequeue().is_none());
    }
}
