use std::time::{SystemTime, UNIX_EPOCH};

pub struct FailoverCoordinator {
    primary_healthy: bool,
    replica_healthy: bool,
    primary_last_heartbeat_micros: i64,
    replica_last_heartbeat_micros: i64,
    heartbeat_timeout_micros: u64,
    primary_promoted: bool,
}

impl FailoverCoordinator {
    pub fn new(heartbeat_timeout_micros: u64) -> Self {
        Self {
            primary_healthy: true,
            replica_healthy: true,
            primary_last_heartbeat_micros: now_micros(),
            replica_last_heartbeat_micros: now_micros(),
            heartbeat_timeout_micros,
            primary_promoted: false,
        }
    }

    pub fn heartbeat_from_primary(&mut self) {
        self.primary_last_heartbeat_micros = now_micros();
        self.primary_healthy = true;
    }

    pub fn heartbeat_from_replica(&mut self) {
        self.replica_last_heartbeat_micros = now_micros();
        self.replica_healthy = true;
    }

    pub fn check_health(&mut self) -> HealthStatus {
        let now = now_micros();

        let primary_healthy = now - self.primary_last_heartbeat_micros
            < self.heartbeat_timeout_micros as i64;
        let replica_healthy = now - self.replica_last_heartbeat_micros
            < self.heartbeat_timeout_micros as i64;

        self.primary_healthy = primary_healthy;
        self.replica_healthy = replica_healthy;

        if !primary_healthy && !self.primary_promoted {
            self.primary_promoted = true;
            return HealthStatus::Promoted;
        }

        if !primary_healthy {
            return HealthStatus::PrimaryDown;
        }

        if !replica_healthy {
            return HealthStatus::ReplicaDown;
        }

        HealthStatus::Healthy
    }

    pub fn is_primary_healthy(&self) -> bool {
        self.primary_healthy
    }

    pub fn is_replica_healthy(&self) -> bool {
        self.replica_healthy
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum HealthStatus {
    Healthy,
    PrimaryDown,
    ReplicaDown,
    Promoted,
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
    fn healthy_returns_healthy() {
        let mut coord = FailoverCoordinator::new(1_000_000);
        coord.heartbeat_from_primary();
        coord.heartbeat_from_replica();
        assert_eq!(coord.check_health(), HealthStatus::Healthy);
    }

    #[test]
    fn primary_down_triggers_promotion() {
        let mut coord = FailoverCoordinator::new(1);
        coord.heartbeat_from_primary();
        coord.heartbeat_from_replica();
        std::thread::sleep(std::time::Duration::from_millis(2));
        assert_eq!(coord.check_health(), HealthStatus::Promoted);
    }

    #[test]
    fn replica_down_is_no_op_for_primary() {
        let mut coord = FailoverCoordinator::new(1_000_000);
        coord.heartbeat_from_primary();
        coord.heartbeat_from_replica();
        coord.heartbeat_from_primary();
        // Simulate replica timeout
        coord.replica_last_heartbeat_micros = 0;
        assert_eq!(coord.check_health(), HealthStatus::ReplicaDown);
        assert!(coord.is_primary_healthy());
    }
}
