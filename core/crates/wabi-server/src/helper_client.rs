//! Helper-node runtime client.
//!
//! When `wabi-server` is started with `--helper-mode`, it connects outbound to the
//! primary via HTTPS and sends periodic heartbeats instead of listening on a port.
//! This is a client runtime, not an API. It complements the registry in `nodes/mod.rs`.

use crate::nodes::{JoinNodeRequest, NodeCapability, NodeHeartbeatRequest, NodeLoad, NodeReachability};
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

/// Run helper client loop until cancellation.
///
/// Steps:
/// 1. Load existing identity or join with pairing token.
/// 2. Send periodic heartbeats.
/// 3. On transient errors, retry with backoff.
/// 4. On terminal errors (revoked, token expired), exit so operator can re-pair.
pub async fn run_helper(
    primary_url: String,
    pairing_token: Option<String>,
    display_name: String,
    data_dir: String,
) {
    let identity_path = PathBuf::from(&data_dir).join(IDENTITY_FILE);
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
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
                error!(
                    "[helper] Join failed (will retry in 5s): {}"
                    , e
                );
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    };

    info!(
        "[helper] Connected to primary {}. Starting heartbeat loop every {}s",
        identity.primary_url, HEARTBEAT_INTERVAL_SECS
    );

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

        let url = format!("{}/api/nodes/{}/heartbeat", identity.primary_url, identity.node_id);
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

    let json: serde_json::Value = resp.json().await.map_err(|e| anyhow::anyhow!("join response json error: {}", e))?;
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
