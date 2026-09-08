//! Real HTTP configuration/authentication contract for optional TURN support.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha1::Sha1;
use sha2::digest::KeyInit;
use std::{path::Path, sync::Arc};
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
use wabidb::engine::wabi_store::WabiStore;

const TURN_SECRET: &str = "turn-runtime-contract-hmac-secret-only";

async fn server(
    path: &Path,
    enabled: bool,
    uri: Option<&str>,
    secret: Option<&str>,
) -> Arc<AppState> {
    Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "turn-runtime-contract-account-secret-only".into(),
            turn_enabled: enabled,
            turn_uri: uri.map(str::to_owned),
            turn_secret: secret.map(str::to_owned),
            node_id: "test".into(),
            is_primary: true,
            server_role: ServerRole::Authority,
            authority_url: None,
            admin_user_ids: vec![],
            blacklist_file: path.join("blacklist").to_string_lossy().into_owned(),
            max_body_size: None,
            mesh_enabled: false,
            mesh_peers: vec![],
            lore: LoreAddonConfig::default(),
        })
        .await
        .unwrap(),
    )
}

fn token(
    state: &AppState,
    uid: u64,
    guest: bool,
    kind: &str,
    stepup: bool,
    wrong_signature: bool,
) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: uid.to_string(),
            username: format!("turn-{uid}"),
            is_guest: guest,
            exp: now + 3600,
            iat: now,
            jti: uuid::Uuid::new_v4().to_string(),
            stepup,
            token_type: kind.into(),
        },
        &jsonwebtoken::EncodingKey::from_secret(if wrong_signature {
            b"wrong-account-key"
        } else {
            state.config.jwt_secret.as_bytes()
        }),
    )
    .unwrap()
}

fn router(state: &Arc<AppState>) -> Router {
    Router::new()
        .nest("/api", create_api_router(state.clone()))
        .with_state(state.clone())
}

async fn get(app: &Router, path: &str, bearer: Option<&str>) -> (StatusCode, Value) {
    let mut request = Request::get(path);
    if let Some(token) = bearer {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let body = serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
        .unwrap();
    (status, body)
}

#[tokio::test]
async fn runtime_and_credentials_share_actual_endpoint_and_hmac_for_registered_and_guest_accounts()
{
    for (uri, host, port, tls) in [
        ("turn.example:3478", "turn.example", 3478, false),
        ("turn://192.0.2.5:4910", "192.0.2.5", 4910, false),
        ("turns:[2001:db8::5]:443", "[2001:db8::5]", 443, true),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let state = server(dir.path(), true, Some(uri), Some(TURN_SECRET)).await;
        let member = state
            .wdb
            .create_user("turn-member", None, "test-hash")
            .await
            .unwrap();
        let guest = state.wdb.create_user("turn-guest", None, "").await.unwrap();
        let app = router(&state);
        let before = state.wdb.engine().projection_state().applied_commit_seq();
        let (status, runtime) = get(&app, "/api/media/runtime", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            runtime["media"]["turn"],
            serde_json::json!({"configured":true,"server":host,"port":port,"useTurns":tls})
        );
        assert!(!runtime.to_string().contains(TURN_SECRET));
        for (uid, is_guest) in [(member, false), (guest, true)] {
            let now = chrono::Utc::now().timestamp() as u64;
            let bearer = token(&state, uid, is_guest, "access", false, false);
            let (status, body) = get(&app, "/api/media/turn-credentials", Some(&bearer)).await;
            assert_eq!(status, StatusCode::OK);
            let turn = &body["turn"];
            assert_eq!(turn["server"], host);
            assert_eq!(turn["port"], port);
            assert_eq!(turn["useTurns"], tls);
            assert_eq!(turn["source"], "origin");
            assert!(turn["relayId"].is_null());
            let expiry = turn["expiresAt"].as_u64().unwrap();
            assert!(
                (now + 86400..=chrono::Utc::now().timestamp() as u64 + 86400).contains(&expiry)
            );
            let username = turn["username"].as_str().unwrap();
            assert_eq!(username, format!("{expiry}:{uid}"));
            // Validate the actual API output against coturn's REST HMAC
            // contract, not against another JSON field or a fixed placeholder.
            let mut mac = Hmac::<Sha1>::new_from_slice(TURN_SECRET.as_bytes()).unwrap();
            mac.update(username.as_bytes());
            let password = STANDARD
                .decode(turn["credential"].as_str().unwrap())
                .unwrap();
            mac.verify_slice(&password).unwrap();
            let mut wrong_key = Hmac::<Sha1>::new_from_slice(b"wrong-turn-hmac-key").unwrap();
            wrong_key.update(username.as_bytes());
            assert!(wrong_key.verify_slice(&password).is_err());
            assert!(!body.to_string().contains(TURN_SECRET));
        }
        assert_eq!(
            state.wdb.engine().projection_state().applied_commit_seq(),
            before,
            "credentials are ephemeral, not a parallel database write"
        );
    }
}

#[tokio::test]
async fn disabled_or_incomplete_turn_never_advertises_a_working_configuration() {
    for (enabled, uri, secret) in [
        (false, None, None),
        (true, Some("turn.example"), None),
        (true, Some("turn:host:invalid"), Some(TURN_SECRET)),
        (true, None, Some(TURN_SECRET)),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let state = server(dir.path(), enabled, uri, secret).await;
        let uid = state
            .wdb
            .create_user("turn-member", None, "test-hash")
            .await
            .unwrap();
        let bearer = token(&state, uid, false, "access", false, false);
        let app = router(&state);
        let (_, runtime) = get(&app, "/api/media/runtime", None).await;
        assert_eq!(
            runtime["media"]["turn"],
            serde_json::json!({"configured":false,"server":null,"port":null,"useTurns":false})
        );
        let (status, body) = get(&app, "/api/media/turn-credentials", Some(&bearer)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.get("turn").is_none());
        assert!(!body.to_string().contains(TURN_SECRET));
    }
}

#[tokio::test]
async fn credentials_require_current_account_access_not_missing_wrong_kind_or_revoked_proofs() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path(), true, Some("turn.example"), Some(TURN_SECRET)).await;
    let uid = state
        .wdb
        .create_user("turn-member", None, "test-hash")
        .await
        .unwrap();
    let app = router(&state);
    assert_eq!(
        get(&app, "/api/media/turn-credentials", None).await.0,
        StatusCode::UNAUTHORIZED
    );
    for bearer in [
        "invalid-account-token".into(),
        token(&state, uid, false, "access", false, true),
        token(&state, uid, false, "refresh", false, false),
        token(&state, uid, false, "access", true, false),
    ] {
        let (status, body) = get(&app, "/api/media/turn-credentials", Some(&bearer)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.get("turn").is_none());
    }
    let bearer = token(&state, uid, false, "access", false, false);
    state.revoke_user(uid as i64).await;
    let (status, body) = get(&app, "/api/media/turn-credentials", Some(&bearer)).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body.get("turn").is_none());
}

#[test]
fn coturn_template_uses_rest_auth_and_only_allocates_published_relay_ports() {
    let template = include_str!("../../../../turn-server/turnserver.conf.template");
    let directives: Vec<_> = template
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .collect();
    assert!(directives.contains(&"use-auth-secret"));
    assert!(directives.contains(&"static-auth-secret=${TURN_HMAC_KEY}"));
    assert!(
        !directives.contains(&"oauth"),
        "REST HMAC credentials do not use the OAuth test-key mechanism"
    );
    assert!(directives.contains(&"min-port=49160"));
    assert!(directives.contains(&"max-port=49200"));
    let compose = include_str!("../../../../docker-compose.yml");
    let dockerfile = include_str!("../../../../turn-server/Dockerfile");
    assert!(compose.contains("49160-49200:49160-49200/udp"));
    assert!(dockerfile.contains("49160-49200/udp"));
}

#[test]
fn coturn_renderer_requires_an_explicit_ip_and_rejects_config_injection_before_overwrite() {
    // Exercise the exact Python embedded in the entrypoint against temporary
    // paths, without Docker, live credentials or process-global environment edits.
    let entrypoint = include_str!("../../../../turn-server/docker-entrypoint.sh");
    let script = entrypoint
        .split_once("<<'PYCODE'\n")
        .unwrap()
        .1
        .split_once("\nPYCODE")
        .unwrap()
        .0;
    let dir = tempfile::tempdir().unwrap();
    let template = dir.path().join("template");
    let output = dir.path().join("output");
    std::fs::write(
        &template,
        include_str!("../../../../turn-server/turnserver.conf.template"),
    )
    .unwrap();
    for (ip, realm, secret, valid) in [
        (Some("192.0.2.5"), "turn.example", TURN_SECRET, true),
        (
            Some("192.0.2.5/172.19.0.2"),
            "turn.example",
            TURN_SECRET,
            true,
        ),
        (Some("2001:db8::5"), "turn.example", TURN_SECRET, true),
        (None, "turn.example", TURN_SECRET, false),
        (Some("0.0.0.0"), "turn.example", TURN_SECRET, false),
        (Some("turn.example"), "turn.example", TURN_SECRET, false),
        (Some("192.0.2.5/::1"), "turn.example", TURN_SECRET, false),
        (
            Some("192.0.2.5\nno-auth"),
            "turn.example",
            TURN_SECRET,
            false,
        ),
        (
            Some("192.0.2.5"),
            "turn.example\nno-auth",
            TURN_SECRET,
            false,
        ),
        (
            Some("192.0.2.5"),
            "turn.example",
            "private-secret-canary\nno-auth",
            false,
        ),
        (Some("192.0.2.5"), "turn.example", "", false),
    ] {
        std::fs::write(&output, "retained-config").unwrap();
        let mut command = std::process::Command::new("python3");
        command
            .arg("-c")
            .arg(script)
            .arg(&template)
            .arg(&output)
            .env_clear()
            .env("TURN_REALM", realm)
            .env("TURN_HMAC_KEY", secret);
        if let Some(ip) = ip {
            command.env("TURN_EXTERNAL_IP", ip);
        }
        let result = command
            .output()
            .expect("python3 is required to verify the coturn image's existing renderer");
        assert_eq!(result.status.success(), valid);
        assert!(
            result.stdout.is_empty(),
            "renderer never prints generated credentials"
        );
        assert!(!String::from_utf8_lossy(&result.stderr).contains("private-secret-canary"));
        let rendered = std::fs::read_to_string(&output).unwrap();
        if valid {
            assert!(rendered.contains(&format!("external-ip={}\n", ip.unwrap())));
            assert!(rendered.contains("min-port=49160\nmax-port=49200"));
            assert!(!rendered.contains("${"));
        } else {
            assert_eq!(
                rendered, "retained-config",
                "invalid settings must not overwrite the last generated file"
            );
        }
    }
}
