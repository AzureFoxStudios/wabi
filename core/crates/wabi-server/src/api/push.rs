//! Web Push API — VAPID public key, subscribe, unsubscribe, test send.
//!
//! Routes:
//! - GET  /api/push/vapid-public-key
//! - POST /api/push/subscribe   (auth)
//! - DELETE /api/push/subscribe (auth)
//! - POST /api/push/test        (auth)

use axum::{extract::State, Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{info, warn};

use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::push_store::{now_ms, PushSubscriptionRecord};
use crate::state::AppState;

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/vapid-public-key",
            axum::routing::get(get_vapid_public_key),
        )
        .route(
            "/subscribe",
            axum::routing::post(subscribe).delete(unsubscribe),
        )
        .route("/test", axum::routing::post(test_push))
        .with_state(state)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VapidPublicResponse {
    public_key: String,
}

async fn get_vapid_public_key(
    State(state): State<Arc<AppState>>,
) -> Result<Json<VapidPublicResponse>> {
    let key = state
        .push_store
        .public_key()
        .await
        .ok_or_else(|| AppError::Internal("VAPID keys unavailable".into()))?;
    Ok(Json(VapidPublicResponse { public_key: key }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscribeBody {
    endpoint: String,
    keys: SubscribeKeys,
    device_id: String,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    user_agent: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SubscribeKeys {
    p256dh: String,
    auth: String,
}

#[derive(Debug, Serialize)]
struct OkResponse {
    ok: bool,
}

async fn subscribe(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<SubscribeBody>,
) -> Result<Json<OkResponse>> {
    if body.endpoint.trim().is_empty()
        || body.keys.p256dh.trim().is_empty()
        || body.keys.auth.trim().is_empty()
        || body.device_id.trim().is_empty()
    {
        return Err(AppError::BadRequest("missing push subscription fields".into()));
    }

    let record = PushSubscriptionRecord {
        user_id: auth.user_id,
        device_id: body.device_id.trim().to_string(),
        endpoint: body.endpoint.trim().to_string(),
        p256dh: body.keys.p256dh.trim().to_string(),
        auth: body.keys.auth.trim().to_string(),
        platform: body
            .platform
            .unwrap_or_else(|| "web".into())
            .chars()
            .take(32)
            .collect(),
        user_agent: body.user_agent.map(|s| s.chars().take(256).collect()),
        updated_at_ms: now_ms(),
    };

    state
        .push_store
        .upsert(record)
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(Json(OkResponse { ok: true }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnsubscribeBody {
    #[serde(default)]
    endpoint: Option<String>,
    #[serde(default)]
    device_id: Option<String>,
}

async fn unsubscribe(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<UnsubscribeBody>,
) -> Result<Json<OkResponse>> {
    if let Some(endpoint) = body.endpoint.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        state
            .push_store
            .remove_endpoint(endpoint)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
    } else if let Some(device_id) = body.device_id.as_deref().map(str::trim).filter(|s| !s.is_empty())
    {
        state
            .push_store
            .remove_user_device(auth.user_id, device_id)
            .await
            .map_err(|e| AppError::Internal(e.to_string()))?;
    } else {
        return Err(AppError::BadRequest(
            "endpoint or deviceId required".into(),
        ));
    }
    Ok(Json(OkResponse { ok: true }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestPushResponse {
    ok: bool,
    sent: usize,
    failed: usize,
}

async fn test_push(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
) -> Result<Json<TestPushResponse>> {
    let payload = serde_json::json!({
        "title": "Wabi",
        "body": "Test push — if you see this, mobile push works.",
        "icon": "/icon-192.png",
        "wabiNav": "settings",
        "section": "notifications",
        "tag": "wabi-push-test"
    });
    let (sent, failed) = send_push_to_user(&state, auth.user_id, &payload).await;
    Ok(Json(TestPushResponse {
        ok: sent > 0,
        sent,
        failed,
    }))
}

/// Send a JSON payload to all registered devices for `user_id`.
/// Uses the Web Push protocol via the `web-push` crate when available at runtime.
pub async fn send_push_to_user(
    state: &AppState,
    user_id: i64,
    payload: &serde_json::Value,
) -> (usize, usize) {
    let subs = state.push_store.list_for_user(user_id).await;
    if subs.is_empty() {
        return (0, 0);
    }

    let Some(private_pem) = state.push_store.private_pem().await else {
        warn!("push: no VAPID private key");
        return (0, subs.len());
    };
    let subject = state.push_store.subject().await;
    let body = payload.to_string();

    let mut sent = 0usize;
    let mut failed = 0usize;

    for sub in subs {
        match send_one(&private_pem, &subject, &sub, &body).await {
            Ok(()) => {
                sent += 1;
            }
            Err(err) => {
                failed += 1;
                warn!(
                    "push send failed user={} endpoint={}: {err}",
                    user_id,
                    truncate_endpoint(&sub.endpoint)
                );
                // Drop gone subscriptions
                let msg = err.to_string();
                if msg.contains("410") || msg.contains("404") || msg.contains("Gone") {
                    let _ = state.push_store.remove_endpoint(&sub.endpoint).await;
                }
            }
        }
    }

    if sent > 0 {
        info!("push: sent {sent} failed {failed} user={user_id}");
    }
    (sent, failed)
}

async fn send_one(
    private_pem: &str,
    subject: &str,
    sub: &PushSubscriptionRecord,
    body: &str,
) -> anyhow::Result<()> {
    use web_push::{
        ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder,
        WebPushClient, WebPushMessageBuilder,
    };

    let subscription_info =
        SubscriptionInfo::new(&sub.endpoint, &sub.p256dh, &sub.auth);

    let sig = VapidSignatureBuilder::from_pem(private_pem.as_bytes(), &subscription_info)?
        .add_claim("sub", subject)
        .build()?;

    let mut builder = WebPushMessageBuilder::new(&subscription_info);
    builder.set_payload(ContentEncoding::Aes128Gcm, body.as_bytes());
    builder.set_vapid_signature(sig);
    let message = builder.build()?;

    let client = IsahcWebPushClient::new()?;
    client.send(message).await?;
    Ok(())
}

fn truncate_endpoint(endpoint: &str) -> String {
    if endpoint.len() <= 64 {
        endpoint.to_string()
    } else {
        format!("{}…", &endpoint[..64])
    }
}
