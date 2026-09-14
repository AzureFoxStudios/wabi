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

use crate::nodes::{NodeCapability, NodeRegistry, NodeRegistryError};

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
    /// Exceeded the retry cap — quarantined for admin inspection. Never
    /// returned by `claim_next`; recoverable only via explicit requeue.
    DeadLettered,
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
    /// Retained on the wire for backwards compatibility/diagnostics. The queue
    /// never trusts this list for authorization; registered node capabilities
    /// are authoritative.
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
    #[error("job is not in a claimable state or is owned by another node")]
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
        // Authenticate the actual Authority-issued node credential. Never trust
        // nodeId alone and never grant capabilities merely because the helper
        // included them in the claim request.
        let node = node_registry
            .authenticate_node(&req.node_id, &req.node_secret)
            .await
            .map_err(map_node_auth_error)?;

        let mut data = self.inner.write().await;
        // A job may optionally carry an Authority-selected assignedNodeId in its
        // payload (media routing uses this). Such a job is claimable only by that
        // exact node. Untargeted legacy jobs remain pool-claimable.
        let idx = data.jobs.iter().position(|j| {
            j.status == JobStatus::Pending
                && job_targets_node(j, &node.node_id)
                && job_kind_matches_capabilities(&j.kind, &node.capabilities)
        });
        let Some(idx) = idx else {
            return Err(JobQueueError::NoMatchingJob);
        };
        let job = &mut data.jobs[idx];
        job.status = JobStatus::Running;
        job.assigned_node_id = Some(node.node_id);
        job.claimed_at = Some(Utc::now());
        job.completed_at = None;
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
        node_registry
            .authenticate_node(&req.node_id, &req.node_secret)
            .await
            .map_err(map_node_auth_error)?;

        let mut data = self.inner.write().await;
        let job = data
            .jobs
            .iter_mut()
            .find(|j| j.job_id == job_id)
            .ok_or(JobQueueError::JobNotFound)?;

        // Only the node that successfully claimed the running job may complete
        // or fail it. This stops one paired helper from forging another helper's
        // result, which is especially important when Media Nodes are shared.
        if job.status != JobStatus::Running
            || job.assigned_node_id.as_deref() != Some(req.node_id.as_str())
        {
            return Err(JobQueueError::NotClaimable);
        }

        if req.success {
            job.status = JobStatus::Completed;
            job.result_payload = req.result_payload;
            job.error_message = None;
        } else {
            job.retry_count += 1;
            if job.retry_count > job.max_retries {
                // Retry cap exceeded — quarantine instead of terminal-fail.
                // Dead-letter preserves payload + error for admin inspection.
                job.status = JobStatus::DeadLettered;
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

    /// Admin recovery path: return a dead-lettered job to the claimable pool.
    /// Resets retry_count so the cap applies fresh. Only DeadLettered jobs are
    /// eligible — requeueing a running/completed job would corrupt state.
    pub async fn requeue_job(&self, job_id: &str) -> Result<Job, JobQueueError> {
        let mut data = self.inner.write().await;
        let job = data
            .jobs
            .iter_mut()
            .find(|j| j.job_id == job_id)
            .ok_or(JobQueueError::JobNotFound)?;
        if job.status != JobStatus::DeadLettered {
            return Err(JobQueueError::NotClaimable);
        }
        job.status = JobStatus::Pending;
        job.retry_count = 0;
        job.assigned_node_id = None;
        job.claimed_at = None;
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
            // Requeue — unless the retry cap is exhausted, in which case the
            // job dead-letters instead of looping forever (a vanished node +
            // poison job would otherwise requeue every reap tick forever).
            job.assigned_node_id = None;
            job.claimed_at = None;
            job.retry_count += 1;
            if job.retry_count > job.max_retries {
                job.status = JobStatus::DeadLettered;
            } else {
                job.status = JobStatus::Pending;
            }
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

fn map_node_auth_error(error: NodeRegistryError) -> JobQueueError {
    match error {
        NodeRegistryError::NodeRevoked => JobQueueError::NodeRevoked,
        _ => JobQueueError::InvalidNodeSecret,
    }
}

fn job_targets_node(job: &Job, node_id: &str) -> bool {
    job.payload
        .get("assignedNodeId")
        .and_then(|value| value.as_str())
        .is_none_or(|target| target == node_id)
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
    use crate::nodes::{JoinNodeRequest, NodeCapability, NodeReachability, NodeRegistry};

    fn test_queue() -> JobQueue {
        JobQueue::new_in_memory()
    }

    fn test_registry(_node_id: &str) -> NodeRegistry {
        NodeRegistry::new_in_memory("authority-test".to_string())
    }

    async fn pair_node(
        reg: &NodeRegistry,
        name: &str,
        capabilities: Vec<NodeCapability>,
    ) -> crate::nodes::JoinNodeResponse {
        let token = reg
            .create_pairing_token(name.to_string(), capabilities, Duration::from_secs(60))
            .await
            .unwrap();
        reg.join_with_token(JoinNodeRequest {
            token: token.token,
            display_name: name.to_string(),
            public_key: format!("pk-{name}"),
            reachability: NodeReachability::OutboundOnly,
            endpoint: None,
        })
        .await
        .unwrap()
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
    async fn claim_matches_registered_capabilities_and_transitions_to_running() {
        let q = test_queue();
        let reg = test_registry("ignored");
        let good = pair_node(
            &reg,
            "thumb-worker",
            vec![NodeCapability::ThumbnailWorker, NodeCapability::CpuWorker],
        )
        .await;
        let bad = pair_node(&reg, "bad", vec![NodeCapability::CpuWorker]).await;

        let job = q
            .submit(SubmitJobRequest {
                kind: JobKind::Thumbnail,
                payload: serde_json::json!({"fileId": "img"}),
                max_retries: 1,
            })
            .await;

        // A helper cannot escalate by self-declaring ThumbnailWorker.
        let bad_claim = q
            .claim_next(
                &reg,
                ClaimJobRequest {
                    node_id: bad.node.node_id.clone(),
                    node_secret: bad.node_secret.clone(),
                    capabilities: vec![NodeCapability::ThumbnailWorker],
                },
            )
            .await;
        assert!(matches!(bad_claim, Err(JobQueueError::NoMatchingJob)));

        let claimed = q
            .claim_next(
                &reg,
                ClaimJobRequest {
                    node_id: good.node.node_id.clone(),
                    node_secret: good.node_secret.clone(),
                    capabilities: vec![],
                },
            )
            .await
            .unwrap();

        assert_eq!(claimed.job_id, job.job_id);
        assert_eq!(claimed.status, JobStatus::Running);
        assert_eq!(claimed.assigned_node_id, Some(good.node.node_id));
    }

    #[tokio::test]
    async fn wrong_secret_cannot_claim_job() {
        let q = test_queue();
        let reg = test_registry("ignored");
        let node = pair_node(&reg, "worker", vec![NodeCapability::ThumbnailWorker]).await;
        q.submit(SubmitJobRequest {
            kind: JobKind::Thumbnail,
            payload: serde_json::json!({}),
            max_retries: 1,
        })
        .await;

        let claim = q
            .claim_next(
                &reg,
                ClaimJobRequest {
                    node_id: node.node.node_id,
                    node_secret: "wrong".into(),
                    capabilities: vec![NodeCapability::ThumbnailWorker],
                },
            )
            .await;
        assert_eq!(claim.unwrap_err(), JobQueueError::InvalidNodeSecret);
    }

    #[tokio::test]
    async fn targeted_media_job_can_only_be_claimed_by_selected_node() {
        let q = test_queue();
        let reg = test_registry("ignored");
        let selected = pair_node(&reg, "selected", vec![NodeCapability::MediaRelay]).await;
        let other = pair_node(&reg, "other", vec![NodeCapability::MediaRelay]).await;
        let job = q
            .submit(SubmitJobRequest {
                kind: JobKind::MediaRelay,
                payload: serde_json::json!({"assignedNodeId": selected.node.node_id}),
                max_retries: 1,
            })
            .await;

        let other_claim = q
            .claim_next(
                &reg,
                ClaimJobRequest {
                    node_id: other.node.node_id,
                    node_secret: other.node_secret,
                    capabilities: vec![NodeCapability::MediaRelay],
                },
            )
            .await;
        assert_eq!(other_claim.unwrap_err(), JobQueueError::NoMatchingJob);

        let claimed = q
            .claim_next(
                &reg,
                ClaimJobRequest {
                    node_id: selected.node.node_id.clone(),
                    node_secret: selected.node_secret.clone(),
                    capabilities: vec![],
                },
            )
            .await
            .unwrap();
        assert_eq!(claimed.job_id, job.job_id);
    }

    #[tokio::test]
    async fn report_success_requires_claim_owner_and_secret() {
        let q = test_queue();
        let reg = test_registry("ignored");
        let owner = pair_node(&reg, "owner", vec![NodeCapability::ThumbnailWorker]).await;
        let other = pair_node(&reg, "other", vec![NodeCapability::ThumbnailWorker]).await;
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
                node_id: owner.node.node_id.clone(),
                node_secret: owner.node_secret.clone(),
                capabilities: vec![],
            },
        )
        .await
        .unwrap();

        let forged = q
            .report_result(
                &reg,
                &job.job_id,
                JobResultRequest {
                    node_id: other.node.node_id,
                    node_secret: other.node_secret,
                    success: true,
                    result_payload: None,
                    error_message: None,
                },
            )
            .await;
        assert_eq!(forged.unwrap_err(), JobQueueError::NotClaimable);

        let wrong_secret = q
            .report_result(
                &reg,
                &job.job_id,
                JobResultRequest {
                    node_id: owner.node.node_id.clone(),
                    node_secret: "wrong".into(),
                    success: true,
                    result_payload: None,
                    error_message: None,
                },
            )
            .await;
        assert_eq!(wrong_secret.unwrap_err(), JobQueueError::InvalidNodeSecret);

        let result = q
            .report_result(
                &reg,
                &job.job_id,
                JobResultRequest {
                    node_id: owner.node.node_id,
                    node_secret: owner.node_secret,
                    success: true,
                    result_payload: Some(serde_json::json!({"ok": true})),
                    error_message: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(result.status, JobStatus::Completed);
    }

    #[tokio::test]
    async fn report_failure_retries_then_dead_letters_after_max() {
        let q = test_queue();
        let reg = test_registry("ignored");
        let joined = pair_node(&reg, "worker", vec![NodeCapability::ThumbnailWorker]).await;
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
                capabilities: vec![],
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

        q.claim_next(
            &reg,
            ClaimJobRequest {
                node_id: joined.node.node_id.clone(),
                node_secret: joined.node_secret.clone(),
                capabilities: vec![],
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
        assert_eq!(r2.status, JobStatus::DeadLettered);
        assert_eq!(r2.retry_count, 2);

        let claim = q
            .claim_next(
                &reg,
                ClaimJobRequest {
                    node_id: joined.node.node_id.clone(),
                    node_secret: joined.node_secret.clone(),
                    capabilities: vec![],
                },
            )
            .await;
        assert_eq!(claim.unwrap_err(), JobQueueError::NoMatchingJob);

        let requeued = q.requeue_job(&job.job_id).await.unwrap();
        assert_eq!(requeued.status, JobStatus::Pending);
        assert_eq!(requeued.retry_count, 0);
        let claimed = q
            .claim_next(
                &reg,
                ClaimJobRequest {
                    node_id: joined.node.node_id,
                    node_secret: joined.node_secret,
                    capabilities: vec![],
                },
            )
            .await
            .unwrap();
        assert_eq!(claimed.job_id, job.job_id);

        let wrong = q.requeue_job(&job.job_id).await;
        assert_eq!(wrong.unwrap_err(), JobQueueError::NotClaimable);
    }
}
