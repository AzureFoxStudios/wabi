//! A project bot uses the ordinary wiki API and channel permission boundary.
#[path = "fixtures/writer_drain.rs"]
mod writer_drain;

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
    )
    .unwrap();
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
    let human = state
        .wdb
        .create_user("project-human", None, "test-hash")
        .await
        .unwrap();
    state.wdb.claim_owner(human).await.unwrap();
    *state.owner_user_id.write().await = Some(human as i64);
    let bot = state
        .wdb
        .create_user("project-bot", None, "test-hash")
        .await
        .unwrap();
    let (token, _) = state.bot_registry.create(bot).await.unwrap();
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
        request(
            &app,
            Method::POST,
            &format!("/channels/{project}/join"),
            &credential,
            json!(null)
        )
        .await
        .0,
        StatusCode::FORBIDDEN,
    );

    assert_eq!(
        request(&app, Method::GET, &pages, &credential, json!(null))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &pages,
            &credential,
            json!({"title":"Denied", "body":"x"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    let grant = json!({"botUserId":bot, "channelId":project, "allow":true});
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/bot/project-access",
            &credential,
            grant.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/bot/project-access",
            &jwt(&state, human),
            grant
        )
        .await
        .0,
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
        request(&app, Method::PUT, &page_path, &credential, edit)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (status, removable) = request(
        &app,
        Method::POST,
        &pages,
        &credential,
        json!({"title":"Temporary", "body":"first"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{removable}");
    let removable_path = format!("{pages}/{}", removable["pageId"].as_str().unwrap());
    let old_token = removable["updatedAtMicros"].as_i64().unwrap();
    let (status, revised) = request(
        &app,
        Method::PUT,
        &removable_path,
        &credential,
        json!({"expectedUpdatedAtMicros": old_token, "title":"Temporary", "body":"second"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{revised}");
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("{removable_path}?expectedUpdatedAtMicros={old_token}"),
            &credential,
            json!(null)
        )
        .await
        .0,
        StatusCode::CONFLICT,
    );
    let new_token = revised["updatedAtMicros"].as_i64().unwrap();
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("{removable_path}?expectedUpdatedAtMicros={new_token}"),
            &credential,
            json!(null)
        )
        .await
        .0,
        StatusCode::OK,
    );
    assert_eq!(
        request(&app, Method::GET, &pages, &credential, json!(null))
            .await
            .0,
        StatusCode::OK
    );

    assert_eq!(
        request(
            &app,
            Method::POST,
            "/bot/project-access",
            &jwt(&state, human),
            json!({"botUserId":bot, "channelId":project, "allow":false})
        )
        .await
        .0,
        StatusCode::OK,
    );
    assert_eq!(
        request(&app, Method::GET, &pages, &credential, json!(null))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &pages,
            &credential,
            json!({"title":"Denied again", "body":"x"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );

    state
        .wdb
        .add_channel_member(&project, bot, MemberRole::Member)
        .await
        .unwrap();
    assert!(state.bot_registry.disable(bot).await.unwrap());
    assert_eq!(
        request(&app, Method::GET, &pages, &credential, json!(null))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(state.wdb.list_wiki_pages(&project).await.unwrap().len(), 1);
}

#[tokio::test]
async fn human_and_bot_share_durable_project_cards_without_lost_edits() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let human = state
        .wdb
        .create_user("board-human", None, "test-hash")
        .await
        .unwrap();
    state.wdb.claim_owner(human).await.unwrap();
    *state.owner_user_id.write().await = Some(human as i64);
    let outsider = state
        .wdb
        .create_user("board-outsider", None, "test-hash")
        .await
        .unwrap();
    let bot = state
        .wdb
        .create_user("board-bot", None, "test-hash")
        .await
        .unwrap();
    let (token, _) = state.bot_registry.create(bot).await.unwrap();
    let bot_credential = format!("Bot {token}");
    let human_credential = jwt(&state, human);
    let outsider_credential = jwt(&state, outsider);
    let project = state
        .wdb
        .create_channel("Project", ChannelKind::Planning, human, false)
        .await
        .unwrap();
    let other = state
        .wdb
        .create_channel("Other project", ChannelKind::Planning, human, false)
        .await
        .unwrap();
    for id in [&project, &other] {
        state
            .wdb
            .add_channel_member(id, human, MemberRole::Member)
            .await
            .unwrap();
    }
    state
        .wdb
        .add_channel_member(&project, bot, MemberRole::Member)
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let path = format!("/projects/{project}/tasks");
    let (status, roster) = request(
        &app,
        Method::GET,
        &format!("/projects/{project}/members"),
        &human_credential,
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{roster}");
    assert!(roster["members"]
        .as_array()
        .unwrap()
        .iter()
        .any(|member| member["id"] == bot && member["isBot"] == true));
    assert_eq!(
        request(
            &app,
            Method::GET,
            &format!("/projects/{project}/members"),
            &outsider_credential,
            json!(null)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let create = json!({
        "operationId":"b5058b70-0e04-4c06-9420-fc66e788be57",
        "title":"Build shared board", "description":"first experiment",
        "status":"todo", "priority":"high"
    });
    let (status, created) =
        request(&app, Method::POST, &path, &human_credential, create.clone()).await;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["revision"], 1);
    assert_eq!(created["createdByUserId"], human);
    let task_id = created["taskId"].as_str().unwrap();

    let (status, duplicate) = request(&app, Method::POST, &path, &human_credential, create).await;
    assert_eq!(status, StatusCode::OK, "{duplicate}");
    assert_eq!(duplicate["taskId"], task_id);
    assert_eq!(
        request(
            &app,
            Method::POST,
            &path,
            &human_credential,
            json!({
                "operationId":"b5058b70-0e04-4c06-9420-fc66e788be57",
                "title":"Different card", "status":"todo", "priority":"high"
            })
        )
        .await
        .0,
        StatusCode::CONFLICT,
    );
    for (operation_id, title, status, assignee) in [
        ("b5058b70-0e04-4c06-9420-fc66e788be58", "", "todo", None),
        (
            "b5058b70-0e04-4c06-9420-fc66e788be59",
            "Invalid",
            "unknown",
            None,
        ),
        (
            "b5058b70-0e04-4c06-9420-fc66e788be5a",
            "Invalid",
            "todo",
            Some(outsider),
        ),
    ] {
        assert_eq!(
            request(
                &app,
                Method::POST,
                &path,
                &human_credential,
                json!({
                    "operationId":operation_id, "title":title, "status":status,
                    "priority":"high", "assigneeUserId":assignee
                })
            )
            .await
            .0,
            StatusCode::BAD_REQUEST,
        );
    }
    assert_eq!(
        request(
            &app,
            Method::POST,
            &path,
            &human_credential,
            json!({
                "operationId":"not-a-uuid", "title":"Invalid", "status":"todo", "priority":"high"
            })
        )
        .await
        .0,
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
    let (status, updated) = request(
        &app,
        Method::PUT,
        &task_path,
        &bot_credential,
        bot_edit.clone(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["revision"], 2);
    assert_eq!(updated["updatedByUserId"], bot);
    assert_eq!(
        request(&app, Method::PUT, &task_path, &human_credential, bot_edit)
            .await
            .0,
        StatusCode::CONFLICT,
    );
    assert_eq!(
        request(&app, Method::GET, &path, &outsider_credential, json!(null))
            .await
            .0,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            &format!("/projects/{other}/tasks/{task_id}"),
            &human_credential,
            json!(null)
        )
        .await
        .0,
        StatusCode::NOT_FOUND,
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/bot/project-access",
            &human_credential,
            json!({"botUserId":bot, "channelId":project, "allow":false})
        )
        .await
        .0,
        StatusCode::OK,
    );
    assert_eq!(
        request(&app, Method::GET, &path, &bot_credential, json!(null))
            .await
            .0,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(
        request(&app, Method::PUT, &task_path, &bot_credential, json!({
            "expectedRevision": 2, "title": "Build shared board", "description": "revoked bot edit",
            "status": "done", "priority": "high"
        })).await.0,
        StatusCode::FORBIDDEN,
    );
    let (_, unchanged) = request(
        &app,
        Method::GET,
        &task_path,
        &human_credential,
        json!(null),
    )
    .await;
    assert_eq!(unchanged["revision"], 2);
    assert_eq!(unchanged["status"], "in_progress");
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/bot/project-access",
            &human_credential,
            json!({"botUserId":bot, "channelId":project, "allow":true})
        )
        .await
        .0,
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
    state
        .wdb
        .remove_channel_member(&project, bot)
        .await
        .unwrap();
    drop(membership);
    assert_eq!(pending_edit.await.unwrap().0, StatusCode::FORBIDDEN);
    let (_, unchanged) = request(
        &app,
        Method::GET,
        &task_path,
        &human_credential,
        json!(null),
    )
    .await;
    assert_eq!(unchanged["revision"], 2);
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/bot/project-access",
            &human_credential,
            json!({"botUserId":bot, "channelId":project, "allow":true})
        )
        .await
        .0,
        StatusCode::OK,
    );
    let (status, archived) = request(
        &app,
        Method::PUT,
        &task_path,
        &bot_credential,
        json!({
            "expectedRevision":2, "title":"Build shared board", "description":"finished",
            "status":"archived", "priority":"high"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{archived}");
    assert_eq!(archived["isArchived"], true);
    assert_eq!(archived["revision"], 3);

    let config = state.config.clone();
    drop(app);
    drop(state);
    let restarted = Arc::new(writer_drain::app_state(&config).await.unwrap());
    let app = create_api_router(restarted.clone()).with_state(restarted);
    let (status, saved) = request(
        &app,
        Method::GET,
        &task_path,
        &human_credential,
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["revision"], 3);
    assert_eq!(saved["description"], "finished");
}

#[tokio::test]
async fn wabi_bot_ping_requires_text_channel_membership_and_is_visible_to_human() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let human = state
        .wdb
        .create_user("ping-human", None, "test-hash")
        .await
        .unwrap();
    state.wdb.claim_owner(human).await.unwrap();
    *state.owner_user_id.write().await = Some(human as i64);
    let bot = state
        .wdb
        .create_user("ping-bot", None, "test-hash")
        .await
        .unwrap();
    let (token, _) = state.bot_registry.create(bot).await.unwrap();
    let bot_credential = format!("Bot {token}");
    let text = state
        .wdb
        .create_channel("Agent test", ChannelKind::Text, human, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&text, human, MemberRole::Member)
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let ping = json!({"channel_id":text, "content":"WABI_BOT_PING_OK"});

    assert_eq!(
        request(
            &app,
            Method::POST,
            "/bot/send-message",
            &bot_credential,
            ping.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN,
    );
    // A bot cannot join a text channel by itself; the owner grants it.
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!("/channels/{text}/join"),
            &bot_credential,
            json!(null)
        )
        .await
        .0,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            "/bot/channel-access",
            &jwt(&state, human),
            json!({"botUserId":bot, "channelId":text, "allow":true})
        )
        .await
        .0,
        StatusCode::OK,
    );
    let (status, human_ping) = request(
        &app,
        Method::POST,
        "/messages",
        &jwt(&state, human),
        json!({"channel_id":text, "content":"@ping-bot ping"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{human_ping}");
    let ping = json!({"channel_id":text, "content":"WABI_BOT_PING_OK", "replyTo":human_ping["id"]});
    let (status, bot_history) = request(
        &app,
        Method::GET,
        &format!("/messages/{text}"),
        &bot_credential,
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{bot_history}");
    assert!(bot_history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["content"] == "@ping-bot ping"
            && message["user_id"] == human.to_string()));
    let (status, sent) = request(
        &app,
        Method::POST,
        "/bot/send-message",
        &bot_credential,
        ping,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{sent}");
    assert_eq!(sent["isBot"], true);
    let (status, history) = request(
        &app,
        Method::GET,
        &format!("/messages/{text}"),
        &jwt(&state, human),
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    assert!(history["messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|message| message["content"] == "WABI_BOT_PING_OK"
            && message["user_id"] == bot.to_string()));
}

#[tokio::test]
async fn wiki_and_cards_recheck_human_and_bot_credentials_after_body_wait() {
    use axum::body::Bytes;
    for is_bot in [false, true] {
        for operation in [
            "wiki_create",
            "wiki_update",
            "card_create",
            "card_update",
            "card_claim",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let state = server(dir.path()).await;
            let user = state
                .wdb
                .create_user("wiki-writer", None, "hash")
                .await
                .unwrap();
            let project = state
                .wdb
                .create_channel("Project", ChannelKind::Planning, user, false)
                .await
                .unwrap();
            state
                .wdb
                .add_channel_member(&project, user, MemberRole::Member)
                .await
                .unwrap();
            let page = state
                .wdb
                .create_wiki_page(&project, "Original", "original", user, "", "", 0)
                .await
                .unwrap();
            let original = state
                .wdb
                .get_wiki_page(&project, &page)
                .await
                .unwrap()
                .unwrap();
            let card = state
                .wdb
                .create_project_task(
                    &project,
                    "task_control",
                    serde_json::from_value(json!({
                        "title":"Original card", "status":"todo", "priority":"medium",
                    }))
                    .unwrap(),
                    user,
                )
                .await
                .unwrap();
            let credential = if is_bot {
                format!("Bot {}", state.bot_registry.create(user).await.unwrap().0)
            } else {
                jwt(&state, user)
            };
            let (method, path, payload) = match operation {
                "wiki_update" => (
                    Method::PUT,
                    format!("/wiki/{project}/pages/{page}"),
                    json!({
                        "expectedUpdatedAtMicros": original.updated_at_micros,
                        "title":"Forged", "body":"revoked writer canary",
                    }),
                ),
                "wiki_create" => (
                    Method::POST,
                    format!("/wiki/{project}/pages"),
                    json!({"title":"Forged", "body":"revoked writer canary"}),
                ),
                "card_create" => (
                    Method::POST,
                    format!("/projects/{project}/tasks"),
                    json!({
                        "operationId":uuid::Uuid::new_v4().to_string(),"title":"Forged", "status":"todo", "priority":"medium",
                    }),
                ),
                "card_update" => (
                    Method::PUT,
                    format!("/projects/{project}/tasks/task_control"),
                    json!({
                        "expectedRevision":card.revision,"title":"Forged", "status":"todo", "priority":"medium",
                    }),
                ),
                "card_claim" => (
                    Method::POST,
                    format!("/projects/{project}/tasks/task_control/claim"),
                    json!({"expectedRevision":card.revision}),
                ),
                _ => unreachable!(),
            };
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (body_tx, body_rx) = tokio::sync::oneshot::channel::<Value>();
            let stream = futures::stream::once(async move {
                let _ = started_tx.send(());
                Ok::<Bytes, std::io::Error>(Bytes::from(body_rx.await.unwrap().to_string()))
            });
            let app = create_api_router(state.clone()).with_state(state.clone());
            let req = Request::builder()
                .method(method)
                .uri(&path)
                .header("authorization", &credential)
                .header("content-type", "application/json")
                .body(Body::from_stream(stream))
                .unwrap();
            let pending = tokio::spawn(async move { app.oneshot(req).await.unwrap().status() });
            tokio::time::timeout(std::time::Duration::from_secs(2), started_rx)
                .await
                .unwrap()
                .unwrap();
            if is_bot {
                assert!(state.bot_registry.disable(user).await.unwrap());
            } else {
                let claims = wabi_server::auth_extractor::decode_token(
                    credential.strip_prefix("Bearer ").unwrap(),
                    &state.config.jwt_secret,
                )
                .await
                .unwrap();
                state
                    .revoke_token_with_exp(claims.jti, claims.exp)
                    .await
                    .unwrap();
            }
            let seq = state.wdb.engine().projection_state().applied_commit_seq();
            body_tx.send(payload).unwrap();
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_secs(2), pending)
                    .await
                    .unwrap()
                    .unwrap(),
                StatusCode::UNAUTHORIZED,
                "{path} bot={is_bot}"
            );
            assert_eq!(
                state.wdb.engine().projection_state().applied_commit_seq(),
                seq
            );
            let saved_card = state
                .wdb
                .get_project_task(&project, "task_control")
                .unwrap()
                .unwrap();
            assert_eq!(saved_card.title, "Original card");
            assert_eq!(saved_card.revision, card.revision);
            assert_eq!(state.wdb.list_project_tasks(&project).unwrap().len(), 1);
            assert_eq!(state.wdb.list_wiki_pages(&project).await.unwrap().len(), 1);
            assert_eq!(
                state
                    .wdb
                    .get_wiki_page(&project, &page)
                    .await
                    .unwrap()
                    .unwrap()
                    .body,
                "original"
            );
        }
    }
}

#[tokio::test]
async fn wiki_read_and_delete_recheck_credentials_after_membership_gate_wait() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let user = state
        .wdb
        .create_user("wiki-reader", None, "hash")
        .await
        .unwrap();
    let project = state
        .wdb
        .create_channel("Project", ChannelKind::Planning, user, false)
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&project, user, MemberRole::Member)
        .await
        .unwrap();
    let page = state
        .wdb
        .create_wiki_page(&project, "Original", "original", user, "", "", 0)
        .await
        .unwrap();
    let original = state
        .wdb
        .get_wiki_page(&project, &page)
        .await
        .unwrap()
        .unwrap();
    state
        .wdb
        .create_project_task(
            &project,
            "task_control",
            serde_json::from_value(json!({
                "title":"Original card", "status":"todo", "priority":"medium",
            }))
            .unwrap(),
            user,
        )
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    for (method, path) in [
        (Method::GET, format!("/projects/{project}/tasks")),
        (
            Method::GET,
            format!("/projects/{project}/tasks/task_control"),
        ),
        (Method::GET, format!("/projects/{project}/history")),
        (Method::GET, format!("/projects/{project}/members")),
        (Method::GET, format!("/wiki/{project}/pages")),
        (Method::GET, format!("/wiki/{project}/pages/{page}")),
        (
            Method::GET,
            format!("/wiki/{project}/pages/{page}/revisions"),
        ),
        (
            Method::DELETE,
            format!(
                "/wiki/{project}/pages/{page}?expectedUpdatedAtMicros={}",
                original.updated_at_micros
            ),
        ),
    ] {
        let credential = jwt(&state, user);
        let claims = wabi_server::auth_extractor::decode_token(
            credential.strip_prefix("Bearer ").unwrap(),
            &state.config.jwt_secret,
        )
        .await
        .unwrap();
        let membership = state.membership_gate.write().await;
        let mut response = Box::pin(
            app.clone().oneshot(
                Request::builder()
                    .method(method)
                    .uri(&path)
                    .header("authorization", credential)
                    .body(Body::empty())
                    .unwrap(),
            ),
        );
        assert!(
            futures::poll!(response.as_mut()).is_pending(),
            "{path} bypassed membership admission"
        );
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            state.revoke_token_with_exp(claims.jti, claims.exp),
        )
        .await
        .unwrap()
        .unwrap();
        drop(membership);
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), response)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
    }
    assert_eq!(
        state
            .wdb
            .get_wiki_page(&project, &page)
            .await
            .unwrap()
            .unwrap()
            .body,
        "original"
    );
}

/// Send a bot message (optionally replying to a trigger) and return the status.
async fn bot_send(app: &Router, credential: &str, channel: &str, content: &str) -> StatusCode {
    bot_reply(app, credential, channel, content, None).await
}

async fn bot_reply(app: &Router, credential: &str, channel: &str, content: &str, reply_to: Option<&str>) -> StatusCode {
    request(
        app,
        Method::POST,
        "/bot/send-message",
        credential,
        json!({"channel_id":channel, "content":content, "replyTo":reply_to}),
    )
    .await
    .0
}

/// A person posts in a channel; returns the new message ID.
async fn human_post(app: &Router, credential: &str, channel: &str, content: &str) -> String {
    let (status, body) = request(
        app,
        Method::POST,
        "/messages",
        credential,
        json!({"channel_id":channel, "content":content}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["id"].as_str().unwrap().to_string()
}

/// The prompt-injection scenario: a bot that reads one channel must not be
/// able to join, read or post in any other channel the owner did not grant.
#[tokio::test]
async fn bot_reaches_only_owner_granted_channels_and_cannot_join_others() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let owner = state.wdb.create_user("scope-owner", None, "test-hash").await.unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    let member = state.wdb.create_user("scope-member", None, "test-hash").await.unwrap();
    let bot = state.wdb.create_user("scope-bot", None, "test-hash").await.unwrap();
    let (token, _) = state.bot_registry.create(bot).await.unwrap();
    let bot_credential = format!("Bot {token}");
    let owner_credential = jwt(&state, owner);
    let granted = state.wdb.create_channel("granted", ChannelKind::Text, owner, false).await.unwrap();
    let other = state.wdb.create_channel("other", ChannelKind::Text, owner, false).await.unwrap();
    for channel in [&granted, &other] {
        for user in [owner, member] {
            state.wdb.add_channel_member(channel, user, MemberRole::Member).await.unwrap();
        }
    }
    let app = create_api_router(state.clone()).with_state(state.clone());
    let grant = |channel: &str, allow: bool| json!({"botUserId":bot, "channelId":channel, "allow":allow});

    // Nobody but the owner can grant, including the bot itself.
    for credential in [&bot_credential, &jwt(&state, member)] {
        assert_eq!(
            request(&app, Method::POST, "/bot/channel-access", credential, grant(&granted, true)).await.0,
            StatusCode::FORBIDDEN,
        );
    }
    assert_eq!(
        request(&app, Method::POST, "/bot/channel-access", &owner_credential, grant(&granted, true)).await.0,
        StatusCode::OK,
    );
    let trigger = human_post(&app, &jwt(&state, member), &granted, "@scope-bot hello").await;
    assert_eq!(bot_reply(&app, &bot_credential, &granted, "in scope", Some(&trigger)).await, StatusCode::OK);
    assert_eq!(
        request(&app, Method::GET, &format!("/messages/{granted}"), &bot_credential, json!(null)).await.0,
        StatusCode::OK,
    );

    // Everything outside the grant is refused: joining, reading and posting.
    assert_eq!(
        request(&app, Method::POST, &format!("/channels/{other}/join"), &bot_credential, json!(null)).await.0,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(bot_send(&app, &bot_credential, &other, "injected").await, StatusCode::FORBIDDEN);
    assert_eq!(
        request(&app, Method::GET, &format!("/messages/{other}"), &bot_credential, json!(null)).await.0,
        StatusCode::FORBIDDEN,
    );
    let (_, other_history) =
        request(&app, Method::GET, &format!("/messages/{other}"), &owner_credential, json!(null)).await;
    assert!(!other_history["messages"].as_array().unwrap().iter().any(|m| m["content"] == "injected"));

    // The owner can review the bot's reach.
    let path = format!("/bot/channel-access?botUserId={bot}");
    assert_eq!(request(&app, Method::GET, &path, &jwt(&state, member), json!(null)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(request(&app, Method::GET, &path, &bot_credential, json!(null)).await.0, StatusCode::FORBIDDEN);
    let (status, listed) = request(&app, Method::GET, &path, &owner_credential, json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    let ids: Vec<&str> = listed["channels"].as_array().unwrap().iter().map(|c| c["channelId"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![granted.as_str()]);

    // Revoking the grant ends reading and posting at once.
    assert_eq!(
        request(&app, Method::POST, "/bot/channel-access", &owner_credential, grant(&granted, false)).await.0,
        StatusCode::OK,
    );
    assert_eq!(bot_send(&app, &bot_credential, &granted, "after revoke").await, StatusCode::FORBIDDEN);
    assert_eq!(
        request(&app, Method::GET, &format!("/messages/{granted}"), &bot_credential, json!(null)).await.0,
        StatusCode::FORBIDDEN,
    );
    let (_, listed) = request(&app, Method::GET, &path, &owner_credential, json!(null)).await;
    assert!(listed["channels"].as_array().unwrap().is_empty(), "{listed}");
}

/// Conversation membership belongs to the people in it, not the owner.
#[tokio::test]
async fn owner_cannot_grant_a_bot_a_dm_or_group() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let owner = state.wdb.create_user("dm-owner", None, "test-hash").await.unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    let bot = state.wdb.create_user("dm-bot", None, "test-hash").await.unwrap();
    let (token, _) = state.bot_registry.create(bot).await.unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    for kind in [ChannelKind::Dm, ChannelKind::GroupDm] {
        let conversation = state.wdb.create_channel("private", kind, owner, false).await.unwrap();
        state.wdb.add_channel_member(&conversation, owner, MemberRole::Member).await.unwrap();
        assert_eq!(
            request(
                &app,
                Method::POST,
                "/bot/channel-access",
                &jwt(&state, owner),
                json!({"botUserId":bot, "channelId":conversation, "allow":true})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST,
        );
        assert!(!state.wdb.list_channel_members(&conversation).await.unwrap().iter().any(|m| m.user_id == bot));
        assert_eq!(bot_send(&app, &format!("Bot {token}"), &conversation, "x").await, StatusCode::FORBIDDEN);
    }
}

/// Listing a bot in admin_user_ids must not turn its token into access to
/// every ordinary channel, or into permission to create channels.
#[tokio::test]
async fn a_bot_listed_as_admin_gets_no_extra_channel_reach() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let owner = state.wdb.create_user("admin-owner", None, "test-hash").await.unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    let bot = state.wdb.create_user("admin-bot", None, "test-hash").await.unwrap();
    let (token, _) = state.bot_registry.create(bot).await.unwrap();
    let channel = state.wdb.create_channel("staff-only", ChannelKind::Text, owner, false).await.unwrap();
    state.wdb.add_channel_member(&channel, owner, MemberRole::Member).await.unwrap();

    let mut config = state.config.clone();
    config.admin_user_ids = vec![bot as i64];
    drop(state);
    let state = Arc::new(writer_drain::app_state(&config).await.unwrap());
    assert!(!state.is_admin(bot as i64).await, "a bot must never count as an admin");
    let app = create_api_router(state.clone()).with_state(state.clone());
    let credential = format!("Bot {token}");

    assert_eq!(bot_send(&app, &credential, &channel, "as admin").await, StatusCode::FORBIDDEN);
    assert_eq!(
        request(&app, Method::GET, &format!("/messages/{channel}"), &credential, json!(null)).await.0,
        StatusCode::FORBIDDEN,
    );
    assert_eq!(
        request(&app, Method::POST, &format!("/channels/{channel}/join"), &credential, json!(null)).await.0,
        StatusCode::FORBIDDEN,
    );
    let (status, created) = request(
        &app,
        Method::POST,
        "/channels",
        &credential,
        json!({"name":"bot-made", "channel_type":"text"}),
    )
    .await;
    assert!(matches!(status, StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED), "{status} {created}");
}

/// The commenter's scenario: a bot granted two channels, called in one,
/// cannot be steered into posting in the other. Every bot post must answer a
/// recent message from a person, in the same channel, that @-mentions it,
/// unless the owner allowed unprompted posts there. The audit log records
/// posts, refusals and owner actions.
#[tokio::test]
async fn bot_posts_only_where_a_person_called_it_and_every_attempt_is_audited() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let owner = state.wdb.create_user("trig-owner", None, "test-hash").await.unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    let member = state.wdb.create_user("trig-member", None, "test-hash").await.unwrap();
    let bot = state.wdb.create_user("trig-bot", None, "test-hash").await.unwrap();
    let other_bot = state.wdb.create_user("other-bot", None, "test-hash").await.unwrap();
    let (token, _) = state.bot_registry.create(bot).await.unwrap();
    let (other_token, _) = state.bot_registry.create(other_bot).await.unwrap();
    let bot_credential = format!("Bot {token}");
    let owner_credential = jwt(&state, owner);
    let member_credential = jwt(&state, member);
    let called = state.wdb.create_channel("called", ChannelKind::Text, owner, false).await.unwrap();
    let elsewhere = state.wdb.create_channel("elsewhere", ChannelKind::Text, owner, false).await.unwrap();
    for channel in [&called, &elsewhere] {
        for user in [owner, member] {
            state.wdb.add_channel_member(channel, user, MemberRole::Member).await.unwrap();
        }
    }
    let app = create_api_router(state.clone()).with_state(state.clone());
    for (bot_id, channel) in [(bot, &called), (bot, &elsewhere), (other_bot, &called), (other_bot, &elsewhere)] {
        assert_eq!(
            request(&app, Method::POST, "/bot/channel-access", &owner_credential,
                json!({"botUserId":bot_id, "channelId":channel, "allow":true})).await.0,
            StatusCode::OK,
        );
    }

    let mention = human_post(&app, &member_credential, &called, "@trig-bot please summarize").await;
    let no_mention = human_post(&app, &member_credential, &elsewhere, "just chatting").await;
    let lookalike = human_post(&app, &member_credential, &elsewhere, "@trig-bot2 hi").await;

    // Called in one channel, the bot answers there...
    assert_eq!(bot_reply(&app, &bot_credential, &called, "summary", Some(&mention)).await, StatusCode::OK);
    // ...but cannot use that call, or anything else, to post elsewhere.
    assert_eq!(bot_reply(&app, &bot_credential, &elsewhere, "injected", Some(&mention)).await, StatusCode::FORBIDDEN);
    assert_eq!(bot_reply(&app, &bot_credential, &elsewhere, "injected", None).await, StatusCode::FORBIDDEN);
    assert_eq!(bot_reply(&app, &bot_credential, &elsewhere, "injected", Some(&no_mention)).await, StatusCode::FORBIDDEN);
    assert_eq!(bot_reply(&app, &bot_credential, &elsewhere, "injected", Some(&lookalike)).await, StatusCode::FORBIDDEN);
    assert_eq!(bot_reply(&app, &bot_credential, &elsewhere, "injected", Some("msg_does_not_exist")).await, StatusCode::FORBIDDEN);
    // A bot's own message, or another bot's, never counts as a call.
    let other_bot_call = request(&app, Method::POST, "/bot/send-message", &format!("Bot {other_token}"),
        json!({"channel_id":elsewhere, "content":"@trig-bot go"})).await;
    assert_eq!(other_bot_call.0, StatusCode::FORBIDDEN, "the other bot needs a call too");
    state.bot_policy.set_unprompted(other_bot, &elsewhere, true).await.unwrap();
    let (status, bot_call) = request(&app, Method::POST, "/bot/send-message", &format!("Bot {other_token}"),
        json!({"channel_id":elsewhere, "content":"@trig-bot go"})).await;
    assert_eq!(status, StatusCode::OK, "{bot_call}");
    let bot_call_id = bot_call["messageId"].as_str().unwrap().to_string();
    assert_eq!(bot_reply(&app, &bot_credential, &elsewhere, "injected", Some(&bot_call_id)).await, StatusCode::FORBIDDEN);
    // The human send route is closed to bot tokens, so it cannot bypass the rule.
    assert_eq!(
        request(&app, Method::POST, "/messages", &bot_credential, json!({"channel_id":elsewhere, "content":"bypass"})).await.0,
        StatusCode::FORBIDDEN,
    );
    let (_, history) = request(&app, Method::GET, &format!("/messages/{elsewhere}"), &owner_credential, json!(null)).await;
    assert!(!history["messages"].as_array().unwrap().iter()
        .any(|m| m["content"] == "injected" || m["content"] == "bypass"), "{history}");

    // Only the owner may allow unprompted posts, and only in a granted channel.
    let unprompted = json!({"botUserId":bot, "channelId":elsewhere, "allow":true});
    for credential in [&bot_credential, &member_credential] {
        assert_eq!(request(&app, Method::POST, "/bot/unprompted", credential, unprompted.clone()).await.0, StatusCode::FORBIDDEN);
    }
    let ungranted = state.wdb.create_channel("ungranted", ChannelKind::Text, owner, false).await.unwrap();
    assert_eq!(
        request(&app, Method::POST, "/bot/unprompted", &owner_credential,
            json!({"botUserId":bot, "channelId":ungranted, "allow":true})).await.0,
        StatusCode::BAD_REQUEST,
    );
    assert_eq!(request(&app, Method::POST, "/bot/unprompted", &owner_credential, unprompted).await.0, StatusCode::OK);
    assert_eq!(bot_send(&app, &bot_credential, &elsewhere, "scheduled summary").await, StatusCode::OK);
    let (_, listed) = request(&app, Method::GET, &format!("/bot/channel-access?botUserId={bot}"), &owner_credential, json!(null)).await;
    let flags: Vec<(String, bool)> = listed["channels"].as_array().unwrap().iter()
        .map(|c| (c["channelId"].as_str().unwrap().to_string(), c["unprompted"].as_bool().unwrap())).collect();
    assert!(flags.contains(&(elsewhere.clone(), true)) && flags.contains(&(called.clone(), false)), "{listed}");

    // Revoking the channel also drops the exception: a re-grant starts trigger-only.
    for allow in [false, true] {
        assert_eq!(
            request(&app, Method::POST, "/bot/channel-access", &owner_credential,
                json!({"botUserId":bot, "channelId":elsewhere, "allow":allow})).await.0,
            StatusCode::OK,
        );
    }
    assert_eq!(bot_send(&app, &bot_credential, &elsewhere, "after regrant").await, StatusCode::FORBIDDEN);

    // The audit log is owner-only and shows posts, refusals and owner actions.
    let audit_path = format!("/bot/audit?botUserId={bot}");
    for credential in [&bot_credential, &member_credential] {
        assert_eq!(request(&app, Method::GET, &audit_path, credential, json!(null)).await.0, StatusCode::FORBIDDEN);
    }
    let (status, audit) = request(&app, Method::GET, &audit_path, &owner_credential, json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{audit}");
    let entries = audit["entries"].as_array().unwrap();
    let count = |event: &str| entries.iter().filter(|e| e["event"] == event).count();
    assert_eq!(count("post"), 2, "{audit}");
    // Six refused replies plus the refusal after the re-grant.
    assert_eq!(count("post_refused"), 7, "{audit}");
    assert_eq!(count("channel_granted"), 3, "{audit}");
    assert_eq!(count("channel_revoked"), 1, "{audit}");
    assert_eq!(count("unprompted_allowed"), 1, "{audit}");
    let first_post = entries.iter().find(|e| e["event"] == "post").unwrap();
    assert_eq!(first_post["channelId"], called.as_str());
    assert_eq!(first_post["replyTo"], mention.as_str());
    assert!(entries.iter().all(|e| e["botUserId"] == bot), "other bots' entries must not leak in");
    let refused_elsewhere = entries.iter()
        .find(|e| e["event"] == "post_refused" && e["replyTo"] == mention.as_str()).unwrap();
    assert_eq!(refused_elsewhere["channelId"], elsewhere.as_str());
    assert!(refused_elsewhere["reason"].as_str().unwrap().contains("not in this channel"), "{refused_elsewhere}");
    let grant = entries.iter().find(|e| e["event"] == "channel_granted").unwrap();
    assert_eq!(grant["actorUserId"], owner as i64);
    let (_, newest) = request(&app, Method::GET, &format!("{audit_path}&limit=1"), &owner_credential, json!(null)).await;
    assert_eq!(newest["entries"].as_array().unwrap().len(), 1);
    assert_eq!(newest["entries"][0]["event"], "post_refused");
}
