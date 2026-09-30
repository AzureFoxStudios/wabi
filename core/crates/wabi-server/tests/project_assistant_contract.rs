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
    state
        .set_addon_enabled("project-workers", true)
        .await
        .unwrap();
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

async fn enroll(app: &Router, channel: &str, bot: &str, id: &str) -> Value {
    let (status, worker)=request(app,Method::POST,&format!("/projects/{channel}/workers"),bot,json!({"workerId":id,"name":"Test computer","harness":"api_worker","provider":"test","model":"test"})).await;
    assert_eq!(status, StatusCode::OK, "{worker}");
    worker
}

#[tokio::test]
async fn worker_addon_is_opt_in_and_its_kill_switch_stops_registered_writes() {
    let (_dir, state, app, h, b, _human, bot, channel) = fixture().await;
    state
        .set_addon_enabled("project-workers", false)
        .await
        .unwrap();
    let (s, inventory) = request(
        &app,
        Method::GET,
        &format!("/projects/{channel}/workers"),
        &h,
        json!({}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(inventory["enabled"], false);
    assert!(inventory["workers"].as_array().unwrap().is_empty());
    let id = uuid::Uuid::new_v4().to_string();
    let registration = json!({"workerId":id,"name":"Computer","harness":"api_worker","provider":"test","model":"test"});
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!("/projects/{channel}/workers"),
            &b,
            registration.clone()
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    state
        .set_addon_enabled("project-workers", true)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!("/projects/{channel}/workers"),
            &h,
            registration
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    enroll(&app, &channel, &b, &id).await;
    let (_,r)=request(&app,Method::POST,&format!("/projects/{channel}/runs"),&h,json!({"operationId":uuid::Uuid::new_v4(),"botUserId":bot,"mode":"chat","prompt":"Kill switch","providerConsent":true,"workerId":id})).await;
    let (_, r) = request(
        &app,
        Method::POST,
        &format!(
            "/projects/{channel}/runs/{}/claim",
            r["runId"].as_str().unwrap()
        ),
        &b,
        json!({"expectedRevision":r["revision"],"workerId":id,"provider":"test","model":"test"}),
    )
    .await;
    state
        .set_addon_enabled("project-workers", false)
        .await
        .unwrap();
    let mut complete = action(&r, "complete", json!({"reply":"Must not be accepted"}));
    complete["workerId"] = json!(id);
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!(
                "/projects/{channel}/runs/{}/step",
                r["runId"].as_str().unwrap()
            ),
            &b,
            complete
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        state
            .wdb
            .project_run(&channel, r["runId"].as_str().unwrap())
            .unwrap()
            .unwrap()
            .status,
        "running"
    );
}

#[tokio::test]
async fn ordinary_members_cannot_remove_computers_and_bot_revocation_stops_contact() {
    let (_dir, state, app, h, b, _human, bot, channel) = fixture().await;
    let id = uuid::Uuid::new_v4().to_string();
    enroll(&app, &channel, &b, &id).await;
    let member = state.wdb.create_user("member", None, "hash").await.unwrap();
    state
        .wdb
        .add_channel_member(&channel, member, MemberRole::Member)
        .await
        .unwrap();
    let credential = jwt(&state, member);
    let (s, roster) = request(
        &app,
        Method::GET,
        &format!("/projects/{channel}/workers"),
        &credential,
        json!({}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(roster["workers"][0]["canRemove"], false);
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("/projects/{channel}/workers/{id}"),
            &credential,
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!("/projects/{channel}/workers/{id}/heartbeat"),
            &h,
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    state
        .wdb
        .remove_channel_member(&channel, bot)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!("/projects/{channel}/workers/{id}/heartbeat"),
            &b,
            json!({})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let (_, roster) = request(
        &app,
        Method::GET,
        &format!("/projects/{channel}/workers"),
        &h,
        json!({}),
    )
    .await;
    assert!(roster["workers"].as_array().unwrap().is_empty());
}

/// A disposable real Authority for the parameterized two-computer harness.
/// No model is called and no production account/data is used. Never run this
/// fixture against a live store or expose its loopback listener publicly.
#[tokio::test]
#[ignore = "requires the external two-computer recovery harness"]
async fn two_computer_recovery_fixture() {
    let output = std::path::PathBuf::from(
        std::env::var("WABI_RECOVERY_FIXTURE_DIR").expect("fixture output directory"),
    );
    std::fs::create_dir_all(&output).unwrap();
    let (_dir, state, app, h, b, _human, bot, channel) = fixture().await;
    let a = uuid::Uuid::new_v4().to_string();
    let backup = uuid::Uuid::new_v4().to_string();
    for (id, name) in [
        (&a, "Primary test computer"),
        (&backup, "Backup test computer"),
    ] {
        let (s,r)=request(&app,Method::POST,&format!("/projects/{channel}/workers"),&b,json!({"workerId":id,"name":name,"harness":"api_worker","provider":"127.0.0.1","model":"fixture-no-model"})).await;
        assert_eq!(s, StatusCode::OK, "{r}");
    }
    let (s,run)=request(&app,Method::POST,&format!("/projects/{channel}/runs"),&h,json!({"operationId":uuid::Uuid::new_v4(),"botUserId":bot,"mode":"work","prompt":"Create exactly one disposable card, then continue from the saved step after interruption.","providerConsent":true,"workerId":a,"recoveryPolicy":{"automatic":true,"backupWorkerIds":[backup],"maxRecoveries":1}})).await;
    assert_eq!(s, StatusCode::OK, "{run}");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let serve_app = Router::new().nest("/api", app.clone());
    let http = tokio::spawn(async move {
        axum::serve(listener, serve_app).await.unwrap();
    });
    let config = json!({"wabi":format!("http://127.0.0.1:{port}"),"channel":channel,"botToken":b.strip_prefix("Bot ").unwrap(),"provider":"http://127.0.0.1:2","apiKey":"fixture-no-provider-key","model":"fixture-no-model","primaryId":a,"backupId":backup});
    let config_path = output.join("connection.json");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&config_path)
            .unwrap();
        file.write_all(config.to_string().as_bytes()).unwrap();
    }
    #[cfg(not(unix))]
    std::fs::write(&config_path, config.to_string()).unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(420);
    loop {
        let current = state
            .wdb
            .project_run(&channel, run["runId"].as_str().unwrap())
            .unwrap()
            .unwrap();
        if current.status == "completed" {
            assert_eq!(current.worker_id.as_deref(), Some(backup.as_str()));
            assert_eq!(current.recovery_count, 1);
            assert_eq!(current.steps.len(), 2);
            assert_eq!(state.wdb.list_project_tasks(&channel).unwrap().len(), 1);
            // Also expose the current token for A's actual returning write probe.
            std::fs::write(output.join("completed.json"),json!({"runId":current.run_id,"revision":current.revision,"attempt":current.attempt,"steps":current.steps.len(),"recoveryCount":current.recovery_count}).to_string()).unwrap();
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "two-computer fixture timed out"
        );
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    while !output.join("returning-worker-rejected").exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "returning worker did not probe stale write rejection"
        );
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert_eq!(state.wdb.list_project_tasks(&channel).unwrap().len(), 1);
    http.abort();
    std::fs::remove_file(config_path).unwrap();
}

#[tokio::test]
async fn registered_workers_recover_expired_attempts_only_with_explicit_policy() {
    let (dir, state, app, h, b, human, bot, channel) = fixture().await;
    let a = uuid::Uuid::new_v4().to_string();
    let backup = uuid::Uuid::new_v4().to_string();
    enroll(&app, &channel, &b, &a).await;
    enroll(&app, &channel, &b, &backup).await;
    let (s,r)=request(&app,Method::POST,&format!("/projects/{channel}/runs"),&h,json!({"operationId":uuid::Uuid::new_v4(),"botUserId":bot,"mode":"work","prompt":"Disposable recovery","providerConsent":true,"workerId":a,"recoveryPolicy":{"automatic":true,"backupWorkerIds":[backup],"maxRecoveries":1}})).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    let claim = format!(
        "/projects/{channel}/runs/{}/claim",
        r["runId"].as_str().unwrap()
    );
    let (s, started) = request(
        &app,
        Method::POST,
        &claim,
        &b,
        json!({"expectedRevision":r["revision"],"provider":"test","model":"test","workerId":a}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{started}");
    // A backup cannot take a live attempt, even with the same bot credential.
    assert_eq!(request(&app,Method::POST,&claim,&b,json!({"expectedRevision":started["revision"],"provider":"test","model":"test","workerId":backup})).await.0,StatusCode::CONFLICT);
    let step = format!(
        "/projects/{channel}/runs/{}/step",
        r["runId"].as_str().unwrap()
    );
    let mut create = action(
        &started,
        "create_card",
        json!({"title":"Saved before interruption","status":"todo","priority":"medium"}),
    );
    create["workerId"] = json!(a);
    let (s, saved) = request(&app, Method::POST, &step, &b, create).await;
    assert_eq!(s, StatusCode::OK, "{saved}");
    let mut expired = state
        .wdb
        .project_run(&channel, r["runId"].as_str().unwrap())
        .unwrap()
        .unwrap();
    expired.lease_until_micros = 1;
    state.wdb.save_project_run(&expired, human).await.unwrap();
    // Lease expiry alone is insufficient while the computer still reports contact.
    assert_eq!(request(&app,Method::POST,&claim,&b,json!({"expectedRevision":expired.revision,"provider":"test","model":"test","workerId":backup})).await.0,StatusCode::CONFLICT);
    let mut missing = state.wdb.project_worker(&channel, &a).unwrap().unwrap();
    missing.last_seen_micros = 1;
    state
        .wdb
        .save_project_worker(&missing, human)
        .await
        .unwrap();
    let (s,recovered)=request(&app,Method::POST,&claim,&b,json!({"expectedRevision":expired.revision,"provider":"test","model":"test","workerId":backup})).await;
    assert_eq!(s, StatusCode::OK, "{recovered}");
    assert_eq!(recovered["recoveryCount"], 1);
    assert_eq!(recovered["workerId"], backup);
    assert_eq!(recovered["steps"].as_array().unwrap().len(), 1);
    // Returning A cannot write with either an old attempt or B's observed revision.
    let mut stale = action(
        &recovered,
        "create_card",
        json!({"title":"Must not exist","status":"todo","priority":"medium"}),
    );
    stale["workerId"] = json!(a);
    assert_eq!(
        request(&app, Method::POST, &step, &b, stale).await.0,
        StatusCode::CONFLICT
    );
    let mut complete = action(
        &recovered,
        "complete",
        json!({"reply":"Resumed saved work"}),
    );
    complete["workerId"] = json!(backup);
    assert_eq!(
        request(&app, Method::POST, &step, &b, complete).await.0,
        StatusCode::OK
    );
    assert_eq!(state.wdb.list_project_tasks(&channel).unwrap().len(), 1);
    drop(app);
    drop(state);
    let state = server(dir.path()).await;
    let recovered = state
        .wdb
        .project_run(&channel, r["runId"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(recovered.status, "completed");
    assert_eq!(recovered.recovery_count, 1);
    assert_eq!(state.wdb.project_workers(&channel).unwrap().len(), 2);
}

#[tokio::test]
async fn manual_transfer_and_removed_registration_are_fenced() {
    let (_dir, state, app, h, b, human, bot, channel) = fixture().await;
    state.wdb.claim_owner(human).await.unwrap();
    *state.owner_user_id.write().await = Some(human as i64);
    let a = uuid::Uuid::new_v4().to_string();
    let backup = uuid::Uuid::new_v4().to_string();
    enroll(&app, &channel, &b, &a).await;
    enroll(&app, &channel, &b, &backup).await;
    let (_,r)=request(&app,Method::POST,&format!("/projects/{channel}/runs"),&h,json!({"operationId":uuid::Uuid::new_v4(),"botUserId":bot,"mode":"chat","prompt":"Manual recovery","providerConsent":true,"workerId":a})).await;
    let claim = format!(
        "/projects/{channel}/runs/{}/claim",
        r["runId"].as_str().unwrap()
    );
    let (_, r) = request(
        &app,
        Method::POST,
        &claim,
        &b,
        json!({"expectedRevision":r["revision"],"provider":"test","model":"test","workerId":a}),
    )
    .await;
    let mut expired = state
        .wdb
        .project_run(&channel, r["runId"].as_str().unwrap())
        .unwrap()
        .unwrap();
    expired.lease_until_micros = 1;
    state.wdb.save_project_run(&expired, human).await.unwrap();
    assert_eq!(request(&app,Method::POST,&claim,&b,json!({"expectedRevision":r["revision"],"provider":"test","model":"test","workerId":backup})).await.0,StatusCode::CONFLICT);
    let (s, resumed) = request(
        &app,
        Method::POST,
        &format!(
            "/projects/{channel}/runs/{}/control",
            r["runId"].as_str().unwrap()
        ),
        &h,
        json!({"expectedRevision":r["revision"],"action":"resume","workerId":backup}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{resumed}");
    let (s,r)=request(&app,Method::POST,&claim,&b,json!({"expectedRevision":resumed["revision"],"provider":"test","model":"test","workerId":backup})).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("/projects/{channel}/workers/{backup}"),
            &h,
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!("/projects/{channel}/workers/{backup}/heartbeat"),
            &b,
            json!({})
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    let mut complete = action(&r, "complete", json!({"reply":"Must be refused"}));
    complete["workerId"] = json!(backup);
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!(
                "/projects/{channel}/runs/{}/step",
                r["runId"].as_str().unwrap()
            ),
            &b,
            complete
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn independent_backup_services_require_the_pinned_model_safe_checkpoint_and_remaining_budget()
{
    let (_dir, state, app, h, b, human, bot, channel) = fixture().await;
    let backup_bot = state
        .wdb
        .create_user("backup-service", None, "hash")
        .await
        .unwrap();
    let (token, _) = state.bot_registry.create(backup_bot).await;
    let backup_auth = format!("Bot {token}");
    state
        .wdb
        .add_channel_member(&channel, backup_bot, MemberRole::Member)
        .await
        .unwrap();
    let a = uuid::Uuid::new_v4().to_string();
    let backup = uuid::Uuid::new_v4().to_string();
    let third = uuid::Uuid::new_v4().to_string();
    enroll(&app, &channel, &b, &a).await;
    enroll(&app, &channel, &backup_auth, &backup).await;
    enroll(&app, &channel, &backup_auth, &third).await;
    let (_,r)=request(&app,Method::POST,&format!("/projects/{channel}/runs"),&h,json!({"operationId":uuid::Uuid::new_v4(),"botUserId":bot,"workerId":a,"mode":"work","prompt":"Independent backup service","providerConsent":true,"recoveryPolicy":{"automatic":true,"backupWorkerIds":[backup,third],"maxRecoveries":1}})).await;
    let claim = format!(
        "/projects/{channel}/runs/{}/claim",
        r["runId"].as_str().unwrap()
    );
    let (_, r) = request(
        &app,
        Method::POST,
        &claim,
        &b,
        json!({"expectedRevision":r["revision"],"workerId":a,"provider":"test","model":"test"}),
    )
    .await;
    let (_, visible) = request(
        &app,
        Method::GET,
        &format!("/projects/{channel}/runs"),
        &backup_auth,
        json!({}),
    )
    .await;
    assert_eq!(visible["runs"][0]["runId"], r["runId"]);
    let mut stored = state
        .wdb
        .project_run(&channel, r["runId"].as_str().unwrap())
        .unwrap()
        .unwrap();
    stored.lease_until_micros = 1;
    let mut missing = state.wdb.project_worker(&channel, &a).unwrap().unwrap();
    missing.last_seen_micros = 1;
    state
        .wdb
        .save_project_worker(&missing, human)
        .await
        .unwrap();
    stored.pending = Some(wabidb::projections::project_runs::RunStep {
        operation_id: uuid::Uuid::new_v4().to_string(),
        tool: "create_card".into(),
        arguments: json!({"title":"Uncertain"}),
        result: Value::Null,
    });
    state.wdb.save_project_run(&stored, human).await.unwrap();
    let payload = json!({"expectedRevision":stored.revision,"workerId":backup,"provider":"test","model":"test"});
    assert_eq!(
        request(&app, Method::POST, &claim, &backup_auth, payload.clone())
            .await
            .0,
        StatusCode::CONFLICT
    );
    stored.pending = None;
    state.wdb.save_project_run(&stored, human).await.unwrap();
    let mut wrong_model = payload.clone();
    wrong_model["model"] = json!("different-model");
    assert_eq!(
        request(&app, Method::POST, &claim, &backup_auth, wrong_model)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let (s, recovered) = request(&app, Method::POST, &claim, &backup_auth, payload.clone()).await;
    assert_eq!(s, StatusCode::OK, "{recovered}");
    assert_eq!(recovered["botUserId"], backup_bot);
    assert_eq!(
        request(&app, Method::POST, &claim, &backup_auth, payload)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let original = state
        .wdb
        .project_run(&channel, r["runId"].as_str().unwrap())
        .unwrap()
        .unwrap();
    let mut exhausted = original.clone();
    exhausted.lease_until_micros = 1;
    state.wdb.save_project_run(&exhausted, human).await.unwrap();
    let mut missing = state
        .wdb
        .project_worker(&channel, &backup)
        .unwrap()
        .unwrap();
    missing.last_seen_micros = 1;
    state
        .wdb
        .save_project_worker(&missing, human)
        .await
        .unwrap();
    assert_eq!(request(&app,Method::POST,&claim,&backup_auth,json!({"expectedRevision":exhausted.revision,"workerId":third,"provider":"test","model":"test"})).await.0,StatusCode::CONFLICT);
    state.wdb.save_project_run(&original, human).await.unwrap();
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!("/projects/{channel}/workers/{backup}/heartbeat"),
            &backup_auth,
            json!({})
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut complete = action(
        &recovered,
        "complete",
        json!({"reply":"Recovered by the explicitly allowed service"}),
    );
    complete["workerId"] = json!(backup);
    assert_eq!(
        request(
            &app,
            Method::POST,
            &format!(
                "/projects/{channel}/runs/{}/step",
                r["runId"].as_str().unwrap()
            ),
            &backup_auth,
            complete
        )
        .await
        .0,
        StatusCode::OK
    );
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
