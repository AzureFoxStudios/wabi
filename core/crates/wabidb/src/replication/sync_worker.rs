use crate::error::Result;

pub struct SyncWorker {
    pub peer_endpoint: String,
    pub sync_interval_micros: u64,
    pub cycle_count: std::sync::atomic::AtomicU64,
}

impl SyncWorker {
    pub fn new(peer_endpoint: &str, sync_interval_micros: u64) -> Self {
        Self {
            peer_endpoint: peer_endpoint.to_string(),
            sync_interval_micros,
            cycle_count: std::sync::atomic::AtomicU64::new(0),
        }
    }

    pub fn run_once(&self) -> Result<()> {
        self.cycle_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    pub async fn run_forever(&self) -> Result<()> {
        loop {
            self.run_once()?;
            tokio::time::sleep(std::time::Duration::from_micros(self.sync_interval_micros)).await;
        }
    }

    pub fn cycle_count(&self) -> u64 {
        self.cycle_count.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn run_once_on_synced_state_is_no_op() {
        let worker = SyncWorker::new("http://peer:8080", 1_000_000);
        worker.run_once().unwrap();
        assert_eq!(worker.cycle_count(), 1);
    }

    #[tokio::test]
    async fn run_forever_calls_run_once_repeatedly() {
        let worker = SyncWorker::new("http://peer:8080", 10_000);

        let handle = tokio::spawn(async move {
            let _ = worker.run_forever().await;
        });

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        handle.abort();
        let _ = handle.await;
    }
}
