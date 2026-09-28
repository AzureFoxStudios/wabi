//! Tailcat private-access contract (docs/plans/2026-09-01-tailcat-private-access.md):
//! - enable/disable lifecycle against a mock listener binary: subprocess comes
//!   up, address blob captured, disable is an instant kill
//! - per-member keys: registration reaches the listener's --allow list;
//!   revocation removes it (hot bounce, no server restart)
//! - settings persist (auto-respawn intent survives restart)
//! - pipe-aware rate-limit keying: a validated forwarder token keys per pipe
//!   client; anything else (including spoofed headers) falls back to peer IP
//! - admin gating on the HTTP surface

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::util::ServiceExt;

use wabi_server::api::tailcat as api;
use wabi_server::config::{LoreAddonConfig, ServerConfig, ServerRole};
use wabi_server::state::AppState;

fn test_config(data_dir: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 45454,
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
        admin_user_ids: vec![1],
        blacklist_file: data_dir
            .join("blacklist.txt")
            .to_string_lossy()
            .into_owned(),
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

/// Mock `tailcat`: `version` prints; `serve` records its args (so tests can
/// assert the allow-list) then writes a fake address blob and sleeps. It
/// also enforces tailcat's real CLI rule - flags must precede positional
/// args - so an arg-order regression fails here, not just in the field.
fn write_mock_binary(dir: &Path, args_log: &Path) -> PathBuf {
    let path = dir.join("tailcat-mock.sh");
    let script = format!(
        "#!/usr/bin/env bash\n\
if [ \"$1\" = \"version\" ]; then echo \"v0.4.0-mock\"; exit 0; fi\n\
if [ \"$1\" = \"serve\" ]; then\n\
  shift\n\
  seen_positional=0\n\
  for arg in \"$@\"; do\n\
    if [[ \"$arg\" == --* ]]; then\n\
      if [ \"$seen_positional\" = \"1\" ]; then\n\
        echo \"mock: flag after positional arg: $arg\" >&2\n\
        exit 1\n\
      fi\n\
    else\n\
      seen_positional=1\n\
    fi\n\
  done\n\
  echo \"$@\" >> \"{}\"\n\
  printf 'tcMOCKADDRESS1234567890' > \"$TAILCAT_ADDR_FILE\"\n\
  exec sleep 600\n\
fi\n\
exit 1\n",
        args_log.display()
    );
    std::fs::write(&path, script).unwrap();
    let mut perms = std::fs::metadata(&path).unwrap().permissions();
    use std::os::unix::fs::PermissionsExt;
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).unwrap();
    path
}

async fn open(data_dir: &Path) -> Arc<AppState> {
    // Pre-seed pipe_port=0 (OS-assigned ephemeral) so the forwarder never
    // collides with real ports in CI.
    let tc_dir = data_dir.join("tailcat");
    std::fs::create_dir_all(&tc_dir).unwrap();
    std::fs::write(
        tc_dir.join("settings.json"),
        r#"{"enabled": false, "pipe_port": 0}"#,
    )
    .unwrap();
    Arc::new(AppState::new(test_config(data_dir)).await.unwrap())
}

async fn wait_for<F: Fn(&wabi_tailcat::StatusSnapshot) -> bool>(
    state: &Arc<AppState>,
    cond: F,
    what: &str,
) -> wabi_tailcat::StatusSnapshot {
    for _ in 0..50 {
        let snap = state.tailcat.status().await;
        if cond(&snap) {
            return snap;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("condition not met in time: {what}");
}

fn last_spawn_args(log: &Path) -> String {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .next_back()
        .unwrap_or("")
        .to_string()
}

fn mint_token(secret: &str, sub: &str) -> String {
    let claims = serde_json::json!({
        "sub": sub,
        "username": "tester",
        "is_guest": false,
        "exp": 9999999999i64,
        "iat": 0,
        "jti": "test",
        "token_type": "access",
    });
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

#[tokio::test]
async fn enable_disable_lifecycle_and_allow_list() {
    let tmp = tempfile::tempdir().unwrap();
    let args_log = tmp.path().join("spawn-args.log");
    let mock = write_mock_binary(tmp.path(), &args_log);
    std::env::set_var("WABI_TAILCAT_BINARY", &mock);
    let data_dir = tmp.path().join("data");
    let state = open(&data_dir).await;

    // Disabled by default: not running, no address, nothing spawned.
    let snap = state.tailcat.status().await;
    assert!(!snap.enabled && !snap.running, "must start disabled");
    assert!(!args_log.exists(), "no subprocess before enabling");

    // Zero allowed keys must never launch an unrestricted listener.
    state.tailcat.set_enabled(true, 1).await.unwrap();
    assert!(!state.tailcat.status().await.running);
    let initial = state
        .tailcat
        .register_key(
            1,
            "nodekey:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            None,
        )
        .await
        .unwrap();
    // A registered device allows the listener to start.
    state.tailcat.set_enabled(true, 1).await.unwrap();
    let snap = wait_for(
        &state,
        |s| s.running && s.address.is_some(),
        "running+address after enable",
    )
    .await;
    assert_eq!(snap.address.as_deref(), Some("tcMOCKADDRESS1234567890"));
    assert_eq!(snap.binary_version.as_deref(), Some("v0.4.0-mock"));
    assert!(last_spawn_args(&args_log).contains(
        "--allow=nodekey:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ));

    // Register a member key: the listener bounces with the key allow-listed.
    state
        .tailcat
        .register_key(
            7,
            "nodekey:7777777777777777777777777777777777777777777777777777777777777777".into(),
            Some("laptop".into()),
        )
        .await
        .unwrap();
    let mut allow_ok = false;
    for _ in 0..50 {
        if last_spawn_args(&args_log)
            .contains("nodekey:7777777777777777777777777777777777777777777777777777777777777777")
        {
            allow_ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(allow_ok, "allow-list must reach the listener args");

    // Raw (unprefixed) keys are normalized to nodekey: form.
    state
        .tailcat
        .register_key(
            8,
            "8888888888888888888888888888888888888888888888888888888888888888".into(),
            None,
        )
        .await
        .unwrap();
    let mut normalized = false;
    for _ in 0..50 {
        if last_spawn_args(&args_log)
            .contains("nodekey:8888888888888888888888888888888888888888888888888888888888888888")
        {
            normalized = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(normalized, "raw key must normalize to nodekey: form");

    // Revoke: the key disappears from subsequent spawns.
    let key_id = state
        .tailcat
        .keys()
        .iter()
        .find(|k| k.user_id == 8)
        .map(|k| k.id.clone())
        .unwrap();
    state.tailcat.revoke_key(&key_id, 1).await.unwrap();
    let mut revoked = false;
    for _ in 0..50 {
        let args = last_spawn_args(&args_log);
        if args.contains("nodekey:7777777777777777777777777777777777777777777777777777777777777777")
            && !args.contains("8888888888888888888888888888888888888888888888888888888888888888")
        {
            revoked = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        revoked,
        "revocation must remove the key from the allow-list"
    );

    // Address for members: only for key holders while enabled (the revoke
    // bounce re-spawns the listener, so poll for the address to return).
    let mut addr_ok = false;
    for _ in 0..50 {
        if state.tailcat.address_for(7).await.is_some() {
            addr_ok = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(addr_ok, "key holder must receive the address after bounce");
    assert!(state.tailcat.address_for(99).await.is_none());

    // Device block cannot be bypassed by registering the same key again.
    state
        .tailcat
        .set_key_allowed(&initial.id, false, 1)
        .await
        .unwrap();
    let repeated = state
        .tailcat
        .register_key(
            1,
            "nodekey:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            None,
        )
        .await
        .unwrap();
    assert!(!repeated.allowed);
    assert!(
        !state
            .tailcat
            .register_key(1, "A".repeat(64), None)
            .await
            .unwrap()
            .allowed
    );
    assert!(state
        .tailcat
        .register_key(1, "".into(), None)
        .await
        .is_err());
    assert!(state
        .tailcat
        .register_key(1, "nodekey:".into(), None)
        .await
        .is_err());
    assert!(
        !state
            .tailcat
            .register_key(
                1,
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                None
            )
            .await
            .unwrap()
            .allowed,
        "prefix alias must not bypass a device block"
    );
    assert!(state.tailcat.address_for(1).await.is_none());
    // Reserve a conflict: failed change must leave the saved port unchanged.
    let conflict = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let before = state.tailcat.pipe_port();
    assert!(state
        .tailcat
        .set_pipe_port(conflict.local_addr().unwrap().port(), 1)
        .await
        .is_err());
    assert_eq!(state.tailcat.pipe_port(), before);
    let available = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = available.local_addr().unwrap().port();
    drop(available);
    state.tailcat.set_pipe_port(port, 1).await.unwrap();
    assert_eq!(state.tailcat.pipe_port(), port);
    assert!(
        tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .is_ok()
    );
    assert!(state.tailcat.set_pipe_port(45454, 1).await.is_err());
    assert!(state.tailcat.set_pipe_port(0, 1).await.is_err());

    // Disable: instant kill.
    state.tailcat.set_enabled(false, 1).await.unwrap();
    let snap = wait_for(&state, |s| !s.running, "stopped after disable").await;
    assert!(!snap.enabled);
    assert!(snap.address.is_none());
    assert!(state.tailcat.address_for(7).await.is_none());

    // Persistence: the disable decision survives a "restart".
    let persisted = std::fs::read_to_string(data_dir.join("tailcat/settings.json")).unwrap();
    assert!(persisted.contains("\"enabled\": false"), "got: {persisted}");
    let audit = std::fs::read_to_string(data_dir.join("tailcat/audit.jsonl")).unwrap();
    assert!(audit.contains("\"action\":\"enable\""));
    assert!(audit.contains("\"action\":\"key-revoke\""));

    // Process shutdown reaps the listener without changing the saved choice.
    state.tailcat.set_enabled(true, 1).await.unwrap();
    wait_for(&state, |s| s.running, "running again before shutdown").await;
    state.tailcat.shutdown().await;
    let snap = state.tailcat.status().await;
    assert!(
        !snap.running,
        "shutdown waits for the owned listener to exit"
    );
    assert!(snap.enabled, "shutdown must preserve private-access intent");
    let persisted = std::fs::read_to_string(data_dir.join("tailcat/settings.json")).unwrap();
    assert!(persisted.contains("\"enabled\": true"));

    std::env::remove_var("WABI_TAILCAT_BINARY");
}

#[tokio::test]
async fn rate_limit_keying_distinguishes_pipe_clients() {
    let tmp = tempfile::tempdir().unwrap();
    let state = open(&tmp.path().join("data")).await;
    let peer: std::net::SocketAddr = "127.0.0.1:54321".parse().unwrap();

    // No headers: plain peer IP (public path unchanged).
    let key = state
        .tailcat
        .rate_limit_key(&axum::http::HeaderMap::new(), &peer);
    assert_eq!(key, "127.0.0.1");

    // Spoofed token (public client pretending to be the forwarder): ignored.
    let mut spoofed = axum::http::HeaderMap::new();
    spoofed.insert("x-wabi-pipe-auth", "forged".parse().unwrap());
    spoofed.insert("x-wabi-pipe-client", "127.0.0.1:1".parse().unwrap());
    let key = state.tailcat.rate_limit_key(&spoofed, &peer);
    assert_eq!(key, "127.0.0.1", "spoofed pipe headers must not be trusted");

    // Validated forwarder request: keyed by the pipe client identity, so two
    // family members are two buckets instead of one collapsed 127.0.0.1.
    let mut piped = axum::http::HeaderMap::new();
    piped.insert(
        "x-wabi-pipe-auth",
        state.tailcat.pipe_auth_token_for_tests().parse().unwrap(),
    );
    piped.insert("x-wabi-pipe-client", "127.0.0.1:41000".parse().unwrap());
    let key = state.tailcat.rate_limit_key(&piped, &peer);
    assert_eq!(key, "pipe:127.0.0.1:41000");
}

#[tokio::test]
async fn http_surface_admin_gating_and_member_connect() {
    let tmp = tempfile::tempdir().unwrap();
    let state = open(&tmp.path().join("data")).await;
    let secret = state.config.jwt_secret.clone();
    let app: axum::Router = api::routes(state.clone()).with_state(state.clone());

    // Unauthenticated status: rejected.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);

    // Non-admin: forbidden even with a valid token.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/status")
                .header(
                    "authorization",
                    format!("Bearer {}", mint_token(&secret, "2")),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // Admin: 200.
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/status")
                .header(
                    "authorization",
                    format!("Bearer {}", mint_token(&secret, "1")),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);

    // Populated admin views must match the browser contract without changing JSON storage.
    state
        .tailcat
        .register_key(7, "7".repeat(64), Some("Field laptop".into()))
        .await
        .unwrap();
    for path in ["/status", "/keys"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .header(
                        "authorization",
                        format!("Bearer {}", mint_token(&secret, "1")),
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let key = &value["keys"][0];
        assert_eq!(key["userId"], 7);
        assert!(key["publicKey"]
            .as_str()
            .unwrap()
            .ends_with(&"7".repeat(64)));
        assert!(key["createdAt"].is_string());
        assert_eq!(key["allowed"], true);
        assert!(key.get("public_key").is_none());
    }

    // Enable without confirm body: refused (cognitive-friction contract).
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/enable")
                .header(
                    "authorization",
                    format!("Bearer {}", mint_token(&secret, "1")),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::BAD_REQUEST);

    // Member connect info: authenticated, but no address while disabled.
    let res = app
        .oneshot(
            Request::builder()
                .uri("/connect")
                .header(
                    "authorization",
                    format!("Bearer {}", mint_token(&secret, "99")),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["enabled"], false);
    assert_eq!(json["registered"], false);
    assert!(json["address"].is_null());
}

/// Even authentic transport tagging does not grant an account or admin role.
#[tokio::test]
async fn valid_pipe_tag_never_grants_account_or_admin_authorization() {
    let tmp = tempfile::tempdir().unwrap();
    let state = open(&tmp.path().join("data")).await;
    let app: axum::Router = api::routes(state.clone()).with_state(state.clone());
    let token = state.tailcat.pipe_auth_token_for_tests();
    let routes = [
        ("GET", "/status", "{}"),
        ("GET", "/keys", "{}"),
        ("POST", "/enable", r#"{"confirm":true}"#),
        ("POST", "/disable", "{}"),
        ("PUT", "/port", r#"{"pipePort":45678}"#),
        ("PUT", "/keys/test/access", r#"{"allowed":true}"#),
        ("DELETE", "/keys/test", "{}"),
    ];
    for (method, path, body) in routes {
        for authenticated in [false, true] {
            let mut request = Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .header("x-wabi-pipe-auth", token)
                .header("x-wabi-pipe-client", "127.0.0.1:41000");
            if authenticated {
                request = request.header(
                    "authorization",
                    format!("Bearer {}", mint_token(&state.config.jwt_secret, "2")),
                );
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::from(body)).unwrap())
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                if authenticated {
                    StatusCode::FORBIDDEN
                } else {
                    StatusCode::UNAUTHORIZED
                },
                "{method} {path}, authenticated={authenticated}"
            );
        }
    }
    let response = app
        .oneshot(
            Request::builder()
                .uri("/connect")
                .header("x-wabi-pipe-auth", token)
                .header("x-wabi-pipe-client", "127.0.0.1:41000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

// Characterization, not a policy recommendation: registration currently accepts
// every AuthUser variant and automatically admits new device keys.
#[tokio::test]
async fn enrollment_is_self_service_for_guest_and_bot_auth_users() {
    use wabidb::engine::wabi_store::WabiStore;
    let tmp = tempfile::tempdir().unwrap();
    let state = open(tmp.path()).await;
    let bot_id = state
        .wdb
        .create_user("enrollment-bot", None, "unused")
        .await
        .unwrap();
    let (bot_token, _) = state.bot_registry.create(bot_id).await;
    let guest_claims = serde_json::json!({
        "sub": "77", "username": "guest", "is_guest": true,
        "exp": 9999999999i64, "iat": 0, "jti": "guest-enrollment", "token_type": "access"
    });
    let guest_token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &guest_claims,
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap();
    let app = api::routes(state.clone()).with_state(state.clone());
    for (credential, digit, user_id) in [
        (format!("Bearer {guest_token}"), 'a', 77),
        (format!("Bot {bot_token}"), 'b', bot_id as i64),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/keys")
                    .header("authorization", credential)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({"publicKey": digit.to_string().repeat(64)}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(state
            .tailcat
            .keys()
            .iter()
            .any(|k| k.user_id == user_id && k.allowed));
    }
    assert!(
        !state.tailcat.status().await.enabled,
        "enrollment alone does not enable transport"
    );
}
