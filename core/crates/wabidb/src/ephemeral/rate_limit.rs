use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use crate::error::{Result, WabiError};

#[derive(Debug, Clone)]
pub struct EphemeralRateLimiter {
    max_per_second: usize,
    hard_cap: usize,
    user_buckets: HashMap<u64, VecDeque<Instant>>,
}

impl EphemeralRateLimiter {
    pub fn new(max_per_second: usize, hard_cap: usize) -> Self {
        Self {
            max_per_second,
            hard_cap,
            user_buckets: HashMap::new(),
        }
    }

    pub fn check(&mut self, user_id: u64) -> Result<()> {
        let now = Instant::now();
        let bucket = self
            .user_buckets
            .entry(user_id)
            .or_insert_with(VecDeque::new);

        while let Some(&ts) = bucket.front() {
            if now.duration_since(ts) > Duration::from_secs(1) {
                bucket.pop_front();
            } else {
                break;
            }
        }

        if bucket.len() >= self.max_per_second {
            return Err(WabiError::Validation {
                command: "ephemeral_send".into(),
                reason: format!(
                    "ephemeral rate limit exceeded: max {} events/s",
                    self.max_per_second
                ),
            });
        }

        bucket.push_back(now);
        Ok(())
    }

    pub fn check_at_capacity(&self) -> bool {
        let total: usize = self.user_buckets.values().map(|b| b.len()).sum();
        total >= self.hard_cap
    }

    pub fn reset(&mut self, user_id: u64) {
        self.user_buckets.remove(&user_id);
    }
}

impl Default for EphemeralRateLimiter {
    fn default() -> Self {
        Self::new(100, 1000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn under_limit_ok() {
        let mut limiter = EphemeralRateLimiter::new(100, 1000);
        for _ in 0..100 {
            assert!(limiter.check(1).is_ok());
        }
    }

    #[test]
    fn over_limit_rejected() {
        let mut limiter = EphemeralRateLimiter::new(5, 1000);
        for _ in 0..5 {
            limiter.check(1).unwrap();
        }
        let err = limiter.check(1).unwrap_err();
        assert!(matches!(err, WabiError::Validation { .. }));
    }

    #[test]
    fn at_capacity_returns_true() {
        let mut limiter = EphemeralRateLimiter::new(100, 50);
        for uid in 0..10u64 {
            for _ in 0..5 {
                let _ = limiter.check(uid);
            }
        }
        assert!(limiter.check_at_capacity());
    }

    #[test]
    fn different_users_independent() {
        let mut limiter = EphemeralRateLimiter::new(2, 1000);
        limiter.check(1).unwrap();
        limiter.check(1).unwrap();
        assert!(limiter.check(1).is_err());
        assert!(limiter.check(2).is_ok());
    }
}
