//! Account credentials must not cross into helper administration through a
//! weaker decoder. All accounts, pairing secrets and snapshots are fixtures.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    standby::{
        crypto::{generate_standby_identity, recipient_to_string},
        encrypt_to_recipient_b64, EncryptedSnapshotEnvelope, SnapshotManifest,
        SNAPSHOT_ENCRYPTION_ALGORITHM,
    },
    state::{AppState, RevocationStore},
};
use wabidb::engine::wabi_store::WabiStore;

async fn server(path: &Path) -> Arc<AppState> {
    Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "helper-admin-auth-contract-only".into(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
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

async fn seed(state: &AppState) -> (u64, u64) {
    let owner = state
        .wdb
        .create_user("owner", None, "registered-test-hash")
        .await
        .unwrap();
    let member = state
        .wdb
        .create_user("member", None, "registered-test-hash")
        .await
        .unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    (owner, member)
}

fn claims(uid: u64) -> JwtClaims {
    let now = chrono::Utc::now().timestamp();
    JwtClaims {
        sub: uid.to_string(),
        username: format!("user-{uid}"),
        is_guest: false,
        exp: now + 3600,
        iat: now,
        jti: uuid::Uuid::new_v4().to_string(),
        stepup: false,
        token_type: "access".into(),
    }
}

fn sign(state: &AppState, payload: &Value) -> String {
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        payload,
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap()
}

async fn request(
    app: &Router,
    method: &str,
    path: &str,
    bearer: Option<&str>,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = bearer {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    for (name, value) in headers {
        req = req.header(*name, *value);
    }
    let response = app
        .clone()
        .oneshot(
            req.body(Body::from(
                body.map(|value| value.to_string()).unwrap_or_default(),
            ))
            .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"body": String::from_utf8_lossy(&bytes)}));
    (status, value)
}

fn privileged_routes() -> Vec<(&'static str, &'static str, Option<Value>)> {
    vec![
        ("GET", "/nodes", None),
        ("GET", "/nodes/pairing-tokens", None),
        (
            "POST",
            "/nodes/pairing-tokens",
            Some(json!({"label":"fixture", "capabilities":["standby"]})),
        ),
        ("GET", "/nodes/media-advertisements", None),
        ("POST", "/nodes/fixture-node/revoke", None),
        ("GET", "/standby/status", None),
        (
            "POST",
            "/standby/snapshots/export",
            Some(json!({"recipientNodeId":"fixture-node"})),
        ),
        ("POST", "/standby/snapshots/import", None),
        ("POST", "/standby/promote", None),
    ]
}

async fn assert_all_denied(app: &Router, bearer: Option<&str>) {
    for (method, path, body) in privileged_routes() {
        let (status, _) = request(app, method, path, bearer, body, &[]).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
    }
}

#[tokio::test]
async fn every_helper_admin_route_requires_an_account_access_credential() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, member) = seed(&state).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    assert_all_denied(&app, None).await;
    assert_all_denied(&app, Some("malformed.jwt")).await;
    let mut denied = vec![serde_json::to_value(claims(member)).unwrap()];
    for kind in ["refresh", "lore", "unknown"] {
        let mut payload = serde_json::to_value(claims(owner)).unwrap();
        payload["token_type"] = json!(kind);
        denied.push(payload);
    }
    for kind in [Some("access"), Some(""), None] {
        let mut payload = serde_json::to_value(claims(owner)).unwrap();
        payload["stepup"] = json!(true);
        if let Some(kind) = kind {
            payload["token_type"] = json!(kind);
        } else {
            payload.as_object_mut().unwrap().remove("token_type");
        }
        denied.push(payload);
    }
    let mut expired = serde_json::to_value(claims(owner)).unwrap();
    expired["exp"] = json!(1_500_000_000_i64);
    denied.push(expired);
    for payload in denied {
        assert_all_denied(&app, Some(&sign(&state, &payload))).await;
    }
    assert!(
        state.node_registry.list_pairing_tokens().await.is_empty(),
        "denied requests must not create pairing credentials"
    );
}

#[tokio::test]
async fn owner_and_current_admin_access_and_legacy_tokens_work() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, admin) = seed(&state).await;
    state
        .wdb
        .ingest_event(
            "rbac",
            "assign_role",
            &json!({
                "workspaceId":"default-workspace", "userId":admin, "role":"Admin"
            }),
        )
        .await
        .unwrap();
    assert!(state.is_admin(admin as i64).await);
    let app = create_api_router(state.clone()).with_state(state.clone());
    for uid in [owner, admin] {
        for kind in [Some("access"), Some(""), None] {
            let mut payload = serde_json::to_value(claims(uid)).unwrap();
            if let Some(kind) = kind {
                payload["token_type"] = json!(kind);
            } else {
                payload.as_object_mut().unwrap().remove("token_type");
                payload.as_object_mut().unwrap().remove("stepup");
            }
            let token = sign(&state, &payload);
            for path in [
                "/nodes",
                "/nodes/pairing-tokens",
                "/nodes/media-advertisements",
                "/standby/status",
            ] {
                let (status, _) = request(&app, "GET", path, Some(&token), None, &[]).await;
                assert_eq!(status, StatusCode::OK, "{path}");
            }
        }
    }
    let token = sign(&state, &serde_json::to_value(claims(admin)).unwrap());
    state
        .wdb
        .ingest_event(
            "rbac",
            "assign_role",
            &json!({
                "workspaceId":"default-workspace", "userId":admin, "role":"Member"
            }),
        )
        .await
        .unwrap();
    assert!(!state.is_admin(admin as i64).await);
    assert_all_denied(&app, Some(&token)).await;
}

#[tokio::test]
async fn token_account_and_global_revocation_apply_to_every_helper_admin_route() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, _) = seed(&state).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let payload = claims(owner);
    let token = sign(&state, &serde_json::to_value(&payload).unwrap());
    for kind in ["token", "account", "password", "global"] {
        let mut revoked = RevocationStore::default();
        match kind {
            "token" => {
                revoked.jtis.insert(payload.jti.clone(), payload.exp as u64);
            }
            "account" => {
                revoked.users.insert(owner as i64);
            }
            "password" => {
                revoked
                    .user_iat_revoked
                    .insert(owner as i64, (payload.iat + 1) as u64);
            }
            "global" => revoked.epoch = (payload.iat + 1) as u64,
            _ => unreachable!(),
        }
        *state.revocations.write().await = revoked;
        assert_all_denied(&app, Some(&token)).await;
    }
}

#[tokio::test]
async fn paired_node_secrets_still_work_and_standby_remains_explicitly_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, _) = seed(&state).await;
    let token = sign(&state, &serde_json::to_value(claims(owner)).unwrap());
    let app = create_api_router(state.clone()).with_state(state.clone());
    let (status, pairing) = request(
        &app,
        "POST",
        "/nodes/pairing-tokens",
        Some(&token),
        Some(json!({"label":"standby fixture", "capabilities":["standby"]})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let recipient = recipient_to_string(&generate_standby_identity());
    let (status, joined) = request(
        &app,
        "POST",
        "/nodes/join",
        None,
        Some(json!({
            "token":pairing["token"], "displayName":"fixture", "publicKey":recipient,
            "reachability":"outbound_only"
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let node_id = joined["node"]["nodeId"].as_str().unwrap();
    let node_secret = joined["nodeSecret"].as_str().unwrap();
    let heartbeat = format!("/nodes/{node_id}/heartbeat");
    let node_headers = [
        ("x-wabi-node-id", node_id),
        ("x-wabi-node-secret", node_secret),
    ];
    assert_eq!(
        request(
            &app,
            "POST",
            &heartbeat,
            None,
            Some(json!({})),
            &node_headers
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, "POST", &heartbeat, Some(&token), Some(json!({})), &[])
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "POST",
            &heartbeat,
            None,
            Some(json!({})),
            &[("x-wabi-node-secret", "wrong")]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );

    let encrypted_payload_b64 =
        encrypt_to_recipient_b64(b"isolated encrypted fixture", &recipient).unwrap();
    let manifest = SnapshotManifest::new_live_state(
        "test",
        node_id,
        &BASE64.decode(&encrypted_payload_b64).unwrap(),
        SNAPSHOT_ENCRYPTION_ALGORITHM,
    );
    let envelope = serde_json::to_value(EncryptedSnapshotEnvelope {
        manifest,
        encrypted_payload_b64,
    })
    .unwrap();
    assert_eq!(
        request(
            &app,
            "POST",
            "/standby/snapshots",
            Some(&token),
            Some(envelope.clone()),
            &[]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/standby/snapshots",
            None,
            Some(envelope.clone()),
            &node_headers
        )
        .await
        .0,
        StatusCode::OK
    );
    let (status, readiness) =
        request(&app, "GET", "/standby/status", Some(&token), None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(readiness["snapshotReceiveReady"], true);
    for field in [
        "snapshotExportReady",
        "manualRestoreReady",
        "manualPromotionReady",
        "automaticFailover",
    ] {
        assert_eq!(readiness[field], false, "{field}");
    }
    for path in [
        "/standby/snapshots/export",
        "/standby/snapshots/import",
        "/standby/promote",
    ] {
        let (status, body) = request(
            &app,
            "POST",
            path,
            Some(&token),
            Some(json!({"recipientNodeId":node_id})),
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::NOT_IMPLEMENTED, "{path}");
        assert_eq!(body["automaticFailover"], false);
    }
    assert_eq!(
        request(
            &app,
            "POST",
            &format!("/nodes/{node_id}/revoke"),
            Some(&token),
            None,
            &[]
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            "POST",
            &heartbeat,
            None,
            Some(json!({})),
            &node_headers
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/standby/snapshots",
            None,
            Some(envelope),
            &node_headers
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}
