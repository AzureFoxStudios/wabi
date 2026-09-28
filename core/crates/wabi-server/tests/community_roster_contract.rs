//! A second entry point is a credential destination only after owner approval.

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
use wabidb::engine::wabi_store::WabiStore;

fn config(path: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "community-roster-test-secret".into(),
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
    }
}

fn token(id: u64, secret: &str, stepup: bool, guest: bool) -> String {
    let now = chrono::Utc::now().timestamp();
    let claims = JwtClaims {
        sub: id.to_string(),
        username: format!("user-{id}"),
        is_guest: guest,
        exp: now + 3600,
        iat: now,
        jti: uuid::Uuid::new_v4().to_string(),
        stepup,
        token_type: if stepup { "stepup" } else { "access" }.into(),
    };
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

async fn call(
    app: &Router,
    method: &str,
    bearer: Option<&str>,
    stepup: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri("/community/roster")
        .header("content-type", "application/json");
    if let Some(token) = bearer {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    if let Some(token) = stepup {
        request = request.header("x-stepup-token", token);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn roster_requires_owner_stepup_and_rejects_stale_or_fenced_writes() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(config(dir.path())).await.unwrap());
    let owner = state
        .wdb
        .create_user("owner", None, "registered-hash")
        .await
        .unwrap();
    let member = state
        .wdb
        .create_user("member", None, "registered-hash")
        .await
        .unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    let app = create_api_router(state.clone()).with_state(state.clone());
    let owner_access = token(owner, &state.config.jwt_secret, false, false);
    let owner_stepup = token(owner, &state.config.jwt_secret, true, false);
    let member_access = token(member, &state.config.jwt_secret, false, false);
    let update = json!({"expectedVersion": 0, "entries": [
        {"nodeId": "a", "role": "authority", "url": "https://a.example"},
        {"nodeId": "b", "role": "anchor", "url": "https://b.example"}
    ]});

    assert_eq!(
        call(&app, "GET", Some(&owner_access), None, Value::Null)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            "PUT",
            Some(&member_access),
            Some(&owner_stepup),
            update.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, "PUT", Some(&owner_access), None, update.clone())
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, roster) = call(
        &app,
        "PUT",
        Some(&owner_access),
        Some(&owner_stepup),
        update.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(roster["body"]["version"], 1);
    assert_eq!(roster["body"]["entries"][1]["url"], "https://b.example");
    assert_eq!(
        call(&app, "GET", Some(&member_access), None, Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            "PUT",
            Some(&owner_access),
            Some(&owner_stepup),
            update
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "GET",
            Some(&token(member, &state.config.jwt_secret, false, true)),
            None,
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    state.wdb.engine().fence_local_writer().await.unwrap();
    let next = json!({"expectedVersion": 1, "entries": [
        {"nodeId": "a", "role": "authority", "url": "https://a.example"}
    ]});
    assert_eq!(
        call(&app, "PUT", Some(&owner_access), Some(&owner_stepup), next)
            .await
            .0,
        StatusCode::CONFLICT
    );
}
