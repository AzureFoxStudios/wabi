use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditReport {
    pub id: String,
    pub server_id: String,
    pub generated_at: DateTime<Utc>,
    pub period_start: DateTime<Utc>,
    pub period_end: DateTime<Utc>,
    pub metrics: AuditMetrics,
    pub violations: Vec<AuditViolation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditMetrics {
    pub total_messages: u64,
    pub total_users: u64,
    pub total_channels: u64,
    pub active_users: u64,
    pub new_users: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditViolation {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    pub severity: ViolationSeverity,
    pub category: String,
    pub description: String,
    pub user_id: Option<String>,
    pub channel_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ViolationSeverity {
    Low,
    Medium,
    High,
    Critical,
}

impl AuditReport {
    pub fn new(
        id: String,
        server_id: String,
        period_start: DateTime<Utc>,
        period_end: DateTime<Utc>,
    ) -> Self {
        Self {
            id,
            server_id,
            generated_at: Utc::now(),
            period_start,
            period_end,
            metrics: AuditMetrics {
                total_messages: 0,
                total_users: 0,
                total_channels: 0,
                active_users: 0,
                new_users: 0,
            },
            violations: Vec::new(),
        }
    }
}

pub mod prelude {
    pub use super::{AuditReport, AuditViolation, AuditMetrics, ViolationSeverity};
}