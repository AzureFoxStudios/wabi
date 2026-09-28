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

async fn fixture() -> (
    tempfile::TempDir,
    Arc<AppState>,
    Router,
    String,
    String,
    u64,
    u64,
    String,
) {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let human = state.wdb.create_user("human", None, "hash").await.unwrap();
    let bot = state.wdb.create_user("worker", None, "hash").await.unwrap();
    let (token, _) = state.bot_registry.create(bot).await;
    let channel = state
        .wdb
        .create_channel("Project", ChannelKind::Planning, human, false)
        .await
        .unwrap();
    for uid in [human, bot] {
        state
            .wdb
            .add_channel_member(&channel, uid, MemberRole::Member)
            .await
            .unwrap();
    }
    let app = create_api_router(state.clone()).with_state(state.clone());
    let h = jwt(&state, human);
    (
        dir,
        state,
        app,
        h,
        format!("Bot {token}"),
        human,
        bot,
        channel,
    )
}
async fn start(app: &Router, channel: &str, human: &str, bot: u64, mode: &str) -> Value {
    let (s,r) = request(app, Method::POST, &format!("/projects/{channel}/runs"), human, json!({"operationId":uuid::Uuid::new_v4(),"botUserId":bot,"mode":mode,"prompt":"A bounded test","providerConsent":true})).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    r
}
async fn claim_run(app: &Router, channel: &str, bot: &str, r: &Value) -> Value {
    let (s, r) = request(
        app,
        Method::POST,
        &format!(
            "/projects/{channel}/runs/{}/claim",
            r["runId"].as_str().unwrap()
        ),
        bot,
        json!({"expectedRevision":r["revision"],"provider":"test","model":"test-model"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    r
}
fn action(r: &Value, tool: &str, args: Value) -> Value {
    json!({"expectedRevision":r["revision"],"attempt":r["attempt"],"operationId":uuid::Uuid::new_v4(),"tool":tool,"arguments":args})
}
#[tokio::test]
async fn human_estimates_are_hidden_protected_preserved_and_replayed() {
    let (dir, state, app, h, b, _, _, channel) = fixture().await;
    let tasks = format!("/projects/{channel}/tasks");
    let fields = json!({"title":"Estimate test","description":"Context","status":"todo","priority":"medium","humanEstimateMinutes":150,"notes":"Decision trail","checklist":[{"id":"step-one","title":"Verify","done":false}]});
    let mut create = fields.clone();
    create["operationId"] = json!(uuid::Uuid::new_v4());
    let (s, card) = request(&app, Method::POST, &tasks, &h, create).await;
    assert_eq!(s, StatusCode::OK, "{card}");
    let path = format!("{tasks}/{}", card["taskId"].as_str().unwrap());
    let (s, read) = request(&app, Method::GET, &path, &b, Value::Null).await;
    assert_eq!(s, StatusCode::OK);
    assert!(read.get("humanEstimateMinutes").is_none());
    let (_, list) = request(&app, Method::GET, &tasks, &b, Value::Null).await;
    assert!(list["tasks"][0].get("humanEstimateMinutes").is_none());
    let mut update = fields.clone();
    update["expectedRevision"] = json!(1);
    update["humanEstimateMinutes"] = Value::Null;
    assert_eq!(
        request(&app, Method::PUT, &path, &b, update.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    update
        .as_object_mut()
        .unwrap()
        .remove("humanEstimateMinutes");
    update["status"] = json!("done");
    let (s, updated) = request(&app, Method::PUT, &path, &b, update).await;
    assert_eq!(s, StatusCode::OK, "{updated}");
    assert!(updated.get("humanEstimateMinutes").is_none());
    let (_, human) = request(&app, Method::GET, &path, &h, Value::Null).await;
    assert_eq!(human["humanEstimateMinutes"], 150);
    assert_eq!(human["notes"], "Decision trail");
    assert_eq!(
        request(
            &app,
            Method::GET,
            &format!("/projects/{channel}/history"),
            &b,
            Value::Null
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, history) = request(
        &app,
        Method::GET,
        &format!("/projects/{channel}/history"),
        &h,
        Value::Null,
    )
    .await;
    assert_eq!(history["history"].as_array().unwrap().len(), 2);
    drop(app);
    drop(state);
    let state = server(dir.path()).await;
    let app = create_api_router(state.clone()).with_state(state);
    let (_, saved) = request(&app, Method::GET, &path, &h, Value::Null).await;
    assert_eq!(saved["humanEstimateMinutes"], 150);
    assert_eq!(saved["checklist"][0]["id"], "step-one");
    let mut clear = fields;
    clear["humanEstimateMinutes"] = Value::Null;
    clear["expectedRevision"] = json!(2);
    let (s, cleared) = request(&app, Method::PUT, &path, &h, clear).await;
    assert_eq!(s, StatusCode::OK, "{cleared}");
    assert!(cleared["humanEstimateMinutes"].is_null());
}
#[tokio::test]
async fn worker_tools_are_scoped_idempotent_fenced_and_survive_restart() {
    let (dir, state, app, h, b, human, bot, channel) = fixture().await;
    let r = start(&app, &channel, &h, bot, "work").await;
    let r = claim_run(&app, &channel, &b, &r).await;
    let path = format!(
        "/projects/{channel}/runs/{}/step",
        r["runId"].as_str().unwrap()
    );
    let pending = start(&app, &channel, &h, bot, "chat").await;
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!(
                "/projects/{channel}/runs/{}/claim",
                pending["runId"].as_str().unwrap()
            ),
            &b,
            json!({"expectedRevision":1,"provider":"test","model":"test"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &path,
            &b,
            action(&r, "terminal", json!({}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &path,
            &b,
            action(&r, "create_card", json!({"humanEstimateMinutes":1}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let step = action(
        &r,
        "create_card",
        json!({"title":"Worker card","description":"Bounded","status":"todo","priority":"medium"}),
    );
    let (s, r) = request(&app, Method::POST, &path, &b, step.clone()).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["steps"].as_array().unwrap().len(), 1);
    let (s, retry) = request(&app, Method::POST, &path, &b, step).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(retry["revision"], r["revision"]);
    let (s, r) = request(
        &app,
        Method::POST,
        &path,
        &b,
        action(
            &r,
            "create_page",
            json!({"title":"Worker notes","body":"A persisted checkpoint"}),
        ),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    let cp = format!(
        "/projects/{channel}/runs/{}/control",
        r["runId"].as_str().unwrap()
    );
    let (s, paused) = request(
        &app,
        Method::POST,
        &cp,
        &h,
        json!({"expectedRevision":r["revision"],"action":"pause"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        request(
            &app,
            Method::POST,
            &path,
            &b,
            action(
                &r,
                "create_card",
                json!({"title":"Must not exist","status":"todo","priority":"medium"})
            )
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, resumed) = request(
        &app,
        Method::POST,
        &cp,
        &h,
        json!({"expectedRevision":paused["revision"],"action":"resume"}),
    )
    .await;
    let r = claim_run(&app, &channel, &b, &resumed).await;
    let (s, taken) = request(
        &app,
        Method::POST,
        &cp,
        &h,
        json!({"expectedRevision":r["revision"],"action":"takeover"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(taken["status"], "taken_over");
    assert_eq!(
        request(
            &app,
            Method::POST,
            &path,
            &b,
            action(&r, "complete", json!({"reply":"Too late"}))
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let (_, cards) = request(
        &app,
        Method::GET,
        &format!("/projects/{channel}/tasks"),
        &h,
        Value::Null,
    )
    .await;
    assert_eq!(cards["tasks"].as_array().unwrap().len(), 1);
    let (_, pages) = request(
        &app,
        Method::GET,
        &format!("/wiki/{channel}/pages"),
        &h,
        Value::Null,
    )
    .await;
    assert_eq!(pages["pages"].as_array().unwrap().len(), 1);
    drop(app);
    drop(state);
    let state = server(dir.path()).await;
    let saved = state
        .wdb
        .project_run(&channel, taken["runId"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(saved.status, "taken_over");
    assert_eq!(saved.steps.len(), 2);
    assert!(saved.pending.is_none());
    assert_eq!(saved.created_by_user_id, human);
}
#[tokio::test]
async fn chat_refuses_tools_and_revocation_stops_work() {
    let (_dir, state, app, h, b, human, bot, channel) = fixture().await;
    let r = start(&app, &channel, &h, bot, "chat").await;
    let r = claim_run(&app, &channel, &b, &r).await;
    let path = format!(
        "/projects/{channel}/runs/{}/step",
        r["runId"].as_str().unwrap()
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &path,
            &b,
            action(&r, "list_cards", json!({}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (s, done) = request(
        &app,
        Method::POST,
        &path,
        &b,
        action(&r, "complete", json!({"reply":"An ordinary answer"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(done["status"], "completed");
    let r = start(&app, &channel, &h, bot, "work").await;
    let r = claim_run(&app, &channel, &b, &r).await;
    let path = format!(
        "/projects/{channel}/runs/{}/step",
        r["runId"].as_str().unwrap()
    );
    state
        .wdb
        .remove_channel_member(&channel, human)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            Method::POST,
            &path,
            &b,
            action(&r, "list_cards", json!({}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    state
        .wdb
        .add_channel_member(&channel, human, MemberRole::Member)
        .await
        .unwrap();
    state
        .wdb
        .remove_channel_member(&channel, bot)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            Method::POST,
            &path,
            &b,
            action(&r, "list_cards", json!({}))
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}
#[tokio::test]
async fn pending_checkpoint_requires_review_after_restart() {
    let (dir, state, app, h, b, _, bot, channel) = fixture().await;
    let r = start(&app, &channel, &h, bot, "work").await;
    let r = claim_run(&app, &channel, &b, &r).await;
    let mut run = state
        .wdb
        .project_run(&channel, r["runId"].as_str().unwrap())
        .unwrap()
        .unwrap();
    run.pending = Some(wabidb::projections::project_runs::RunStep {
        operation_id: uuid::Uuid::new_v4().to_string(),
        tool: "create_page".into(),
        arguments: json!({"title":"Unknown outcome","body":"Review before retry"}),
        result: Value::Null,
    });
    run.revision += 1;
    state.wdb.save_project_run(&run, bot).await.unwrap();
    drop(app);
    drop(state);
    let state = server(dir.path()).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let cp = format!("/projects/{channel}/runs/{}/control", run.run_id);
    let (s, paused) = request(
        &app,
        Method::POST,
        &cp,
        &h,
        json!({"expectedRevision":run.revision,"action":"pause"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(paused["pending"]["tool"], "create_page");
    assert_eq!(
        request(
            &app,
            Method::POST,
            &cp,
            &h,
            json!({"expectedRevision":paused["revision"],"action":"resume"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (s, taken) = request(
        &app,
        Method::POST,
        &cp,
        &h,
        json!({"expectedRevision":paused["revision"],"action":"takeover"}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(taken["pending"]["tool"], "create_page");
}
#[tokio::test]
async fn claim_assigns_the_authenticated_actor_and_preserves_card_details() {
    let (_dir, state, app, h, b, human, bot, channel) = fixture().await;
    let tasks = format!("/projects/{channel}/tasks");
    let (s,card)=request(&app,Method::POST,&tasks,&h,json!({"operationId":uuid::Uuid::new_v4(),"title":"Claim me","status":"todo","priority":"medium","humanEstimateMinutes":90,"notes":"Keep this","checklist":[{"id":"one","title":"First","done":false}]})).await;
    assert_eq!(s, StatusCode::OK);
    let path = format!("{tasks}/{}/claim", card["taskId"].as_str().unwrap());
    let (s, claimed) = request(&app, Method::POST, &path, &h, json!({"expectedRevision":1})).await;
    assert_eq!(s, StatusCode::OK, "{claimed}");
    assert_eq!(claimed["assigneeUserId"], human);
    assert_eq!(claimed["status"], "in_progress");
    assert_eq!(claimed["humanEstimateMinutes"], 90);
    assert_eq!(claimed["notes"], "Keep this");
    assert_eq!(claimed["checklist"].as_array().unwrap().len(), 1);
    assert_eq!(
        request(&app, Method::POST, &path, &b, json!({"expectedRevision":1}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(&app, Method::POST, &path, &b, json!({"expectedRevision":2}))
            .await
            .0,
        StatusCode::CONFLICT
    );
    let task_path = format!("{tasks}/{}", card["taskId"].as_str().unwrap());
    let (s,reassigned)=request(&app,Method::PUT,&task_path,&b,json!({"expectedRevision":2,"title":"Claim me","description":"","status":"in_progress","priority":"medium","assigneeUserId":bot})).await;
    assert_eq!(s, StatusCode::OK, "{reassigned}");
    assert!(reassigned.get("humanEstimateMinutes").is_none());
    let (_, saved) = request(&app, Method::GET, &task_path, &h, Value::Null).await;
    assert_eq!(saved["humanEstimateMinutes"], 90);
    assert_eq!(saved["assigneeUserId"], bot);
    state
        .wdb
        .remove_channel_member(&channel, bot)
        .await
        .unwrap();
    assert_eq!(
        request(&app, Method::POST, &path, &b, json!({"expectedRevision":3}))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
}
#[tokio::test]
async fn step_budget_and_consent_are_enforced_by_the_server() {
    let (_dir, _state, app, h, b, _, bot, channel) = fixture().await;
    assert_eq!(request(&app,Method::POST,&format!("/projects/{channel}/runs"),&h,json!({"operationId":uuid::Uuid::new_v4(),"botUserId":bot,"mode":"work","prompt":"Test","providerConsent":false})).await.0,StatusCode::BAD_REQUEST);
    assert_eq!(request(&app,Method::POST,&format!("/projects/{channel}/runs"),&b,json!({"operationId":uuid::Uuid::new_v4(),"botUserId":bot,"mode":"work","prompt":"Test","providerConsent":true})).await.0,StatusCode::FORBIDDEN);
    let r = start(&app, &channel, &h, bot, "work").await;
    let mut r = claim_run(&app, &channel, &b, &r).await;
    let path = format!(
        "/projects/{channel}/runs/{}/step",
        r["runId"].as_str().unwrap()
    );
    for _ in 0..12 {
        let (s, next) = request(
            &app,
            Method::POST,
            &path,
            &b,
            action(&r, "list_cards", json!({})),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "{next}");
        r = next;
    }
    assert_eq!(
        request(
            &app,
            Method::POST,
            &path,
            &b,
            action(
                &r,
                "create_card",
                json!({"title":"Over budget","status":"todo","priority":"medium"})
            )
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (s, r) = request(
        &app,
        Method::POST,
        &path,
        &b,
        action(&r, "complete", json!({"reply":"Completed the bounded run"})),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(r["status"], "completed");
}
