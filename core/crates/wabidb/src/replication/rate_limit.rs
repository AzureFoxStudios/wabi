use std::sync::Mutex;

pub struct ReplicationRateLimit {
    capacity: u64,
    rate_per_second: u64,
    state: Mutex<RateLimitState>,
}

struct RateLimitState {
    tokens: u64,
    last_refill_micros: i64,
}

impl ReplicationRateLimit {
    pub fn new(rate_per_second: u64, burst: u64) -> Self {
        Self {
            capacity: burst,
            rate_per_second,
            state: Mutex::new(RateLimitState {
                tokens: burst,
                last_refill_micros: now_micros(),
            }),
        }
    }

    pub fn try_consume(&self, bytes: u64) -> bool {
        let mut state = self.state.lock().unwrap();
        self.refill_inner(&mut state);

        if bytes > state.tokens {
            return false;
        }

        state.tokens -= bytes;
        true
    }

    pub fn refill_if_needed(&self) {
        let mut state = self.state.lock().unwrap();
        self.refill_inner(&mut state);
    }

    fn refill_inner(&self, state: &mut RateLimitState) {
        let now = now_micros();
        let elapsed = now - state.last_refill_micros;
        if elapsed <= 0 {
            return;
        }

        let tokens_to_add = (elapsed as u64 * self.rate_per_second) / 1_000_000;
        if tokens_to_add > 0 {
            state.tokens = (state.tokens + tokens_to_add).min(self.capacity);
            state.last_refill_micros = now;
        }
    }
}

fn now_micros() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consume_up_to_capacity() {
        let limit = ReplicationRateLimit::new(1000, 5000);
        assert!(limit.try_consume(5000));
        assert!(!limit.try_consume(1));
    }

    #[test]
    fn over_capacity_rejected() {
        let limit = ReplicationRateLimit::new(1000, 100);
        assert!(!limit.try_consume(101));
    }

    #[test]
    fn refill_adds_tokens() {
        let limit = ReplicationRateLimit::new(1_000_000, 1000);

        assert!(limit.try_consume(1000));

        std::thread::sleep(std::time::Duration::from_millis(10));
        limit.refill_if_needed();

        // Should have some tokens back after 10ms at 1M/sec
        let result = limit.try_consume(1);
        assert!(result);
    }

    #[test]
    fn does_not_exceed_capacity() {
        let limit = ReplicationRateLimit::new(1000, 100);
        limit.refill_if_needed();

        // After an hour, should still only have 100 tokens (capacity)
        let mut state = limit.state.lock().unwrap();
        state.last_refill_micros = 0;
        drop(state);

        limit.refill_if_needed();

        let state = limit.state.lock().unwrap();
        assert_eq!(state.tokens, 100);
    }
}
