use std::time::{SystemTime, UNIX_EPOCH};

pub struct ReplicaStateMachine {
    pub current_commit_seq: u64,
    pub target_commit_seq: u64,
    pub last_sync_time_micros: i64,
}

impl ReplicaStateMachine {
    pub fn new() -> Self {
        Self {
            current_commit_seq: 0,
            target_commit_seq: 0,
            last_sync_time_micros: 0,
        }
    }

    pub fn advance_to(&mut self, seq: u64) {
        if seq > self.current_commit_seq {
            self.current_commit_seq = seq;
        }
        self.last_sync_time_micros = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0);
    }

    pub fn is_caught_up(&self) -> bool {
        self.current_commit_seq >= self.target_commit_seq
    }

    pub fn get_lag(&self) -> u64 {
        self.target_commit_seq.saturating_sub(self.current_commit_seq)
    }

    pub fn update_target(&mut self, seq: u64) {
        if seq > self.target_commit_seq {
            self.target_commit_seq = seq;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advance_increases_seq() {
        let mut sm = ReplicaStateMachine::new();
        assert_eq!(sm.current_commit_seq, 0);

        sm.advance_to(100);
        assert_eq!(sm.current_commit_seq, 100);
        assert!(sm.last_sync_time_micros > 0);
    }

    #[test]
    fn lag_calculation() {
        let mut sm = ReplicaStateMachine::new();
        sm.update_target(200);
        assert_eq!(sm.get_lag(), 200);

        sm.advance_to(150);
        assert_eq!(sm.get_lag(), 50);

        sm.advance_to(200);
        assert_eq!(sm.get_lag(), 0);
    }

    #[test]
    fn caught_up_detection() {
        let mut sm = ReplicaStateMachine::new();
        sm.update_target(100);
        assert!(!sm.is_caught_up());

        sm.advance_to(100);
        assert!(sm.is_caught_up());
    }

    #[test]
    fn advance_does_not_decrease() {
        let mut sm = ReplicaStateMachine::new();
        sm.advance_to(100);
        sm.advance_to(50);
        assert_eq!(sm.current_commit_seq, 100);
    }
}
