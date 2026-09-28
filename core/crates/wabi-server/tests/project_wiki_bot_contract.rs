//! A project bot uses the ordinary wiki API and channel permission boundary.
use std::{path::Path, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};

fn jwt(state: &AppState, uid: u64) -> String {
    let now = chrono::Utc::now().timestamp();
    let token = jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: uid.to_string(),
            username: format!("user-{uid}"),
            is_guest: false,
            exp: now + 3600,
            iat: now,
            jti: uuid::Uuid::new_v4().to_string(),
            stepup: false,
            token_type: "access".into(),
        },
        &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    ).unwrap();
    format!("Bearer {token}")
}
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
            jwt_secret: "project-wiki-bot-test-only".into(),
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

async fn request(
    app: &Router,
    method: Method,
    path: &str,
    credential: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", credential)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))),
    )
}

#[tokio::test]
async fn bot_wiki_access_follows_project_membership_and_token_revocation() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let human = state.wdb.create_user("project-human", None, "test-hash").await.unwrap();
    state.wdb.claim_owner(human).await.unwrap();
    *state.owner_user_id.write().await = Some(human as i64);
    let bot = state.wdb.create_user("project-bot", None, "test-hash").await.unwrap();
    let (token, _) = state.bot_registry.create(bot).await;
    let credential = format!("Bot {token}");
    let project = state
        .wdb
        .create_channel("Project", ChannelKind::Planning, human, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&project, human, MemberRole::Member)
        .await
        .unwrap();
    let pages = format!("/wiki/{project}/pages");
    let app = create_api_router(state.clone()).with_state(state.clone());

    assert_eq!(
        request(&app, Method::POST, &format!("/channels/{project}/join"), &credential, json!(null)).await.0,
        StatusCode::FORBIDDEN,
    );

    assert_eq!(
        request(&app, Method::GET, &pages, &credential, json!(null)).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&app, Method::POST, &pages, &credential, json!({"title":"Denied", "body":"x"})).await.0,
        StatusCode::FORBIDDEN
    );

    let grant = json!({"botUserId":bot, "channelId":project, "allow":true});
    assert_eq!(
        request(&app, Method::POST, "/bot/project-access", &credential, grant.clone()).await.0,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(
        request(&app, Method::POST, "/bot/project-access", &jwt(&state, human), grant).await.0,
        StatusCode::OK,
    );
    let (status, created) = request(
        &app,
        Method::POST,
        &pages,
        &credential,
        json!({"title":"Experiment", "body":"Bot notes"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["authorUserId"], bot);
    let page_path = format!("{pages}/{}", created["pageId"].as_str().unwrap());
    let original_edit_token = created["updatedAtMicros"].as_i64().unwrap();
    let edit = json!({"expectedUpdatedAtMicros": original_edit_token, "title":"Experiment", "body":"Bot changed the notes"});
    let (status, changed) = request(&app, Method::PUT, &page_path, &credential, edit.clone()).await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(changed["body"], "Bot changed the notes");
    assert!(changed["updatedAtMicros"].as_i64().unwrap() > original_edit_token);
    assert_eq!(
        request(&app, Method::PUT, &page_path, &credential, edit).await.0,
        StatusCode::CONFLICT
    );
    let (status, removable) = request(&app, Method::POST, &pages, &credential,
        json!({"title":"Temporary", "body":"first"})).await;
    assert_eq!(status, StatusCode::OK, "{removable}");
    let removable_path = format!("{pages}/{}", removable["pageId"].as_str().unwrap());
    let old_token = removable["updatedAtMicros"].as_i64().unwrap();
    let (status, revised) = request(&app, Method::PUT, &removable_path, &credential,
        json!({"expectedUpdatedAtMicros": old_token, "title":"Temporary", "body":"second"})).await;
    assert_eq!(status, StatusCode::OK, "{revised}");
    assert_eq!(
        request(&app, Method::DELETE, &format!("{removable_path}?expectedUpdatedAtMicros={old_token}"), &credential, json!(null)).await.0,
        StatusCode::CONFLICT,
    );
    let new_token = revised["updatedAtMicros"].as_i64().unwrap();
    assert_eq!(
        request(&app, Method::DELETE, &format!("{removable_path}?expectedUpdatedAtMicros={new_token}"), &credential, json!(null)).await.0,
        StatusCode::OK,
    );
    assert_eq!(
        request(&app, Method::GET, &pages, &credential, json!(null)).await.0,
        StatusCode::OK
    );

    assert_eq!(
        request(&app, Method::POST, "/bot/project-access", &jwt(&state, human),
            json!({"botUserId":bot, "channelId":project, "allow":false})).await.0,
        StatusCode::OK,
    );
    assert_eq!(
        request(&app, Method::GET, &pages, &credential, json!(null)).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&app, Method::POST, &pages, &credential, json!({"title":"Denied again", "body":"x"})).await.0,
        StatusCode::FORBIDDEN
    );

    state.wdb.add_channel_member(&project, bot, MemberRole::Member).await.unwrap();
    assert!(state.bot_registry.disable(bot).await);
    assert_eq!(
        request(&app, Method::GET, &pages, &credential, json!(null)).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(state.wdb.list_wiki_pages(&project).await.unwrap().len(), 1);
}

#[tokio::test]
async fn human_and_bot_share_durable_project_cards_without_lost_edits() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let human = state.wdb.create_user("board-human", None, "test-hash").await.unwrap();
    state.wdb.claim_owner(human).await.unwrap();
    *state.owner_user_id.write().await = Some(human as i64);
    let outsider = state.wdb.create_user("board-outsider", None, "test-hash").await.unwrap();
    let bot = state.wdb.create_user("board-bot", None, "test-hash").await.unwrap();
    let (token, _) = state.bot_registry.create(bot).await;
    let bot_credential = format!("Bot {token}");
    let human_credential = jwt(&state, human);
    let outsider_credential = jwt(&state, outsider);
    let project = state.wdb.create_channel("Project", ChannelKind::Planning, human, false).await.unwrap();
    let other = state.wdb.create_channel("Other project", ChannelKind::Planning, human, false).await.unwrap();
    for id in [&project, &other] {
        state.wdb.add_channel_member(id, human, MemberRole::Member).await.unwrap();
    }
    state.wdb.add_channel_member(&project, bot, MemberRole::Member).await.unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let path = format!("/projects/{project}/tasks");
    let (status, roster) = request(&app, Method::GET, &format!("/projects/{project}/members"), &human_credential, json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{roster}");
    assert!(roster["members"].as_array().unwrap().iter().any(|member| member["id"] == bot && member["isBot"] == true));
    assert_eq!(request(&app, Method::GET, &format!("/projects/{project}/members"), &outsider_credential, json!(null)).await.0, StatusCode::FORBIDDEN);
    let create = json!({
        "operationId":"b5058b70-0e04-4c06-9420-fc66e788be57",
        "title":"Build shared board", "description":"first experiment",
        "status":"todo", "priority":"high"
    });
    let (status, created) = request(&app, Method::POST, &path, &human_credential, create.clone()).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["revision"], 1);
    assert_eq!(created["createdByUserId"], human);
    let task_id = created["taskId"].as_str().unwrap();

    let (status, duplicate) = request(&app, Method::POST, &path, &human_credential, create).await;
    assert_eq!(status, StatusCode::OK, "{duplicate}");
    assert_eq!(duplicate["taskId"], task_id);
    assert_eq!(
        request(&app, Method::POST, &path, &human_credential, json!({
            "operationId":"b5058b70-0e04-4c06-9420-fc66e788be57",
            "title":"Different card", "status":"todo", "priority":"high"
        })).await.0,
        StatusCode::CONFLICT,
    );
    for (operation_id, title, status, assignee) in [
        ("b5058b70-0e04-4c06-9420-fc66e788be58", "", "todo", None),
        ("b5058b70-0e04-4c06-9420-fc66e788be59", "Invalid", "unknown", None),
        ("b5058b70-0e04-4c06-9420-fc66e788be5a", "Invalid", "todo", Some(outsider)),
    ] {
        assert_eq!(
            request(&app, Method::POST, &path, &human_credential, json!({
                "operationId":operation_id, "title":title, "status":status,
                "priority":"high", "assigneeUserId":assignee
            })).await.0,
            StatusCode::BAD_REQUEST,
        );
    }
    assert_eq!(
        request(&app, Method::POST, &path, &human_credential, json!({
            "operationId":"not-a-uuid", "title":"Invalid", "status":"todo", "priority":"high"
        })).await.0,
        StatusCode::BAD_REQUEST,
    );
    let (status, listed) = request(&app, Method::GET, &path, &bot_credential, json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["tasks"].as_array().unwrap().len(), 1);

    let task_path = format!("{path}/{task_id}");
    let bot_edit = json!({
        "expectedRevision":1, "title":"Build shared board", "description":"agent started",
        "status":"in_progress", "priority":"high"
    });
    let (status, updated) = request(&app, Method::PUT, &task_path, &bot_credential, bot_edit.clone()).await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["revision"], 2);
    assert_eq!(updated["updatedByUserId"], bot);
    assert_eq!(
        request(&app, Method::PUT, &task_path, &human_credential, bot_edit).await.0,
        StatusCode::CONFLICT,
    );
    assert_eq!(
        request(&app, Method::GET, &path, &outsider_credential, json!(null)).await.0,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(
        request(&app, Method::GET, &format!("/projects/{other}/tasks/{task_id}"), &human_credential, json!(null)).await.0,
        StatusCode::NOT_FOUND,
    );
    assert_eq!(
        request(&app, Method::POST, "/bot/project-access", &human_credential,
            json!({"botUserId":bot, "channelId":project, "allow":false})).await.0,
        StatusCode::OK,
    );
    assert_eq!(
        request(&app, Method::GET, &path, &bot_credential, json!(null)).await.0,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(
        request(&app, Method::PUT, &task_path, &bot_credential, json!({
            "expectedRevision": 2, "title": "Build shared board", "description": "revoked bot edit",
            "status": "done", "priority": "high"
        })).await.0,
        StatusCode::FORBIDDEN,
    );
    let (_, unchanged) = request(&app, Method::GET, &task_path, &human_credential, json!(null)).await;
    assert_eq!(unchanged["revision"], 2);
    assert_eq!(unchanged["status"], "in_progress");
    assert_eq!(
        request(&app, Method::POST, "/bot/project-access", &human_credential,
            json!({"botUserId":bot, "channelId":project, "allow":true})).await.0,
        StatusCode::OK,
    );
    // Start an edit while admission is being changed. The handler must check
    // membership again after the gate opens, before committing a task event.
    let membership = state.membership_gate.write().await;
    let pending_app = app.clone();
    let pending_path = task_path.clone();
    let pending_credential = bot_credential.clone();
    let pending_edit = tokio::spawn(async move {
        request(&pending_app, Method::PUT, &pending_path, &pending_credential, json!({
            "expectedRevision": 2, "title": "Build shared board", "description": "racing bot edit",
            "status": "done", "priority": "high"
        })).await
    });
    tokio::task::yield_now().await;
    state.wdb.remove_channel_member(&project, bot).await.unwrap();
    drop(membership);
    assert_eq!(pending_edit.await.unwrap().0, StatusCode::FORBIDDEN);
    let (_, unchanged) = request(&app, Method::GET, &task_path, &human_credential, json!(null)).await;
    assert_eq!(unchanged["revision"], 2);
    assert_eq!(
        request(&app, Method::POST, "/bot/project-access", &human_credential,
            json!({"botUserId":bot, "channelId":project, "allow":true})).await.0,
        StatusCode::OK,
    );
    let (status, archived) = request(&app, Method::PUT, &task_path, &bot_credential, json!({
        "expectedRevision":2, "title":"Build shared board", "description":"finished",
        "status":"archived", "priority":"high"
    })).await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(archived["isArchived"], true);
    assert_eq!(archived["revision"], 3);

    drop(app);
    drop(state);
    let restarted = server(dir.path()).await;
    let app = create_api_router(restarted.clone()).with_state(restarted);
    let (status, saved) = request(&app, Method::GET, &task_path, &human_credential, json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["revision"], 3);
    assert_eq!(saved["description"], "finished");
}

#[tokio::test]
async fn wabi_bot_ping_requires_text_channel_membership_and_is_visible_to_human() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let human = state.wdb.create_user("ping-human", None, "test-hash").await.unwrap();
    let bot = state.wdb.create_user("ping-bot", None, "test-hash").await.unwrap();
    let (token, _) = state.bot_registry.create(bot).await;
    let bot_credential = format!("Bot {token}");
    let text = state.wdb.create_channel("Agent test", ChannelKind::Text, human, false).await.unwrap();
    state.wdb.add_channel_member(&text, human, MemberRole::Member).await.unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let ping = json!({"channel_id":text, "content":"WABI_BOT_PING_OK"});

    assert_eq!(
        request(&app, Method::POST, "/bot/send-message", &bot_credential, ping.clone()).await.0,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(
        request(&app, Method::POST, &format!("/channels/{text}/join"), &bot_credential, json!(null)).await.0,
        StatusCode::OK,
    );
    let (status, human_ping) = request(&app, Method::POST, "/messages", &jwt(&state, human),
        json!({"channel_id":text, "content":"@ping-bot ping"})).await;
    assert_eq!(status, StatusCode::OK, "{human_ping}");
    let (status, bot_history) = request(&app, Method::GET, &format!("/messages/{text}"), &bot_credential, json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{bot_history}");
    assert!(bot_history["messages"].as_array().unwrap().iter().any(|message|
        message["content"] == "@ping-bot ping" && message["user_id"] == human.to_string()
    ));
    let (status, sent) = request(&app, Method::POST, "/bot/send-message", &bot_credential, ping).await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["isBot"], true);
    let (status, history) = request(&app, Method::GET, &format!("/messages/{text}"), &jwt(&state, human), json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{history}");
    assert!(history["messages"].as_array().unwrap().iter().any(|message|
        message["content"] == "WABI_BOT_PING_OK" && message["user_id"] == bot.to_string()
    ));
}
