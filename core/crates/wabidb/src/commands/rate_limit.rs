use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use crate::error::{Result, WabiError};

#[derive(Debug, Clone)]
pub struct RateLimiter {
    max_ops: usize,
    window: Duration,
    buckets: HashMap<(u64, String), VecDeque<Instant>>,
}

impl RateLimiter {
    pub fn new(max_ops: usize, window_secs: u64) -> Self {
        Self {
            max_ops,
            window: Duration::from_secs(window_secs),
            buckets: HashMap::new(),
        }
    }

    pub fn check(&mut self, user_id: u64, action: &str) -> Result<()> {
        let now = Instant::now();
        let bucket = self
            .buckets
            .entry((user_id, action.to_string()))
            .or_insert_with(VecDeque::new);

        while let Some(&ts) = bucket.front() {
            if now.duration_since(ts) > self.window {
                bucket.pop_front();
            } else {
                break;
            }
        }

        if bucket.len() >= self.max_ops {
            return Err(WabiError::Validation {
                command: action.to_string(),
                reason: format!(
                    "rate limit exceeded: max {} ops per {}s",
                    self.max_ops,
                    self.window.as_secs()
                ),
            });
        }

        bucket.push_back(now);
        Ok(())
    }

    pub fn reset(&mut self, user_id: u64, action: &str) {
        self.buckets.remove(&(user_id, action.to_string()));
    }
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new(60, 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn under_limit_ok() {
        let mut limiter = RateLimiter::new(5, 60);
        for _ in 0..5 {
            assert!(limiter.check(1, "send_message").is_ok());
        }
    }

    #[test]
    fn over_limit_rejected() {
        let mut limiter = RateLimiter::new(3, 60);
        for _ in 0..3 {
            limiter.check(1, "send_message").unwrap();
        }
        let err = limiter.check(1, "send_message").unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }

    #[test]
    fn different_users_independent() {
        let mut limiter = RateLimiter::new(2, 60);
        limiter.check(1, "send_message").unwrap();
        limiter.check(1, "send_message").unwrap();
        assert!(limiter.check(1, "send_message").is_err());
        assert!(limiter.check(2, "send_message").is_ok());
    }

    #[test]
    fn reset_clears() {
        let mut limiter = RateLimiter::new(2, 60);
        limiter.check(1, "send_message").unwrap();
        limiter.check(1, "send_message").unwrap();
        assert!(limiter.check(1, "send_message").is_err());
        limiter.reset(1, "send_message");
        assert!(limiter.check(1, "send_message").is_ok());
    }

    #[test]
    fn window_passes() {
        let mut limiter = RateLimiter::new(5, 1);
        for _ in 0..5 {
            limiter.check(1, "act").unwrap();
        }
        assert!(limiter.check(1, "act").is_err());
        std::thread::sleep(Duration::from_millis(1100));
        assert!(limiter.check(1, "act").is_ok());
    }
}
