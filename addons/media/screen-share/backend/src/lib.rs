use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenShareSession {
    pub id: String,
    pub host_id: String,
    pub viewer_ids: Vec<String>,
    pub status: SessionStatus,
    pub quality: StreamQuality,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Pending,
    Active,
    Paused,
    Ended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamQuality {
    Low,
    Medium,
    High,
    Ultra,
}

impl ScreenShareSession {
    pub fn new(id: String, host_id: String) -> Self {
        Self {
            id,
            host_id,
            viewer_ids: Vec::new(),
            status: SessionStatus::Pending,
            quality: StreamQuality::Medium,
        }
    }
}

pub mod prelude {
    pub use super::{ScreenShareSession, SessionStatus, StreamQuality};
}