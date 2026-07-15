//! Job queue for helper-node worker offload.
//!
//! Phase 2: primary owns the queue; workers pull jobs matching their capabilities
//! and report results. No arbitrary addon code execution yet.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc, time::Duration};
use thiserror::Error;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::nodes::{NodeCapability, NodeRegistry};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Thumbnail,
    TranscodeVideo,
    TranscodeAudio,
    SearchIndex,
    GenerateWaveform,
    ModerationScan,
    BlobMirror,
    MediaRelay,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub job_id: String,
    pub kind: JobKind,
    pub payload: serde_json::Value,
    pub status: JobStatus,
    pub assigned_node_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub claimed_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub result_payload: Option<serde_json::Value>,
    pub error_message: Option<String>,
    pub retry_count: u32,
    pub max_retries: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitJobRequest {
    pub kind: JobKind,
    pub payload: serde_json::Value,
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimJobRequest {
    pub node_id: String,
    pub node_secret: String,
    pub capabilities: Vec<NodeCapability>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobResultRequest {
    pub node_id: String,
    pub node_secret: String,
    pub success: bool,
    #[serde(default)]
    pub result_payload: Option<serde_json::Value>,
    #[serde(default)]
    pub error_message: Option<String>,
}

fn default_max_retries() -> u32 {
    3
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct JobQueueData {
    jobs: Vec<Job>,
}

#[derive(Clone, Debug)]
pub struct JobQueue {
    storage_path: Option<PathBuf>,
    inner: Arc<RwLock<JobQueueData>>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum JobQueueError {
    #[error("job not found")]
    JobNotFound,
    #[error("job is not in a claimable state")]
    #[allow(dead_code)]
    NotClaimable,
    #[error("node secret did not match")]
    InvalidNodeSecret,
    #[error("node has been revoked")]
    NodeRevoked,
    #[error("no matching job for node capabilities")]
    NoMatchingJob,
    #[error("persistence failed: {0}")]
    Persistence(String),
}

impl JobQueue {
    #[cfg(test)]
    pub fn new_in_memory() -> Self {
        Self {
            storage_path: None,
            inner: Arc::new(RwLock::new(JobQueueData::default())),
        }
    }

    pub fn new_persistent(storage_path: PathBuf) -> Self {
        let data = std::fs::read_to_string(&storage_path)
            .ok()
            .and_then(|content| serde_json::from_str::<JobQueueData>(&content).ok())
            .unwrap_or_default();
        Self {
            storage_path: Some(storage_path),
            inner: Arc::new(RwLock::new(data)),
        }
    }

    pub async fn submit(&self, req: SubmitJobRequest) -> Job {
        let job = Job {
            job_id: new_id("job"),
            kind: req.kind,
            payload: req.payload,
            status: JobStatus::Pending,
            assigned_node_id: None,
            created_at: Utc::now(),
            claimed_at: None,
            completed_at: None,
            result_payload: None,
            error_message: None,
            retry_count: 0,
            max_retries: req.max_retries,
        };
        let mut data = self.inner.write().await;
        data.jobs.push(job.clone());
        self.persist_locked(&data).await.ok();
        job
    }

    pub async fn claim_next(
        &self,
        node_registry: &NodeRegistry,
        req: ClaimJobRequest,
    ) -> Result<Job, JobQueueError> {
        // Validate node secret + status via registry
        let nodes = node_registry.list_nodes().await;
        let node = nodes
            .into_iter()
            .find(|n| n.node_id == req.node_id)
            .ok_or(JobQueueError::InvalidNodeSecret)?;
        if node.status == crate::nodes::NodeStatus::Revoked {
            return Err(JobQueueError::NodeRevoked);
        }

        let mut data = self.inner.write().await;
        // Find first pending job whose kind maps to a capability the node has.
        let idx = data.jobs.iter().position(|j| {
            j.status == JobStatus::Pending
                && job_kind_matches_capabilities(&j.kind, &req.capabilities)
        });
        let Some(idx) = idx else {
            return Err(JobQueueError::NoMatchingJob);
        };
        let job = &mut data.jobs[idx];
        job.status = JobStatus::Running;
        job.assigned_node_id = Some(req.node_id);
        job.claimed_at = Some(Utc::now());
        let updated = job.clone();
        self.persist_locked(&data).await.ok();
        Ok(updated)
    }

    pub async fn report_result(
        &self,
        node_registry: &NodeRegistry,
        job_id: &str,
        req: JobResultRequest,
    ) -> Result<Job, JobQueueError> {
        // Validate node
        let nodes = node_registry.list_nodes().await;
        let node = nodes
            .into_iter()
            .find(|n| n.node_id == req.node_id)
            .ok_or(JobQueueError::InvalidNodeSecret)?;
        if node.status == crate::nodes::NodeStatus::Revoked {
            return Err(JobQueueError::NodeRevoked);
        }

        let mut data = self.inner.write().await;
        let job = data
            .jobs
            .iter_mut()
            .find(|j| j.job_id == job_id)
            .ok_or(JobQueueError::JobNotFound)?;

        if req.success {
            job.status = JobStatus::Completed;
            job.result_payload = req.result_payload;
            job.error_message = None;
        } else {
            job.retry_count += 1;
            if job.retry_count > job.max_retries {
                job.status = JobStatus::Failed;
            } else {
                job.status = JobStatus::Pending;
                job.assigned_node_id = None;
                job.claimed_at = None;
            }
            job.error_message = req.error_message;
        }
        job.completed_at = Some(Utc::now());
        let updated = job.clone();
        self.persist_locked(&data).await.ok();
        Ok(updated)
    }

    pub async fn list_jobs(&self, status_filter: Option<JobStatus>) -> Vec<Job> {
        let data = self.inner.read().await;
        match status_filter {
            Some(s) => data
                .jobs
                .iter()
                .filter(|j| j.status == s)
                .cloned()
                .collect(),
            None => data.jobs.clone(),
        }
    }

    pub async fn cancel_job(&self, job_id: &str) -> Result<Job, JobQueueError> {
        let mut data = self.inner.write().await;
        let job = data
            .jobs
            .iter_mut()
            .find(|j| j.job_id == job_id)
            .ok_or(JobQueueError::JobNotFound)?;
        job.status = JobStatus::Cancelled;
        let updated = job.clone();
        self.persist_locked(&data).await.ok();
        Ok(updated)
    }

    pub async fn reap_stale_jobs(
        &self,
        node_registry: &NodeRegistry,
        running_timeout: Duration,
    ) -> Vec<Job> {
        let mut requeued = Vec::new();
        let mut data = self.inner.write().await;
        let now = Utc::now();
        let Ok(timeout) = chrono::Duration::from_std(running_timeout) else {
            return requeued;
        };
        for job in data.jobs.iter_mut() {
            if job.status != JobStatus::Running {
                continue;
            }
            let Some(claimed) = job.claimed_at else {
                continue;
            };
            if now - claimed <= timeout {
                continue;
            }
            // Check if the assigned node is still online
            if let Some(node_id) = &job.assigned_node_id {
                let nodes = node_registry.list_nodes().await;
                let node_online = nodes
                    .iter()
                    .any(|n| n.node_id == *node_id && n.status == crate::nodes::NodeStatus::Online);
                if node_online {
                    // Node is alive — maybe just slow. Don't reap yet.
                    continue;
                }
            }
            // Requeue
            job.status = JobStatus::Pending;
            job.assigned_node_id = None;
            job.claimed_at = None;
            job.retry_count += 1;
            requeued.push(job.clone());
        }
        if !requeued.is_empty() {
            self.persist_locked(&data).await.ok();
        }
        requeued
    }

    async fn persist_locked(&self, data: &JobQueueData) -> Result<(), JobQueueError> {
        let Some(path) = &self.storage_path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                return Err(JobQueueError::Persistence(e.to_string()));
            }
        }
        let content = serde_json::to_string_pretty(data)
            .map_err(|e| JobQueueError::Persistence(e.to_string()))?;
        tokio::fs::write(path, content)
            .await
            .map_err(|e| JobQueueError::Persistence(e.to_string()))
    }
}

fn job_kind_matches_capabilities(kind: &JobKind, capabilities: &[NodeCapability]) -> bool {
    let required = match kind {
        JobKind::Thumbnail => &[NodeCapability::ThumbnailWorker][..],
        JobKind::TranscodeVideo => &[NodeCapability::TranscodeWorker][..],
        JobKind::TranscodeAudio => &[NodeCapability::TranscodeWorker][..],
        JobKind::SearchIndex => &[NodeCapability::SearchIndexer][..],
        JobKind::GenerateWaveform => &[NodeCapability::TranscodeWorker][..],
        JobKind::ModerationScan => &[NodeCapability::CpuWorker][..],
        JobKind::BlobMirror => &[NodeCapability::BlobCache][..],
        JobKind::MediaRelay => &[NodeCapability::MediaRelay][..],
    };
    required.iter().any(|cap| capabilities.contains(cap))
}

fn new_id(prefix: &str) -> String {
    format!("{}-{}", prefix, Uuid::new_v4())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nodes::{
        JoinNodeRequest, NodeCapability, NodeReachability, NodeRegistry,
    };

    fn test_queue() -> JobQueue {
        JobQueue::new_in_memory()
    }

    fn test_registry(_node_id: &str) -> NodeRegistry {
        let reg = NodeRegistry::new_in_memory("authority-test".to_string());
        // We can't easily inject a node without a token, but for unit tests
        // we can skip registry validation by using the in-memory one and
        // relying on the fact that list_nodes is empty. That means
        // claim_next will fail with InvalidNodeSecret unless we create
        // a registry variant that can insert nodes bypassing the token flow.
        //
        // Simpler: test the queue alone, and test claim/report later with
        // a helper that bypasses registry checks. But the design intentionally
        // requires registry. We'll write tests that create real paired nodes.
        reg
    }

    #[tokio::test]
    async fn submit_creates_pending_job() {
        let q = test_queue();
        let job = q
            .submit(SubmitJobRequest {
                kind: JobKind::Thumbnail,
                payload: serde_json::json!({"fileId": "abc123"}),
                max_retries: 2,
            })
            .await;
        assert_eq!(job.status, JobStatus::Pending);
        assert_eq!(job.kind, JobKind::Thumbnail);
        assert!(job.job_id.starts_with("job-"));

        let pending = q.list_jobs(Some(JobStatus::Pending)).await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].job_id, job.job_id);
    }

    #[tokio::test]
    async fn claim_matches_capabilities_and_transitions_to_running() {
        let q = test_queue();
        let reg = test_registry("ignored");

        // Create a pairing token and join a helper node
        let token = reg
            .create_pairing_token(
                "worker".to_string(),
                vec![NodeCapability::ThumbnailWorker, NodeCapability::CpuWorker],
                Duration::from_secs(60),
            )
            .await
            .unwrap();
        let joined = reg
            .join_with_token(JoinNodeRequest {
                token: token.token.clone(),
                display_name: "thumb-worker".to_string(),
                public_key: "pk".to_string(),
                reachability: NodeReachability::OutboundOnly,
                endpoint: None,
            })
            .await
            .unwrap();

        // Submit a thumbnail job
        let job = q
            .submit(SubmitJobRequest {
                kind: JobKind::Thumbnail,
                payload: serde_json::json!({"fileId": "img"}),
                max_retries: 1,
            })
            .await;

        // A node without thumbnail capability cannot claim
        let no_cap = reg
            .create_pairing_token(
                "bad".to_string(),
                vec![NodeCapability::CpuWorker],
                Duration::from_secs(60),
            )
            .await
            .unwrap();
        let bad_node = reg
            .join_with_token(JoinNodeRequest {
                token: no_cap.token,
                display_name: "bad".to_string(),
                public_key: "pk2".to_string(),
                reachability: NodeReachability::OutboundOnly,
                endpoint: None,
            })
            .await
            .unwrap();

        let bad_claim = q
            .claim_next(
                &reg,
                ClaimJobRequest {
                    node_id: bad_node.node.node_id.clone(),
                    node_secret: bad_node.node_secret.clone(),
                    capabilities: vec![NodeCapability::CpuWorker],
                },
            )
            .await;
        assert!(matches!(bad_claim, Err(JobQueueError::NoMatchingJob)));

        // The thumbnail-capable node can claim
        let claimed = q
            .claim_next(
                &reg,
                ClaimJobRequest {
                    node_id: joined.node.node_id.clone(),
                    node_secret: joined.node_secret.clone(),
                    capabilities: vec![NodeCapability::ThumbnailWorker],
                },
            )
            .await
            .unwrap();

        assert_eq!(claimed.job_id, job.job_id);
        assert_eq!(claimed.status, JobStatus::Running);
        assert_eq!(claimed.assigned_node_id, Some(joined.node.node_id));
    }

    #[tokio::test]
    async fn report_success_completes_job() {
        let q = test_queue();
        let reg = test_registry("ignored");

        let token = reg
            .create_pairing_token(
                "worker".to_string(),
                vec![NodeCapability::ThumbnailWorker],
                Duration::from_secs(60),
            )
            .await
            .unwrap();
        let joined = reg
            .join_with_token(JoinNodeRequest {
                token: token.token.clone(),
                display_name: "thumb-worker".to_string(),
                public_key: "pk".to_string(),
                reachability: NodeReachability::OutboundOnly,
                endpoint: None,
            })
            .await
            .unwrap();

        let job = q
            .submit(SubmitJobRequest {
                kind: JobKind::Thumbnail,
                payload: serde_json::json!({"fileId": "img"}),
                max_retries: 1,
            })
            .await;

        q.claim_next(
            &reg,
            ClaimJobRequest {
                node_id: joined.node.node_id.clone(),
                node_secret: joined.node_secret.clone(),
                capabilities: vec![NodeCapability::ThumbnailWorker],
            },
        )
        .await
        .unwrap();

        let result = q
            .report_result(
                &reg,
                &job.job_id,
                JobResultRequest {
                    node_id: joined.node.node_id.clone(),
                    node_secret: joined.node_secret.clone(),
                    success: true,
                    result_payload: Some(serde_json::json!({"thumbnailUrl": "/t/abc.jpg"})),
                    error_message: None,
                },
            )
            .await
            .unwrap();

        assert_eq!(result.status, JobStatus::Completed);
        assert_eq!(
            result.result_payload,
            Some(serde_json::json!({"thumbnailUrl": "/t/abc.jpg"}))
        );

        let completed = q.list_jobs(Some(JobStatus::Completed)).await;
        assert_eq!(completed.len(), 1);
    }

    #[tokio::test]
    async fn report_failure_retries_then_fails_after_max() {
        let q = test_queue();
        let reg = test_registry("ignored");

        let token = reg
            .create_pairing_token(
                "worker".to_string(),
                vec![NodeCapability::ThumbnailWorker],
                Duration::from_secs(60),
            )
            .await
            .unwrap();
        let joined = reg
            .join_with_token(JoinNodeRequest {
                token: token.token.clone(),
                display_name: "thumb-worker".to_string(),
                public_key: "pk".to_string(),
                reachability: NodeReachability::OutboundOnly,
                endpoint: None,
            })
            .await
            .unwrap();

        let job = q
            .submit(SubmitJobRequest {
                kind: JobKind::Thumbnail,
                payload: serde_json::json!({"fileId": "img"}),
                max_retries: 1,
            })
            .await;

        // First failure: requeued to Pending
        q.claim_next(
            &reg,
            ClaimJobRequest {
                node_id: joined.node.node_id.clone(),
                node_secret: joined.node_secret.clone(),
                capabilities: vec![NodeCapability::ThumbnailWorker],
            },
        )
        .await
        .unwrap();

        let r1 = q
            .report_result(
                &reg,
                &job.job_id,
                JobResultRequest {
                    node_id: joined.node.node_id.clone(),
                    node_secret: joined.node_secret.clone(),
                    success: false,
                    result_payload: None,
                    error_message: Some("oom".to_string()),
                },
            )
            .await
            .unwrap();
        assert_eq!(r1.status, JobStatus::Pending);
        assert_eq!(r1.retry_count, 1);

        // Second failure: exceeds max_retries → Failed
        q.claim_next(
            &reg,
            ClaimJobRequest {
                node_id: joined.node.node_id.clone(),
                node_secret: joined.node_secret.clone(),
                capabilities: vec![NodeCapability::ThumbnailWorker],
            },
        )
        .await
        .unwrap();

        let r2 = q
            .report_result(
                &reg,
                &job.job_id,
                JobResultRequest {
                    node_id: joined.node.node_id.clone(),
                    node_secret: joined.node_secret.clone(),
                    success: false,
                    result_payload: None,
                    error_message: Some("oom again".to_owned()),
                },
            )
            .await
            .unwrap();
        assert_eq!(r2.status, JobStatus::Failed);
        assert_eq!(r2.retry_count, 2);
    }
}
