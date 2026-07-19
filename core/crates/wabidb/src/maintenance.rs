//! Tick-based maintenance actor for WabiDB.
//!
//! Rules implement [`MaintenanceRule`] and are driven by [`MaintenanceScheduler`]
//! on a default 60s tick (overridable per rule via `tick_interval`).
//!
//! IMPORTANT: never call `ProjectionState::insert` from inside `for_each` /
//! `prefix_scan` closures — those hold the outer `RwLock` read guard and
//! `insert` needs the write guard (deadlock).

use crate::engine::locks::ProjectionState;
use crate::error::Result;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Outcome of a single rule execution.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MaintenanceOutcome {
    pub changed: usize,
    pub notes: Vec<String>,
}

/// A periodic maintenance rule.
pub trait MaintenanceRule: Send + Sync {
    fn name(&self) -> &str;
    fn tick_interval(&self) -> Duration {
        Duration::from_secs(60)
    }
    fn execute(&self, state: &ProjectionState) -> Result<MaintenanceOutcome>;
}

/// Simple in-process scheduler that tracks last-run per rule.
pub struct MaintenanceScheduler {
    rules: Vec<Arc<dyn MaintenanceRule>>,
    last_run: Vec<Option<Instant>>,
}

impl MaintenanceScheduler {
    pub fn new(rules: Vec<Arc<dyn MaintenanceRule>>) -> Self {
        let n = rules.len();
        Self {
            rules,
            last_run: vec![None; n],
        }
    }

    pub fn builtin_defaults() -> Self {
        Self::new(vec![
            Arc::new(RetentionEnforcer::default()),
            Arc::new(KeyRotationReaper {
                max_age: Duration::from_secs(90 * 24 * 3600),
            }),
            Arc::new(ArticleStalenessChecker {
                stale_after: Duration::from_secs(30 * 24 * 3600),
            }),
            Arc::new(ThreadAutoArchiver {
                idle_after: Duration::from_secs(14 * 24 * 3600),
            }),
        ])
    }

    pub fn tick(&mut self, state: &ProjectionState) -> Result<Vec<(String, MaintenanceOutcome)>> {
        let now = Instant::now();
        let mut out = Vec::new();
        for (i, rule) in self.rules.iter().enumerate() {
            let due = match self.last_run[i] {
                None => true,
                Some(t) => now.duration_since(t) >= rule.tick_interval(),
            };
            if !due {
                continue;
            }
            let outcome = rule.execute(state)?;
            self.last_run[i] = Some(now);
            out.push((rule.name().to_string(), outcome));
        }
        Ok(out)
    }

    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }
}

// --- Built-in rules ---------------------------------------------------------

#[derive(Default)]
pub struct RetentionEnforcer;

impl MaintenanceRule for RetentionEnforcer {
    fn name(&self) -> &str {
        "retention_enforcer"
    }

    fn execute(&self, state: &ProjectionState) -> Result<MaintenanceOutcome> {
        let mut notes = Vec::new();
        let now = now_micros();
        let mut due: Vec<(Vec<u8>, i64)> = Vec::new();
        state.for_each("retention_markers", |key, value| {
            if value.len() < 8 {
                return;
            }
            let mut buf = [0u8; 8];
            buf.copy_from_slice(&value[..8]);
            let expire_before = i64::from_le_bytes(buf);
            if expire_before > 0 && expire_before <= now {
                due.push((key.to_vec(), expire_before));
            }
        });
        for (key, expire_before) in &due {
            notes.push(format!(
                "retention due for channel {} before {expire_before}",
                String::from_utf8_lossy(key)
            ));
        }
        Ok(MaintenanceOutcome {
            changed: due.len(),
            notes,
        })
    }
}

pub struct KeyRotationReaper {
    pub max_age: Duration,
}

impl MaintenanceRule for KeyRotationReaper {
    fn name(&self) -> &str {
        "key_rotation_reaper"
    }

    fn execute(&self, state: &ProjectionState) -> Result<MaintenanceOutcome> {
        let mut notes = Vec::new();
        let now = now_micros();
        let max_age_us = self.max_age.as_micros() as i64;
        let mut due_keys: Vec<Vec<u8>> = Vec::new();
        state.for_each("stream_key_meta", |key, value| {
            if value.len() < 8 {
                return;
            }
            let mut buf = [0u8; 8];
            buf.copy_from_slice(&value[..8]);
            let created = i64::from_le_bytes(buf);
            if created > 0 && now.saturating_sub(created) >= max_age_us {
                due_keys.push(key.to_vec());
            }
        });
        let due_val = now.to_le_bytes().to_vec();
        for key in &due_keys {
            state.insert("key_rotation_due", key.clone(), due_val.clone(), 0);
            notes.push(format!(
                "key rotation due for {}",
                String::from_utf8_lossy(key)
            ));
        }
        Ok(MaintenanceOutcome {
            changed: due_keys.len(),
            notes,
        })
    }
}

pub struct ArticleStalenessChecker {
    pub stale_after: Duration,
}

impl MaintenanceRule for ArticleStalenessChecker {
    fn name(&self) -> &str {
        "article_staleness_checker"
    }

    fn execute(&self, state: &ProjectionState) -> Result<MaintenanceOutcome> {
        let mut notes = Vec::new();
        let now = now_micros();
        let threshold = self.stale_after.as_micros() as i64;
        let mut stale_keys: Vec<Vec<u8>> = Vec::new();
        state.for_each("wiki_last_edit", |key, value| {
            if value.len() < 8 {
                return;
            }
            let mut buf = [0u8; 8];
            buf.copy_from_slice(&value[..8]);
            let last = i64::from_le_bytes(buf);
            if now.saturating_sub(last) >= threshold {
                stale_keys.push(key.to_vec());
            }
        });
        for key in &stale_keys {
            state.insert("wiki_staleness", key.clone(), vec![1u8], 0);
            notes.push(format!("wiki stale: {}", String::from_utf8_lossy(key)));
        }
        Ok(MaintenanceOutcome {
            changed: stale_keys.len(),
            notes,
        })
    }
}

pub struct ThreadAutoArchiver {
    pub idle_after: Duration,
}

impl MaintenanceRule for ThreadAutoArchiver {
    fn name(&self) -> &str {
        "thread_auto_archiver"
    }

    fn execute(&self, state: &ProjectionState) -> Result<MaintenanceOutcome> {
        let mut notes = Vec::new();
        let now = now_micros();
        let threshold = self.idle_after.as_micros() as i64;
        // Collect candidate (key, last_activity) pairs inside the iter lock.
        let mut candidates: Vec<(Vec<u8>, i64)> = Vec::new();
        state.for_each("forum_last_activity", |key, value| {
            if value.len() < 8 {
                return;
            }
            let mut buf = [0u8; 8];
            buf.copy_from_slice(&value[..8]);
            let last = i64::from_le_bytes(buf);
            candidates.push((key.to_vec(), last));
        });
        // Check archived status *outside* the iter lock (RwLock read is not
        // re-entrant vs a queued writer — same deadlock family as before).
        let idle: Vec<Vec<u8>> = candidates
            .into_iter()
            .filter(|(key, last)| {
                if state.get("forum_archived_at", key).is_some() {
                    return false;
                }
                now.saturating_sub(*last) >= threshold
            })
            .map(|(key, _)| key)
            .collect();
        let archived_val = now.to_le_bytes().to_vec();
        for key in &idle {
            state.insert(
                "forum_archived_at",
                key.clone(),
                archived_val.clone(),
                0,
            );
            notes.push(format!(
                "forum thread archived: {}",
                String::from_utf8_lossy(key)
            ));
        }
        Ok(MaintenanceOutcome {
            changed: idle.len(),
            notes,
        })
    }
}

fn now_micros() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_scheduler_has_four_rules() {
        let s = MaintenanceScheduler::builtin_defaults();
        assert_eq!(s.rule_count(), 4);
    }

    #[test]
    fn retention_enforcer_counts_due_markers() {
        let state = ProjectionState::new();
        let past = (now_micros() - 1_000_000).to_le_bytes().to_vec();
        state.insert("retention_markers", b"ch_a".to_vec(), past, 1);
        let rule = RetentionEnforcer;
        let out = rule.execute(&state).unwrap();
        assert_eq!(out.changed, 1);
    }

    #[test]
    fn key_rotation_reaper_flags_old_keys() {
        let state = ProjectionState::new();
        let old = (now_micros() - 200i64 * 24 * 3600 * 1_000_000)
            .to_le_bytes()
            .to_vec();
        state.insert("stream_key_meta", b"stream1".to_vec(), old, 1);
        let rule = KeyRotationReaper {
            max_age: Duration::from_secs(90 * 24 * 3600),
        };
        let out = rule.execute(&state).unwrap();
        assert_eq!(out.changed, 1);
        assert!(state.get("key_rotation_due", b"stream1").is_some());
    }

    #[test]
    fn article_staleness_flips_flag() {
        let state = ProjectionState::new();
        let old = (now_micros() - 60i64 * 24 * 3600 * 1_000_000)
            .to_le_bytes()
            .to_vec();
        state.insert("wiki_last_edit", b"page1".to_vec(), old, 1);
        let rule = ArticleStalenessChecker {
            stale_after: Duration::from_secs(30 * 24 * 3600),
        };
        let out = rule.execute(&state).unwrap();
        assert_eq!(out.changed, 1);
        assert_eq!(state.get("wiki_staleness", b"page1").unwrap(), vec![1]);
    }

    #[test]
    fn thread_auto_archiver_sets_archived_at() {
        let state = ProjectionState::new();
        let old = (now_micros() - 30i64 * 24 * 3600 * 1_000_000)
            .to_le_bytes()
            .to_vec();
        state.insert("forum_last_activity", b"thread1".to_vec(), old, 1);
        let rule = ThreadAutoArchiver {
            idle_after: Duration::from_secs(14 * 24 * 3600),
        };
        let out = rule.execute(&state).unwrap();
        assert_eq!(out.changed, 1);
        assert!(state.get("forum_archived_at", b"thread1").is_some());
    }

    #[test]
    fn tick_runs_all_rules_first_pass() {
        let state = ProjectionState::new();
        let mut sched = MaintenanceScheduler::builtin_defaults();
        let results = sched.tick(&state).unwrap();
        assert_eq!(results.len(), 4);
    }
}
