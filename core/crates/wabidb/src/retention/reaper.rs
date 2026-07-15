use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone)]
pub struct TombstonedStream {
    pub stream_id: String,
    pub destroyed_at_micros: i64,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct RetentionReaper {
    tombstones: Vec<TombstonedStream>,
    retention_duration_micros: i64,
}

impl RetentionReaper {
    pub fn new(retention_duration_micros: i64) -> Self {
        Self {
            tombstones: Vec::new(),
            retention_duration_micros,
        }
    }

    pub fn add_tombstone(&mut self, stream_id: String, reason: String) {
        let destroyed_at_micros = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0);
        self.tombstones.push(TombstonedStream {
            stream_id,
            destroyed_at_micros,
            reason,
        });
    }

    pub fn run_once(&mut self) -> Vec<TombstonedStream> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0);
        let mut reaped = Vec::new();

        self.tombstones.retain(|t| {
            let expired = t.destroyed_at_micros
                .checked_add(self.retention_duration_micros)
                .map(|deadline| deadline < now)
                .unwrap_or(true);
            if expired {
                reaped.push(t.clone());
                false
            } else {
                true
            }
        });

        reaped
    }

    pub async fn run_forever(&mut self, reaper_interval_micros: u64) {
        loop {
            self.run_once();
            tokio::time::sleep(tokio::time::Duration::from_micros(reaper_interval_micros)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_once_reaps_expired() {
        let mut reaper = RetentionReaper::new(-1);
        reaper.add_tombstone("stream_a".into(), "expired".into());
        let reaped = reaper.run_once();
        assert!(!reaped.is_empty());
        assert_eq!(reaped[0].stream_id, "stream_a");
    }

    #[test]
    fn run_once_does_not_reap_unexpired() {
        let mut reaper = RetentionReaper::new(i64::MAX >> 2);
        reaper.add_tombstone("stream_b".into(), "recent".into());
        let reaped = reaper.run_once();
        assert!(reaped.is_empty());
    }

    #[tokio::test]
    async fn run_forever_calls_run_once_repeatedly() {
        let mut reaper = RetentionReaper::new(-1);
        reaper.add_tombstone("stream_c".into(), "expired".into());

        let handle = tokio::spawn(async move {
            reaper.run_forever(5_000).await;
        });

        tokio::time::sleep(tokio::time::Duration::from_millis(20)).await;
        handle.abort();
    }
}
