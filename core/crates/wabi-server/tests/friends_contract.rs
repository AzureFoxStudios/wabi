//! Friend relationships are authenticated, scoped and replayed from WabiDB.
use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
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

async fn server(path: &Path) -> Arc<AppState> {
    Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "friends-contract-only".into(),
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

fn token(state: &AppState, user_id: u64) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: user_id.to_string(),
            username: format!("user-{user_id}"),
            is_guest: false,
            exp: now + 3600,
            iat: now,
            jti: uuid::Uuid::new_v4().to_string(),
            stepup: false,
            token_type: "access".into(),
        },
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .unwrap()
}

async fn call(
    app: &Router,
    method: Method,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !token.is_empty() {
        request = request.header("authorization", format!("Bearer {token}"));
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
async fn requests_acceptance_removal_and_restart_are_scoped_to_the_pair() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let first = state
        .wdb
        .create_user("first", None, "registered-hash")
        .await
        .unwrap();
    let second = state
        .wdb
        .create_user("second", None, "registered-hash")
        .await
        .unwrap();
    let outsider = state
        .wdb
        .create_user("outsider", None, "registered-hash")
        .await
        .unwrap();
    let bot = state
        .wdb
        .create_user("friends_bot", None, "dummy-bot-hash")
        .await
        .unwrap();
    state.bot_registry.create(bot).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let first_token = token(&state, first);
    let second_token = token(&state, second);
    let outsider_token = token(&state, outsider);
    let bot_token = token(&state, bot);
    let request_id = format!("friend-{}-{}", first.min(second), first.max(second));

    assert_eq!(
        call(&app, Method::GET, "/friends", "", json!(null)).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            "/friends/requests",
            &first_token,
            json!({"user_id": first})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            "/friends/requests",
            &first_token,
            json!({"user_id": 999999u64})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&app, Method::POST, "/friends/requests", &first_token, json!({"user_id": bot})).await.0,
        StatusCode::NOT_FOUND,
        "bot accounts are not friend candidates"
    );
    assert_eq!(
        call(&app, Method::GET, "/friends", &bot_token, json!(null)).await.0,
        StatusCode::FORBIDDEN,
        "bots cannot use a forged account bearer token to access friends"
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            "/friends/requests",
            &first_token,
            json!({"user_id": second})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            "/friends/requests",
            &first_token,
            json!({"user_id": second})
        )
        .await
        .0,
        StatusCode::OK
    );

    let (_, first_list) = call(&app, Method::GET, "/friends", &first_token, json!(null)).await;
    let (_, second_list) = call(&app, Method::GET, "/friends", &second_token, json!(null)).await;
    let (_, outsider_list) =
        call(&app, Method::GET, "/friends", &outsider_token, json!(null)).await;
    assert_eq!(first_list["outgoing"][0]["id"], request_id);
    assert_eq!(first_list["outgoing"][0]["user_id"], second);
    assert_eq!(second_list["incoming"][0]["user_id"], first);
    assert_eq!(outsider_list["incoming"], json!([]));
    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("/friends/requests/{request_id}/accept"),
            &outsider_token,
            json!(null)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("/friends/requests/{request_id}/accept"),
            &first_token,
            json!(null)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("/friends/requests/{request_id}/accept"),
            &second_token,
            json!(null)
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, first_list) = call(&app, Method::GET, "/friends", &first_token, json!(null)).await;
    assert_eq!(first_list["friends"][0]["user_id"], second);
    assert_eq!(first_list["incoming"], json!([]));

    let config = state.config.clone();
    drop(app);
    drop(state);
    let reopened = Arc::new(AppState::new(config).await.unwrap());
    let app = create_api_router(reopened.clone()).with_state(reopened.clone());
    let (_, second_list) = call(&app, Method::GET, "/friends", &second_token, json!(null)).await;
    assert_eq!(
        second_list["friends"][0]["user_id"], first,
        "accepted state survives replay"
    );
    assert_eq!(
        call(
            &app,
            Method::DELETE,
            &format!("/friends/{second}"),
            &outsider_token,
            json!(null)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            Method::DELETE,
            &format!("/friends/{second}"),
            &first_token,
            json!(null)
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, second_list) = call(&app, Method::GET, "/friends", &second_token, json!(null)).await;
    assert_eq!(second_list["friends"], json!([]));
    assert_eq!(
        call(
            &app,
            Method::POST,
            "/friends/requests",
            &second_token,
            json!({"user_id": first})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            Method::DELETE,
            &format!("/friends/requests/{request_id}"),
            &first_token,
            json!(null)
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, second_list) = call(&app, Method::GET, "/friends", &second_token, json!(null)).await;
    assert_eq!(second_list["outgoing"], json!([]));
}
