//! Authority field pilot: opt-in, consent, precise-report ACL, and purge.
use axum::{
    body::{to_bytes, Body},
    http::{HeaderMap, Method, Request, StatusCode},
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
            jwt_secret: "field-pilot-contract-only".into(),
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
) -> (StatusCode, Value, HeaderMap) {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !token.is_empty() {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(builder.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value, headers)
}

fn assert_no_store(headers: &HeaderMap) {
    assert_eq!(headers.get("cache-control").unwrap(), "no-store, private");
    assert_eq!(headers.get("referrer-policy").unwrap(), "no-referrer");
}

#[tokio::test]
async fn field_routes_require_operator_opt_in_and_consent_then_purge_reports() {
    std::env::remove_var("WABI_FIELD_PILOT");
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let owner = state
        .wdb
        .create_user("field_owner", None, "registered-hash")
        .await
        .unwrap();
    let invited = state
        .wdb
        .create_user("field_invited", None, "registered-hash")
        .await
        .unwrap();
    let other_invited = state
        .wdb
        .create_user("field_other", None, "registered-hash")
        .await
        .unwrap();
    let outsider = state
        .wdb
        .create_user("field_outsider", None, "registered-hash")
        .await
        .unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    state.wdb.ingest_event("rbac", "assign_role", &json!({
        "userId": outsider, "workspaceId": "default-workspace", "role": "Admin", "assignedBy": owner
    })).await.unwrap();
    assert!(state.is_admin(outsider as i64).await);
    let owner_token = token(&state, owner);
    let invited_token = token(&state, invited);
    let other_token = token(&state, other_invited);
    let outsider_token = token(&state, outsider);

    let disabled = create_api_router(state.clone()).with_state(state.clone());
    let (status, _, headers) =
        call(&disabled, Method::GET, "/field/capability", "", json!(null)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_no_store(&headers);
    assert_eq!(
        call(
            &disabled,
            Method::GET,
            "/field/sessions",
            &owner_token,
            json!(null)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    std::env::set_var("WABI_FIELD_PILOT", "1");
    let app = create_api_router(state.clone()).with_state(state.clone());
    let (status, capability, headers) =
        call(&app, Method::GET, "/field/capability", "", json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(capability, json!({"enabled":true}));
    assert_no_store(&headers);
    assert_eq!(
        call(&app, Method::GET, "/field/sessions", "", json!(null))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );

    let create = json!({"title":"Trail practice","participantIds":[invited,other_invited],"durationMinutes":30});
    assert_eq!(
        call(
            &app,
            Method::POST,
            "/field/sessions",
            &invited_token,
            create.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (status, created, headers) =
        call(&app, Method::POST, "/field/sessions", &owner_token, create).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_no_store(&headers);
    let id = created["session"]["id"].as_str().unwrap();
    let detail = format!("/field/sessions/{id}");
    assert_eq!(
        call(
            &app,
            Method::POST,
            "/field/sessions",
            &owner_token,
            json!({"title":"Repeated tap","participantIds":[invited],"durationMinutes":30})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        created["session"]["participants"].as_array().unwrap().len(),
        3
    );
    let (status, _, headers) = call(&app, Method::GET, &detail, &invited_token, json!(null)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_no_store(&headers);
    assert_eq!(
        call(&app, Method::GET, &detail, &outsider_token, json!(null))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("{detail}/checkins"),
            &invited_token,
            json!({"nonce":"early","status":"help"})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("{detail}/consent"),
            &outsider_token,
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let (status, outsider_list, _) = call(
        &app,
        Method::GET,
        "/field/sessions",
        &outsider_token,
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(outsider_list, json!({"sessions":[],"invitations":[]}));
    let (_, invitation_list, _) = call(
        &app,
        Method::GET,
        "/field/sessions",
        &invited_token,
        json!(null),
    )
    .await;
    assert_eq!(invitation_list["sessions"], json!([]));
    assert_eq!(
        invitation_list["invitations"][0],
        json!({"id":id,"title":"Trail practice","leaderUserId":owner,"expiresAt":created["session"]["expiresAt"]})
    );

    let (status, consented, _) = call(
        &app,
        Method::POST,
        &format!("{detail}/consent"),
        &invited_token,
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let visible: Vec<u64> = consented["session"]["participants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["userId"].as_u64().unwrap())
        .collect();
    assert_eq!(
        visible,
        vec![owner, invited],
        "a member cannot see another pending invitee"
    );
    let (status, help, headers) = call(
        &app,
        Method::POST,
        &format!("{detail}/checkins"),
        &invited_token,
        json!({"nonce":"help-1","status":"help","x":0.2,"y":0.3}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_no_store(&headers);
    let help_id = help["receipt"]["checkinId"].as_str().unwrap();
    assert_eq!(help["receipt"]["duplicate"], false);
    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("{detail}/checkins"),
            &invited_token,
            json!({"nonce":"help-2","status":"help"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (status, okay, _) = call(
        &app,
        Method::POST,
        &format!("{detail}/checkins"),
        &invited_token,
        json!({"nonce":"okay-1","status":"okay"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let p = &okay["session"]["participants"][1];
    assert_eq!(p["lastCheckin"]["status"], "okay");
    assert_eq!(p["pendingHelp"]["id"], help_id);
    assert_eq!(p["lastPosition"]["x"], 0.2);
    let (_, retry, _) = call(
        &app,
        Method::POST,
        &format!("{detail}/checkins"),
        &invited_token,
        json!({"nonce":"help-1","status":"help","x":0.2,"y":0.3}),
    )
    .await;
    assert_eq!(retry["receipt"]["duplicate"], true);
    assert_eq!(retry["receipt"]["checkinId"], help_id);
    assert_eq!(
        retry["session"]["participants"][1]["lastCheckin"]["status"],
        "okay"
    );
    let ack_path = format!("{detail}/checkins/{help_id}/ack");
    assert_eq!(
        call(&app, Method::POST, &ack_path, &invited_token, json!({}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let (status, acked, _) = call(&app, Method::POST, &ack_path, &owner_token, json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        acked["session"]["participants"][1]["pendingHelp"],
        Value::Null
    );
    assert_eq!(
        acked["session"]["participants"][1]["lastHelpAcknowledgement"]["id"],
        help_id
    );
    assert!(
        acked["session"]["participants"][1]["lastHelpAcknowledgement"]["acknowledgedAt"]
            .as_i64()
            .is_some()
    );
    assert_eq!(
        call(&app, Method::POST, &ack_path, &owner_token, json!({}))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("{detail}/end"),
            &invited_token,
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("{detail}/participants/{invited}/revoke"),
            &invited_token,
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("{detail}/participants/{invited}/revoke"),
            &owner_token,
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, Method::GET, &detail, &invited_token, json!(null))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("{detail}/checkins"),
            &invited_token,
            json!({"nonce":"after-revoke","status":"okay"})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("{detail}/consent"),
            &other_token,
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("{detail}/leave"),
            &other_token,
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, Method::GET, &detail, &other_token, json!(null))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            Method::POST,
            &format!("{detail}/end"),
            &owner_token,
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, Method::GET, &detail, &owner_token, json!(null))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let sidecar = dir.path().join("field_sessions_v1.json");
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&sidecar).unwrap()).unwrap()["sessions"],
        json!([])
    );

    let (status, created, _) = call(
        &app,
        Method::POST,
        "/field/sessions",
        &owner_token,
        json!({"title":"Expiry practice","participantIds":[invited],"durationMinutes":5}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let expired_id = created["session"]["id"].as_str().unwrap();
    let mut stored: Value = serde_json::from_slice(&std::fs::read(&sidecar).unwrap()).unwrap();
    stored["sessions"][0]["createdAt"] = json!(chrono::Utc::now().timestamp_millis() - 60_000);
    stored["sessions"][0]["expiresAt"] = json!(chrono::Utc::now().timestamp_millis() - 1);
    std::fs::write(&sidecar, serde_json::to_vec(&stored).unwrap()).unwrap();
    assert_eq!(
        call(
            &app,
            Method::GET,
            &format!("/field/sessions/{expired_id}"),
            &owner_token,
            json!(null)
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&sidecar).unwrap()).unwrap()["sessions"],
        json!([])
    );
    std::fs::write(&sidecar, b"{broken").unwrap();
    assert_eq!(
        call(
            &app,
            Method::GET,
            "/field/sessions",
            &owner_token,
            json!(null)
        )
        .await
        .0,
        StatusCode::INTERNAL_SERVER_ERROR
    );
    assert_eq!(std::fs::read(&sidecar).unwrap(), b"{broken");
    std::env::remove_var("WABI_FIELD_PILOT");
}
