use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::atomic::AtomicI64;

pub struct ReplicationMetrics {
    pub lag_micros: AtomicU64,
    pub last_sync_micros: AtomicI64,
    pub total_bytes_synced: AtomicU64,
    pub total_entries_synced: AtomicU64,
}

pub struct ReplicationMetricsSnapshot {
    pub lag_micros: u64,
    pub last_sync_micros: i64,
    pub total_bytes_synced: u64,
    pub total_entries_synced: u64,
}

impl ReplicationMetrics {
    pub fn new() -> Self {
        Self {
            lag_micros: AtomicU64::new(0),
            last_sync_micros: AtomicI64::new(0),
            total_bytes_synced: AtomicU64::new(0),
            total_entries_synced: AtomicU64::new(0),
        }
    }

    pub fn set_lag(&self, lag: u64) {
        self.lag_micros.store(lag, Ordering::Relaxed);
    }

    pub fn set_last_sync(&self, micros: i64) {
        self.last_sync_micros.store(micros, Ordering::Relaxed);
    }

    pub fn add_bytes_synced(&self, bytes: u64) {
        self.total_bytes_synced.fetch_add(bytes, Ordering::Relaxed);
    }

    pub fn add_entries_synced(&self, entries: u64) {
        self.total_entries_synced.fetch_add(entries, Ordering::Relaxed);
    }

    pub fn get_metrics(&self) -> ReplicationMetricsSnapshot {
        ReplicationMetricsSnapshot {
            lag_micros: self.lag_micros.load(Ordering::Relaxed),
            last_sync_micros: self.last_sync_micros.load(Ordering::Relaxed),
            total_bytes_synced: self.total_bytes_synced.load(Ordering::Relaxed),
            total_entries_synced: self.total_entries_synced.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_metrics_are_zero() {
        let metrics = ReplicationMetrics::new();
        let snap = metrics.get_metrics();
        assert_eq!(snap.lag_micros, 0);
        assert_eq!(snap.last_sync_micros, 0);
        assert_eq!(snap.total_bytes_synced, 0);
        assert_eq!(snap.total_entries_synced, 0);
    }

    #[test]
    fn increment_counters() {
        let metrics = ReplicationMetrics::new();

        metrics.set_lag(100);
        metrics.set_last_sync(1234567890);
        metrics.add_bytes_synced(4096);
        metrics.add_entries_synced(50);

        let snap = metrics.get_metrics();
        assert_eq!(snap.lag_micros, 100);
        assert_eq!(snap.last_sync_micros, 1234567890);
        assert_eq!(snap.total_bytes_synced, 4096);
        assert_eq!(snap.total_entries_synced, 50);
    }

    #[test]
    fn multiple_adds_accumulate() {
        let metrics = ReplicationMetrics::new();

        metrics.add_bytes_synced(100);
        metrics.add_bytes_synced(200);
        metrics.add_entries_synced(5);
        metrics.add_entries_synced(10);

        let snap = metrics.get_metrics();
        assert_eq!(snap.total_bytes_synced, 300);
        assert_eq!(snap.total_entries_synced, 15);
    }
}
