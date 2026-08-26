//! Boot brand injection contract (Phase 1 boot optimization):
//! - the server stamps its identity (name/icon/accent) into the embedded
//!   index.html so first paint is branded with zero extra requests
//! - both index paths are branded: the direct hit AND the SPA-fallback used
//!   for deep links (e.g. /channels/x)
//! - sw.js and manifest.webmanifest must revalidate (`no-cache`), never
//!   immutable-cache — an immutable manifest hides rebrands from PWAs
//! - admin-entered strings are escaped / rejected, never injected raw
//! - composition re-runs when admin_policies.json changes (mtime keying)

use std::path::Path;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

use wabi_server::app_router::build_app_router;
use wabi_server::config::{LoreAddonConfig, ServerConfig, ServerRole};
use wabi_server::state::AppState;

const BRAND_TOKEN: &str = "/*__WABI_SERVER_BRAND__*/null";

fn test_config(data_dir: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: data_dir.to_string_lossy().into_owned(),
        uploads_dir: data_dir.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "test-jwt-secret".into(),
        turn_enabled: false,
        turn_uri: None,
        turn_secret: None,
        node_id: "node-test".into(),
        is_primary: true,
        server_role: ServerRole::Authority,
        authority_url: None,
        admin_user_ids: vec![],
        blacklist_file: data_dir.join("blacklist.txt").to_string_lossy().into_owned(),
        max_body_size: None,
        mesh_enabled: false,
        mesh_peers: vec![],
        lore: LoreAddonConfig {
            enabled: false,
            mode: "sidecar".into(),
            server_url: "lore://localhost:10000".into(),
            binary_path: "lore".into(),
            data_dir: "/var/wabi/lore".into(),
            default_blob_max_size_mb: 1024,
            auto_create_repos: true,
            recordings_channel_name: None,
        },
    }
}

/// Production serves through `into_make_service_with_connect_info`, which
/// injects `ConnectInfo<SocketAddr>` per request; `oneshot` does not, so the
/// test harness emulates it.
async fn add_connect_info(
    mut req: Request<Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let addr: std::net::SocketAddr = "127.0.0.1:11111".parse().unwrap();
    req.extensions_mut().insert(axum::extract::connect_info::ConnectInfo(addr));
    next.run(req).await
}

async fn fresh_server(data_dir: &Path) -> axum::Router {
    let config = test_config(data_dir);
    let state = Arc::new(AppState::new(config).await.unwrap());
    build_app_router(state.clone()).layer(axum::middleware::from_fn(add_connect_info))
}

fn write_policies(data_dir: &Path, frontend_app_metadata: serde_json::Value) {
    let doc = serde_json::json!({ "frontend_app_metadata": frontend_app_metadata });
    std::fs::write(
        data_dir.join("admin_policies.json"),
        serde_json::to_string(&doc).unwrap(),
    )
    .unwrap();
}

async fn get(app: &axum::Router, path: &str) -> (StatusCode, axum::http::HeaderMap, String) {

    let response = app
        .clone()
        .oneshot(Request::get(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, headers, String::from_utf8_lossy(&bytes).into_owned())
}

#[tokio::test]
async fn injects_brand_into_index_and_deep_links() {
    let tmp = tempfile::TempDir::new().unwrap();
    write_policies(
        tmp.path(),
        serde_json::json!({
            "displayName": "Fort Night",
            "iconUrl": "/uploads/x.png",
            "accentColor": "#ff0055"
        }),
    );
    let app = fresh_server(tmp.path()).await;

    for path in ["/", "/channels/abc"] {
        let (status, headers, body) = get(&app, path).await;
        assert_eq!(status, StatusCode::OK, "GET {path}");
        assert!(
            body.contains(r#""brandName":"Fort Night""#),
            "{path}: injected brand JSON missing"
        );
        assert!(body.contains("<title>Fort Night</title>"), "{path}: title");
        assert!(
            body.contains(r#"href="/uploads/x.png" data-wabi-favicon"#),
            "{path}: favicon"
        );
        assert!(
            body.contains(r##"content="#ff0055" data-wabi-theme-color"##),
            "{path}: theme-color"
        );
        assert_eq!(
            headers
                .get("cache-control")
                .and_then(|v| v.to_str().ok()),
            Some("no-cache"),
            "{path}: index must revalidate"
        );
    }
}

#[tokio::test]
async fn stock_server_serves_untouched_shell() {
    let tmp = tempfile::TempDir::new().unwrap();
    let app = fresh_server(tmp.path()).await;

    let (status, _headers, body) = get(&app, "/").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.contains(BRAND_TOKEN),
        "un-replaced token must survive when no brand is configured"
    );
    assert!(
        body.contains("<title data-wabi-brand-title>Wabi</title>"),
        "default title marker must survive"
    );
}

#[tokio::test]
async fn sw_and_manifest_revalidate() {
    let tmp = tempfile::TempDir::new().unwrap();
    let app = fresh_server(tmp.path()).await;

    for path in ["/sw.js", "/manifest.webmanifest"] {
        let (status, headers, _body) = get(&app, path).await;
        assert_eq!(status, StatusCode::OK, "GET {path}");
        assert_eq!(
            headers.get("cache-control").and_then(|v| v.to_str().ok()),
            Some("no-cache"),
            "{path} must not be immutable-cached"
        );
    }
}

#[tokio::test]
async fn rejects_non_hex_accent() {
    let tmp = tempfile::TempDir::new().unwrap();
    write_policies(
        tmp.path(),
        serde_json::json!({
            "displayName": "Evil Corp",
            "accentColor": "red; url(javascript:1)"
        }),
    );
    let app = fresh_server(tmp.path()).await;

    let (_status, _headers, body) = get(&app, "/").await;
    assert!(
        !body.contains(r#"content="red; url(javascript:1)""#),
        "non-hex accent must never reach the theme-color attribute"
    );
    assert!(
        body.contains(r##"content="#0f0c29" data-wabi-theme-color"##),
        "theme-color must stay at its default when the accent is rejected"
    );
}

#[tokio::test]
async fn brand_json_cannot_break_out_of_script() {
    let tmp = tempfile::TempDir::new().unwrap();
    let payload = "</script><img src=x onerror=alert(1)>";
    write_policies(
        tmp.path(),
        serde_json::json!({ "displayName": payload }),
    );
    let app = fresh_server(tmp.path()).await;

    let (_status, _headers, body) = get(&app, "/").await;
    // The raw payload must not survive anywhere: title is HTML-escaped and
    // the JSON is \u-escaped, so `</script>` can never terminate early.
    assert!(!body.contains(payload), "raw </script> breakout must be neutralized");
    assert!(body.contains("<title>&lt;/script&gt;"), "title must be HTML-escaped");
    assert!(
        body.contains(r##"\u003c/script"##),
        "brand JSON must escape < for inline-script safety"
    );
}

#[tokio::test]
async fn recomposes_when_policy_changes() {
    let tmp = tempfile::TempDir::new().unwrap();
    write_policies(
        tmp.path(),
        serde_json::json!({ "displayName": "Before" }),
    );
    let app = fresh_server(tmp.path()).await;

    let (_, _, body) = get(&app, "/").await;
    assert!(body.contains(r#""brandName":"Before""#));

    // Rewrite with a different display name; the mtime change must invalidate.
    std::thread::sleep(std::time::Duration::from_millis(20));
    write_policies(tmp.path(), serde_json::json!({ "displayName": "After" }));

    let (_, _, body) = get(&app, "/").await;
    assert!(
        body.contains(r#""brandName":"After""#),
        "composition must refresh after admin_policies.json changes"
    );
}

