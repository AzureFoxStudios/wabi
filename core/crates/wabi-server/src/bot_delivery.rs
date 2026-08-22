//! Bot delivery — real outbound webhook HTTP POST (H1b).
//!
//! Replaces the log-only webhook delivery path with a real HTTP POST to each
//! webhook URL registered on a channel. When a `message.created` event lands
//! in a channel, every webhook attached to that channel receives a JSON
//! payload carrying `channel_id`, `message_id`, `content`, `author`, and
//! `timestamp`.
//!
//! Retry policy: one retry on transient failures (5xx / transport errors);
//! **no** retry on 4xx — those are permanent failures.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::adapter::WdbAdapter;
use wabidb::engine::wabi_store::WabiStore;

/// Number of times a transient failure is retried before giving up.
const MAX_TRANSIENT_RETRIES: u32 = 1;

/// Outbound `message.created` webhook payload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MessageCreatedPayload {
    pub channel_id: String,
    pub message_id: String,
    pub content: String,
    pub author: String,
    pub timestamp: i64,
}

/// Result of delivering to a single webhook URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryOutcome {
    /// Webhook accepted the POST (2xx).
    Delivered,
    /// Webhook rejected the POST (4xx). Permanent — never retried.
    Rejected,
    /// Transient failure (5xx / transport error) even after one retry.
    Failed,
}

/// POST `payload` to every webhook registered on `channel_id`. Reads the
/// webhook projection through WDB, then spawns the outbound POSTs so the
/// message-send path never blocks on network I/O. No-op when the channel has
/// no registered webhooks.
pub fn spawn_message_created_delivery(
    wdb: Arc<WdbAdapter>,
    channel_id: String,
    payload: MessageCreatedPayload,
) {
    tokio::spawn(async move {
        let webhooks = match wdb.get_webhooks(&channel_id).await {
            Ok(hooks) => hooks,
            Err(e) => {
                tracing::warn!(
                    "[bot-delivery] failed to load webhooks for {}: {e}",
                    channel_id
                );
                return;
            }
        };
        if webhooks.is_empty() {
            return;
        }
        // Shared client (t_e42e96c1): one connection pool process-wide instead
        // of a fresh client build + TLS handshake per delivery. Per-request
        // timeout is applied on the RequestBuilder in `post_once`; redirect
        // policy stays none — URLs were validated at registration and a
        // redirect at delivery time could bypass that validation.
        let client = webhook_http_client();
        let outcomes = deliver_message_created(&client, &webhooks, &payload).await;
        let delivered = outcomes
            .iter()
            .filter(|o| **o == DeliveryOutcome::Delivered)
            .count();
        let rejected = outcomes
            .iter()
            .filter(|o| **o == DeliveryOutcome::Rejected)
            .count();
        let failed = outcomes
            .iter()
            .filter(|o| **o == DeliveryOutcome::Failed)
            .count();
        tracing::info!(
            "[bot-delivery] channel {} message {} -> {} delivered, {} rejected, {} failed",
            channel_id,
            payload.message_id,
            delivered,
            rejected,
            failed
        );
    });
}

/// Shared reqwest client for webhook deliveries. One connection pool
/// process-wide (t_e42e96c1): building a Client per delivery paid a fresh
/// pool + TLS handshake on every message-with-webhooks. No redirect policy —
/// webhook URLs are validated at registration and a delivery-time redirect
/// could bypass that validation. Per-request timeout lives on the
/// RequestBuilder in `post_once`.
pub fn webhook_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default()
}

/// Deliver `payload` to every webhook URL, returning one outcome per webhook
/// (in the same order). Never panics.
pub async fn deliver_message_created(
    client: &reqwest::Client,
    webhooks: &[wabidb::domain::Webhook],
    payload: &MessageCreatedPayload,
) -> Vec<DeliveryOutcome> {
    let mut outcomes = Vec::with_capacity(webhooks.len());
    for webhook in webhooks {
        outcomes.push(deliver_to_url(client, &webhook.url, payload).await);
    }
    outcomes
}

/// POST `payload` to a single webhook URL with one retry on transient
/// failures. 4xx is permanent and never retried.
async fn deliver_to_url(
    client: &reqwest::Client,
    url: &str,
    payload: &MessageCreatedPayload,
) -> DeliveryOutcome {
    let mut attempt = 0u32;
    loop {
        match post_once(client, url, payload).await {
            PostResult::Accepted => return DeliveryOutcome::Delivered,
            PostResult::ClientError(status) => {
                tracing::warn!(
                    "[bot-delivery] webhook {} rejected payload (status {status}) — not retrying",
                    url
                );
                return DeliveryOutcome::Rejected;
            }
            PostResult::Transient => {
                if attempt >= MAX_TRANSIENT_RETRIES {
                    tracing::warn!(
                        "[bot-delivery] webhook {} failed after {} attempt(s)",
                        url,
                        attempt + 1
                    );
                    return DeliveryOutcome::Failed;
                }
                attempt += 1;
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

/// A single POST attempt.
enum PostResult {
    /// 2xx — delivered.
    Accepted,
    /// 4xx (or other non-server error) — permanent, no retry.
    ClientError(reqwest::StatusCode),
    /// 5xx or transport error — transient, retryable.
    Transient,
}

async fn post_once(
    client: &reqwest::Client,
    url: &str,
    payload: &MessageCreatedPayload,
) -> PostResult {
    let resp = match client
        .post(url)
        .json(payload)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return PostResult::Transient,
    };
    if resp.status().is_success() {
        PostResult::Accepted
    } else if resp.status().is_server_error() {
        PostResult::Transient
    } else {
        PostResult::ClientError(resp.status())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::State,
        http::StatusCode,
        response::{IntoResponse, Response},
        routing::post,
        Json, Router,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    /// Shared config for a fake webhook endpoint: the response codes to emit
    /// (the last one repeats), a hit counter, and captured request bodies.
    struct FakeWebhook {
        codes: Vec<u16>,
        hits: AtomicUsize,
        bodies: Mutex<Vec<serde_json::Value>>,
    }

    type FakeWebhookState = Arc<FakeWebhook>;

    async fn fake_webhook_handler(
        State(cfg): State<FakeWebhookState>,
        Json(body): Json<serde_json::Value>,
    ) -> Response {
        let hit = cfg.hits.fetch_add(1, Ordering::SeqCst);
        cfg.bodies.lock().unwrap().push(body);
        let code = cfg.codes[hit.min(cfg.codes.len() - 1)];
        StatusCode::from_u16(code).unwrap().into_response()
    }

    async fn spawn_fake_webhook(codes: Vec<u16>) -> (String, FakeWebhookState, JoinHandle<()>) {
        let cfg: FakeWebhookState = Arc::new(FakeWebhook {
            codes,
            hits: AtomicUsize::new(0),
            bodies: Mutex::new(Vec::new()),
        });
        let app = Router::new()
            .route("/", post(fake_webhook_handler))
            .with_state(cfg.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{}", addr), cfg, handle)
    }

    fn webhook(url: String) -> wabidb::domain::Webhook {
        wabidb::domain::Webhook {
            webhook_id: "wh_test".into(),
            channel_id: "ch_1".into(),
            name: "test-hook".into(),
            url,
            created_at_micros: 0,
            created_by_user_id: 0,
        }
    }

    fn test_payload() -> MessageCreatedPayload {
        MessageCreatedPayload {
            channel_id: "ch_1".into(),
            message_id: "msg_1".into(),
            content: "hello from bot".into(),
            author: "hermes-bot".into(),
            timestamp: 1_700_000_000_000,
        }
    }

    fn hits(cfg: &FakeWebhookState) -> usize {
        cfg.hits.load(Ordering::SeqCst)
    }

    async fn wait_for_hits(cfg: &FakeWebhookState, expected: usize) {
        for _ in 0..50 {
            if hits(cfg) >= expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[tokio::test]
    async fn bot_delivery_posts_full_payload_on_2xx() {
        let (url, cfg, handle) = spawn_fake_webhook(vec![200]).await;
        let client = reqwest::Client::new();
        let outcomes = deliver_message_created(&client, &[webhook(url)], &test_payload()).await;

        assert_eq!(outcomes, vec![DeliveryOutcome::Delivered]);
        assert_eq!(hits(&cfg), 1);
        let body = cfg.bodies.lock().unwrap()[0].clone();
        assert_eq!(body["channel_id"], "ch_1");
        assert_eq!(body["message_id"], "msg_1");
        assert_eq!(body["content"], "hello from bot");
        assert_eq!(body["author"], "hermes-bot");
        assert_eq!(body["timestamp"], 1_700_000_000_000i64);

        handle.abort();
    }

    #[tokio::test]
    async fn bot_delivery_no_retry_on_4xx() {
        let (url, cfg, handle) = spawn_fake_webhook(vec![400]).await;
        let client = reqwest::Client::new();
        let outcomes = deliver_message_created(&client, &[webhook(url)], &test_payload()).await;

        // Permanent failure: exactly one attempt, never retried.
        assert_eq!(outcomes, vec![DeliveryOutcome::Rejected]);
        assert_eq!(hits(&cfg), 1);

        handle.abort();
    }

    #[tokio::test]
    async fn bot_delivery_retries_once_on_5xx_then_fails() {
        let (url, cfg, handle) = spawn_fake_webhook(vec![500, 500]).await;
        let client = reqwest::Client::new();
        let outcomes = deliver_message_created(&client, &[webhook(url)], &test_payload()).await;

        // One retry on 5xx, then give up.
        assert_eq!(outcomes, vec![DeliveryOutcome::Failed]);
        assert_eq!(hits(&cfg), 2);

        handle.abort();
    }

    #[tokio::test]
    async fn bot_delivery_retries_once_on_5xx_then_recovers() {
        let (url, cfg, handle) = spawn_fake_webhook(vec![500, 200]).await;
        let client = reqwest::Client::new();
        let outcomes = deliver_message_created(&client, &[webhook(url)], &test_payload()).await;

        // First attempt 500 -> retried once -> 200.
        assert_eq!(outcomes, vec![DeliveryOutcome::Delivered]);
        assert_eq!(hits(&cfg), 2);

        handle.abort();
    }

    #[tokio::test]
    async fn bot_delivery_multiple_webhooks_each_get_posted() {
        let (url_ok, cfg_ok, handle_ok) = spawn_fake_webhook(vec![200]).await;
        let (url_bad, cfg_bad, handle_bad) = spawn_fake_webhook(vec![403]).await;
        let client = reqwest::Client::new();
        let webhooks = [webhook(url_ok), webhook(url_bad)];

        let outcomes = deliver_message_created(&client, &webhooks, &test_payload()).await;

        assert_eq!(
            outcomes,
            vec![DeliveryOutcome::Delivered, DeliveryOutcome::Rejected]
        );
        assert_eq!(hits(&cfg_ok), 1);
        assert_eq!(hits(&cfg_bad), 1);

        handle_ok.abort();
        handle_bad.abort();
    }

    #[tokio::test]
    async fn bot_delivery_spawn_posts_to_registered_webhook() {
        use wabidb::crypto::bootstrap::BootstrapSource;
        use wabidb::engine::wabi_store::WabiStore;
        use wabidb::engine::{WabiDbConfig, WabiDbEngine};

        let dir = tempfile::tempdir().unwrap();
        let config = WabiDbConfig {
            data_dir: dir.path().to_path_buf(),
            bootstrap_source: BootstrapSource::Provided([0u8; 32]),
            bootstrap_salt: None,
            allow_init: true,
            replication_config: None,
            sync_transport: None,
            test_boot_wallclock_override: None,
        };
        let engine = WdbAdapter::open_with_config(config).await.unwrap();

        let (url, cfg, handle) = spawn_fake_webhook(vec![200]).await;
        engine
            .upsert_webhook("ch_1", "bot-hook", &url)
            .await
            .unwrap();

        spawn_message_created_delivery(Arc::new(engine), "ch_1".into(), test_payload());

        wait_for_hits(&cfg, 1).await;
        assert_eq!(hits(&cfg), 1);
        let body = cfg.bodies.lock().unwrap()[0].clone();
        assert_eq!(body["channel_id"], "ch_1");
        assert_eq!(body["message_id"], "msg_1");

        handle.abort();
    }
}
