//! Helper-node runtime client.
//!
//! When `wabi-server` is started with `--helper-mode`, it connects outbound to the
//! primary via HTTPS and sends periodic heartbeats instead of listening on a port.
//! This is a client runtime, not an API. It complements the registry in `nodes/mod.rs`.

use crate::jobs::{JobKind, JobResultRequest};
use crate::nodes::{
    JoinNodeRequest, NodeCapability, NodeHeartbeatRequest, NodeLoad, NodeReachability,
};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};
use tracing::{error, info, warn};

/// Saved helper identity across restarts.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelperIdentity {
    node_id: String,
    node_secret: String,
    authority_node_id: String,
    primary_url: String,
    display_name: String,
}

const IDENTITY_FILE: &str = "helper_identity.json";
const HEARTBEAT_INTERVAL_SECS: u64 = 30;
const JOB_POLL_INTERVAL_SECS: u64 = 5;

/// Run helper client loop until cancellation or terminal error.
///
/// Steps:
/// 1. Load existing identity or join with pairing token.
/// 2. Spawn heartbeat loop + job-poll loop concurrently.
/// 3. On terminal errors (revoked, token expired), exit.
pub async fn run_helper(
    primary_url: String,
    pairing_token: Option<String>,
    display_name: String,
    capabilities: Vec<NodeCapability>,
    data_dir: String,
) {
    let identity_path = PathBuf::from(&data_dir).join(IDENTITY_FILE);
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            error!("[helper] Failed to build HTTP client: {}", e);
            return;
        }
    };

    let identity = loop {
        if let Ok(id) = load_identity(&identity_path).await {
            info!("[helper] Loaded existing identity for node {}", id.node_id);
            break id;
        }

        let Some(token) = &pairing_token else {
            error!(
                "[helper] No saved identity and no --pairing-token provided. Cannot join primary."
            );
            return;
        };

        match try_join(&client, &primary_url, token.clone(), &display_name).await {
            Ok(id) => {
                if let Err(e) = save_identity(&identity_path, &id).await {
                    warn!("[helper] Saved identity but failed to persist to disk: {}", e);
                }
                break id;
            }
            Err(e) => {
                error!("[helper] Join failed (will retry in 5s): {}", e);
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    };

    info!(
        "[helper] Connected to primary {}. node_id={}",
        identity.primary_url, identity.node_id
    );

    let client2 = client.clone();
    let id_hb = identity.clone();
    let heartbeat = tokio::spawn(async move {
        heartbeat_loop(client2, id_hb).await;
    });

    let client3 = client.clone();
    let id_jobs = identity.clone();
    let jobs = tokio::spawn(async move {
        job_loop(client3, id_jobs, capabilities).await;
    });

    tokio::select! {
        _ = heartbeat => {
            warn!("[helper] Heartbeat loop exited. Shutting down.");
        }
        _ = jobs => {
            warn!("[helper] Job loop exited. Shutting down.");
        }
    }
}

async fn heartbeat_loop(client: reqwest::Client, identity: HelperIdentity) {
    let mut interval = tokio::time::interval(Duration::from_secs(HEARTBEAT_INTERVAL_SECS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        interval.tick().await;
        let hb = NodeHeartbeatRequest {
            load: gather_load().await,
            reachability: NodeReachability::OutboundOnly,
            endpoint: None,
            capabilities: None,
        };

        let url = format!(
            "{}/api/nodes/{}/heartbeat",
            identity.primary_url, identity.node_id
        );
        match client
            .post(&url)
            .header("x-wabi-node-secret", &identity.node_secret)
            .json(&hb)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                tracing::debug!("[helper] heartbeat accepted");
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                warn!("[helper] heartbeat rejected: {} — {}", status, body);
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    warn!("[helper] Authentication/revocation detected. Exiting.");
                    return;
                }
            }
            Err(e) => {
                warn!("[helper] heartbeat network error: {}", e);
            }
        }
    }
}

async fn job_loop(client: reqwest::Client, identity: HelperIdentity, capabilities: Vec<NodeCapability>) {
    let mut interval = tokio::time::interval(Duration::from_secs(JOB_POLL_INTERVAL_SECS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        interval.tick().await;

        // Claim next job
        let claim_url = format!("{}/api/jobs/claim", identity.primary_url);
        let caps = serde_json::to_value(&capabilities).unwrap_or(serde_json::json!([]));
        let claim_body = serde_json::json!({
            "nodeId": identity.node_id,
            "nodeSecret": identity.node_secret,
            "capabilities": caps,
        });

        let job: serde_json::Value = match client
            .post(&claim_url)
            .json(&claim_body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                match resp.json().await {
                    Ok(j) => j,
                    Err(e) => {
                        warn!("[helper] failed to decode job claim response: {}", e);
                        continue;
                    }
                }
            }
            Ok(resp) if resp.status() == reqwest::StatusCode::NO_CONTENT => {
                // No jobs available — normal
                continue;
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                warn!("[helper] job claim rejected: {} — {}", status, body);
                if status.as_u16() == 401 || status.as_u16() == 403 {
                    warn!("[helper] Authentication/revocation during job claim. Exiting.");
                    return;
                }
                continue;
            }
            Err(e) => {
                warn!("[helper] job claim network error: {}", e);
                continue;
            }
        };

        let job_id = match job["jobId"].as_str() {
            Some(id) => id.to_string(),
            None => {
                warn!("[helper] job claim response missing jobId");
                continue;
            }
        };
        let kind = job["kind"].clone();
        let payload = job["payload"].clone();

        info!("[helper] Claimed job {} (kind: {:?})", job_id, kind);

        // Execute job stub
        let success = execute_job_stub(&kind, &payload, &identity.node_id,
        ).await;

        // Report result
        let result_url = format!(
            "{}/api/jobs/{}/result",
            identity.primary_url, job_id
        );
        let result_body = if success {
            serde_json::json!({
                "nodeId": identity.node_id,
                "nodeSecret": identity.node_secret,
                "success": true,
                "resultPayload": {"done": true},
                "errorMessage": null,
            })
        } else {
            serde_json::json!({
                "nodeId": identity.node_id,
                "nodeSecret": identity.node_secret,
                "success": false,
                "resultPayload": null,
                "errorMessage": "stub execution failed",
            })
        };

        match client
            .post(&result_url)
            .json(&result_body)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                info!("[helper] Job {} result reported successfully", job_id);
            }
            Ok(resp) => {
                warn!(
                    "[helper] Job {} result rejected: {} — {}",
                    job_id,
                    resp.status(),
                    resp.text().await.unwrap_or_default()
                );
            }
            Err(e) => {
                warn!("[helper] Job {} result report network error: {}", job_id, e);
            }
        }
    }
}

async fn execute_job_stub(
    kind: &serde_json::Value,
    _payload: &serde_json::Value,
    node_id: &str,
) -> bool {
    let kind_str = kind.as_str().unwrap_or("unknown");
    match kind_str {
        "thumbnail" => {
            info!("[helper] Executing thumbnail job on {}", node_id);
            // Phase 2 stub: no actual image processing yet
            tokio::time::sleep(Duration::from_millis(500)).await;
            true
        }
        "transcode_video" | "transcode_audio" => {
            info!("[helper] Executing transcode job on {}", node_id);
            tokio::time::sleep(Duration::from_millis(500)).await;
            true
        }
        "search_index" => {
            info!("[helper] Executing search index job on {}", node_id);
            tokio::time::sleep(Duration::from_millis(200)).await;
            true
        }
        "generate_waveform" => {
            info!("[helper] Executing waveform job on {}", node_id);
            tokio::time::sleep(Duration::from_millis(300)).await;
            true
        }
        "moderation_scan" => {
            info!("[helper] Executing moderation scan job on {}", node_id);
            tokio::time::sleep(Duration::from_millis(200)).await;
            true
        }
        _ => {
            warn!("[helper] Unknown job kind: {}", kind_str);
            false
        }
    }
}

async fn try_join(
    client: &reqwest::Client,
    primary_url: &str,
    token: String,
    display_name: &str,
) -> anyhow::Result<HelperIdentity> {
    let url = format!("{}/api/nodes/join", primary_url);
    let req_body = JoinNodeRequest {
        token,
        display_name: display_name.to_string(),
        public_key: new_keypair_placeholder(),
        reachability: NodeReachability::OutboundOnly,
        endpoint: None,
    };

    let resp = client
        .post(&url)
        .json(&req_body)
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("join request failed: {}", e))?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!("join rejected: {}", text));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| anyhow::anyhow!("join response json error: {}", e))?;
    let node = json["node"].clone();
    let node_id = node["nodeId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("join response missing nodeId"))?
        .to_string();
    let node_secret = json["nodeSecret"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("join response missing nodeSecret"))?
        .to_string();
    let authority_node_id = json["authorityNodeId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("join response missing authorityNodeId"))?
        .to_string();

    Ok(HelperIdentity {
        node_id,
        node_secret,
        authority_node_id,
        primary_url: primary_url.to_string(),
        display_name: display_name.to_string(),
    })
}

async fn load_identity(path: &PathBuf) -> anyhow::Result<HelperIdentity> {
    let content = tokio::fs::read_to_string(path).await?;
    let id: HelperIdentity = serde_json::from_str(&content)?;
    Ok(id)
}

async fn save_identity(path: &PathBuf, id: &HelperIdentity) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let content = serde_json::to_string_pretty(id)?;
    tokio::fs::write(path, content).await?;
    Ok(())
}

fn new_keypair_placeholder() -> String {
    // Phase 1: opaque string; real Ed25519 or P-256 keypairs later.
    format!("key-{}", uuid::Uuid::new_v4())
}

async fn gather_load() -> NodeLoad {
    // Phase 1: stub. Later: read /proc/stat, /proc/meminfo, sysinfo crate, etc.
    NodeLoad::default()
}
