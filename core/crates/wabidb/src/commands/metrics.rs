use std::sync::atomic::{AtomicU64, Ordering};

pub struct MetricsCollector {
    events_committed: AtomicU64,
    projections_applied: AtomicU64,
    blobs_written: AtomicU64,
    commands_executed: AtomicU64,
    bytes_written: AtomicU64,
    bytes_read: AtomicU64,
    errors_total: AtomicU64,
}

pub struct MetricsSnapshot {
    pub events_committed: u64,
    pub projections_applied: u64,
    pub blobs_written: u64,
    pub commands_executed: u64,
    pub bytes_written: u64,
    pub bytes_read: u64,
    pub errors_total: u64,
}

impl MetricsCollector {
    pub fn new() -> Self {
        Self {
            events_committed: AtomicU64::new(0),
            projections_applied: AtomicU64::new(0),
            blobs_written: AtomicU64::new(0),
            commands_executed: AtomicU64::new(0),
            bytes_written: AtomicU64::new(0),
            bytes_read: AtomicU64::new(0),
            errors_total: AtomicU64::new(0),
        }
    }

    pub fn increment_event_committed(&self) {
        self.events_committed.fetch_add(1, Ordering::Relaxed);
    }

    pub fn increment_projection_applied(&self) {
        self.projections_applied.fetch_add(1, Ordering::Relaxed);
    }

    pub fn increment_blob_written(&self) {
        self.blobs_written.fetch_add(1, Ordering::Relaxed);
    }

    pub fn increment_command_executed(&self) {
        self.commands_executed.fetch_add(1, Ordering::Relaxed);
    }

    pub fn add_bytes_written(&self, n: u64) {
        self.bytes_written.fetch_add(n, Ordering::Relaxed);
    }

    pub fn add_bytes_read(&self, n: u64) {
        self.bytes_read.fetch_add(n, Ordering::Relaxed);
    }

    pub fn increment_error(&self) {
        self.errors_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn get_snapshot(&self) -> MetricsSnapshot {
        MetricsSnapshot {
            events_committed: self.events_committed.load(Ordering::Relaxed),
            projections_applied: self.projections_applied.load(Ordering::Relaxed),
            blobs_written: self.blobs_written.load(Ordering::Relaxed),
            commands_executed: self.commands_executed.load(Ordering::Relaxed),
            bytes_written: self.bytes_written.load(Ordering::Relaxed),
            bytes_read: self.bytes_read.load(Ordering::Relaxed),
            errors_total: self.errors_total.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_snapshot_is_zero() {
        let collector = MetricsCollector::new();
        let snap = collector.get_snapshot();
        assert_eq!(snap.events_committed, 0);
        assert_eq!(snap.projections_applied, 0);
        assert_eq!(snap.blobs_written, 0);
        assert_eq!(snap.commands_executed, 0);
        assert_eq!(snap.bytes_written, 0);
        assert_eq!(snap.bytes_read, 0);
        assert_eq!(snap.errors_total, 0);
    }

    #[test]
    fn increment_counters() {
        let collector = MetricsCollector::new();

        collector.increment_event_committed();
        collector.increment_projection_applied();
        collector.increment_blob_written();
        collector.increment_command_executed();
        collector.add_bytes_written(100);
        collector.add_bytes_read(50);
        collector.increment_error();

        let snap = collector.get_snapshot();
        assert_eq!(snap.events_committed, 1);
        assert_eq!(snap.projections_applied, 1);
        assert_eq!(snap.blobs_written, 1);
        assert_eq!(snap.commands_executed, 1);
        assert_eq!(snap.bytes_written, 100);
        assert_eq!(snap.bytes_read, 50);
        assert_eq!(snap.errors_total, 1);
    }

    #[test]
    fn multi_event_counts() {
        let collector = MetricsCollector::new();

        for _ in 0..100 {
            collector.increment_event_committed();
        }
        for _ in 0..50 {
            collector.increment_projection_applied();
        }
        collector.add_bytes_written(1024);

        let snap = collector.get_snapshot();
        assert_eq!(snap.events_committed, 100);
        assert_eq!(snap.projections_applied, 50);
        assert_eq!(snap.bytes_written, 1024);
    }
}
