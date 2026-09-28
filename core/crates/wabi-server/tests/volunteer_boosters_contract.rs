use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
use wabidb::{
    domain::{ChannelKind, MemberRole},
    engine::wabi_store::WabiStore,
};
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

#[tokio::test]
async fn voluntary_sessions_authorization_identity_stop_and_fallback_contract() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, source) = seed(&state).await;
    let recipient = state
        .wdb
        .create_user("recipient", None, "registered")
        .await
        .unwrap();
    let stranger = state
        .wdb
        .create_user("stranger", None, "registered")
        .await
        .unwrap();
    let auth = |id| sign(&state, &serde_json::to_value(claims(id)).unwrap());
    let owner_token = auth(owner);
    let source_token = auth(source);
    let recipient_token = auth(recipient);
    let stranger_token = auth(stranger);
    let app = create_api_router(state.clone()).with_state(state.clone());
    macro_rules! call {
        ($method:expr,$path:expr,$token:expr,$body:expr) => {
            request(&app, $method, $path, $token, $body, &[])
        };
    }
    assert_eq!(
        call!("GET", "/admin/network-health", Some(&source_token), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let health = call!("GET", "/admin/network-health", Some(&owner_token), None).await;
    assert_eq!(health.0, StatusCode::OK);
    assert!(health.1["processCpuPercent"].is_null());
    assert_eq!(
        call!("GET", "/boosters/status", None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call!("GET", "/boosters/status", Some(&source_token), None)
            .await
            .1["enabled"],
        false
    );
    let start = json!({"consent":true,"name":"Voluntary laptop","uploadKiBPerSecond":512,"cacheMiB":8,"sessionMiB":8});
    assert_eq!(
        call!(
            "POST",
            "/boosters/sessions",
            Some(&source_token),
            Some(start.clone())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(
            "PUT",
            "/boosters/policy",
            Some(&source_token),
            Some(json!({"enabled":true}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(
            "PUT",
            "/boosters/policy",
            Some(&owner_token),
            Some(json!({"enabled":true}))
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut no_consent = start.clone();
    no_consent["consent"] = json!(false);
    assert_eq!(
        call!(
            "POST",
            "/boosters/sessions",
            Some(&source_token),
            Some(no_consent)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut excessive_rate = start.clone();
    excessive_rate["uploadKiBPerSecond"] = json!(8193);
    assert_eq!(
        call!(
            "POST",
            "/boosters/sessions",
            Some(&source_token),
            Some(excessive_rate)
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut guest_claims = claims(source);
    guest_claims.is_guest = true;
    let guest_token = sign(&state, &serde_json::to_value(guest_claims).unwrap());
    assert_eq!(
        call!(
            "POST",
            "/boosters/sessions",
            Some(&guest_token),
            Some(start.clone())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let created = call!(
        "POST",
        "/boosters/sessions",
        Some(&source_token),
        Some(start)
    )
    .await;
    assert_eq!(created.0, StatusCode::OK);
    let id = created.1["id"].as_str().unwrap();
    let channel = state
        .wdb
        .create_channel("files", ChannelKind::Text, owner, false)
        .await
        .unwrap();
    for uid in [source, recipient] {
        state
            .wdb
            .add_channel_member(&channel, uid, MemberRole::Member)
            .await
            .unwrap();
    }
    tokio::fs::create_dir_all(&state.config.uploads_dir)
        .await
        .unwrap();
    tokio::fs::write(
        std::path::Path::new(&state.config.uploads_dir).join("fixture.bin"),
        b"original bytes",
    )
    .await
    .unwrap();
    state
        .upload_registry
        .record(
            "fixture.bin",
            "fixture.bin",
            Some(channel.clone()),
            Some(source as i64),
            wabi_server::upload_registry::UploadKind::Attachment,
            14,
        )
        .await.unwrap();
    let query = json!({"path":"/uploads/fixture.bin"});
    assert_eq!(
        call!(
            "POST",
            "/boosters/file",
            Some(&stranger_token),
            Some(query.clone())
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let descriptor = call!(
        "POST",
        "/boosters/file",
        Some(&source_token),
        Some(query.clone())
    )
    .await;
    assert_eq!(descriptor.0, StatusCode::OK);
    let file = descriptor.1["file"].clone();
    let heartbeat = format!("/boosters/sessions/{id}/heartbeat");
    assert_eq!(
        call!(
            "POST",
            &heartbeat,
            Some(&stranger_token),
            Some(json!({"files":[file.clone()],"sentBytes":0}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(
            "POST",
            &heartbeat,
            Some(&source_token),
            Some(json!({"files":[file.clone()],"sentBytes":0}))
        )
        .await
        .0,
        StatusCode::OK
    );
    for invalid_inventory in [
        json!({"files":vec![file.clone(); 17],"sentBytes":0}),
        json!({"files":[file.clone(),file.clone()],"sentBytes":0}),
        json!({"files":[file.clone()],"sentBytes":8*1048576+1}),
    ] {
        assert_eq!(
            call!(
                "POST",
                &heartbeat,
                Some(&source_token),
                Some(invalid_inventory)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let available = call!(
        "POST",
        "/boosters/file",
        Some(&recipient_token),
        Some(query.clone())
    )
    .await;
    assert_eq!(available.1["candidates"][0], id);
    let offer = json!({"source":id,"path":"/uploads/fixture.bin","offer":"fixture-sdp"});
    let ticket = call!(
        "POST",
        "/boosters/tickets",
        Some(&recipient_token),
        Some(offer)
    )
    .await;
    assert_eq!(ticket.0, StatusCode::OK);
    let ticket_id = ticket.1["id"].as_str().unwrap();
    let ticket_path = format!("/boosters/tickets/{ticket_id}");
    assert_eq!(
        call!("GET", &ticket_path, Some(&stranger_token), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(
            "POST",
            &format!("{ticket_path}/answer"),
            Some(&recipient_token),
            Some(json!({"answer":"x"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(
            "POST",
            &format!("{ticket_path}/answer"),
            Some(&source_token),
            Some(json!({"answer":"fixture-answer"}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call!(
            "POST",
            &format!("{ticket_path}/receipt"),
            Some(&recipient_token),
            Some(json!({"hash":"wrong"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    for _ in 0..2 {
        assert_eq!(
            call!(
                "POST",
                &format!("{ticket_path}/receipt"),
                Some(&recipient_token),
                Some(json!({"hash":file["hash"]}))
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        call!("GET", "/boosters/admin", Some(&owner_token), None)
            .await
            .1["completedTransfers"],
        1
    );
    let stop = format!("/boosters/sessions/{id}");
    assert_eq!(
        call!("DELETE", &stop, Some(&stranger_token), None).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!("DELETE", &stop, Some(&source_token), None).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call!("GET", &ticket_path, Some(&recipient_token), None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(
            "POST",
            "/boosters/file",
            Some(&recipient_token),
            Some(query.clone())
        )
        .await
        .1["candidates"],
        json!([])
    );
    state
        .upload_registry
        .revoke_canonical("fixture.bin", state.wdb.engine(), 0)
        .await
        .unwrap();
    assert_eq!(
        call!(
            "POST",
            "/boosters/file",
            Some(&recipient_token),
            Some(query)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let dm = state
        .wdb
        .create_channel("private", ChannelKind::Dm, source, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&dm, source, MemberRole::Member)
        .await
        .unwrap();
    tokio::fs::write(
        std::path::Path::new(&state.config.uploads_dir).join("private.bin"),
        b"private",
    )
    .await
    .unwrap();
    state
        .upload_registry
        .record(
            "private.bin",
            "private.bin",
            Some(dm),
            Some(source as i64),
            wabi_server::upload_registry::UploadKind::Attachment,
            7,
        )
        .await.unwrap();
    assert_eq!(
        call!(
            "POST",
            "/boosters/file",
            Some(&source_token),
            Some(json!({"path":"/uploads/private.bin"}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call!(
            "PUT",
            "/boosters/policy",
            Some(&owner_token),
            Some(json!({"enabled":false}))
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call!("GET", "/boosters/admin", Some(&owner_token), None)
            .await
            .1["sessions"],
        json!([])
    );
}
