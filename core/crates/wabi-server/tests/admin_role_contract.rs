//! Real Socket.IO → WabiStore → RBAC projection → receipt/roster contract.
use std::{path::Path, sync::Arc, time::Duration};
use axum::{body::{to_bytes, Body}, http::{Method, Request, StatusCode}, Router};
use serde_json::{json, Value};
use tower::ServiceExt;
use wabi_server::{api::routes::create_api_router, auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole}, state::AppState};
use wabidb::engine::wabi_store::WabiStore;

async fn server(path: &Path) -> Arc<AppState> {
    configured_server(path, vec![]).await
}

async fn configured_server(path: &Path, admin_user_ids: Vec<i64>) -> Arc<AppState> {
    Arc::new(AppState::new(ServerConfig {
        host: "127.0.0.1".into(), port: 0,
        data_dir: path.to_string_lossy().into_owned(), uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "admin-role-contract-only".into(), turn_enabled: false, turn_uri: None, turn_secret: None,
        node_id: "test".into(), is_primary: true, server_role: ServerRole::Authority, authority_url: None,
        admin_user_ids, blacklist_file: path.join("blacklist").to_string_lossy().into_owned(), max_body_size: None,
        mesh_enabled: false, mesh_peers: vec![], lore: LoreAddonConfig::default(),
    }).await.unwrap())
}

fn token(state: &AppState, uid: u64) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(&jsonwebtoken::Header::default(), &JwtClaims {
        sub: uid.to_string(), username: format!("user-{uid}"), is_guest: false,
        exp: now + 3600, iat: now, jti: uuid::Uuid::new_v4().to_string(), stepup: false, token_type: "access".into(),
    }, &jsonwebtoken::EncodingKey::from_secret(state.config.jwt_secret.as_bytes())).unwrap()
}

fn router(state: &Arc<AppState>) -> Router {
    create_api_router(state.clone()).with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()))
}

async fn seed(state: &AppState) -> (u64, u64, u64) {
    let owner = state.wdb.create_user("owner", None, "registered-test-hash").await.unwrap();
    let member = state.wdb.create_user("member", None, "registered-test-hash").await.unwrap();
    let guest = state.wdb.create_user("guest", None, "").await.unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    (owner, member, guest)
}

struct Client { app: Router, sid: String, events: Vec<Value> }
impl Client {
    async fn transport(app: &Router, method: Method, path: &str, body: String) -> String {
        let response = tokio::time::timeout(Duration::from_secs(3), app.clone().oneshot(Request::builder()
            .method(method).uri(path).header("content-type", "text/plain;charset=UTF-8").body(Body::from(body)).unwrap()))
            .await.expect("socket timeout").unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        String::from_utf8(to_bytes(response.into_body(), 1024 * 1024).await.unwrap().to_vec()).unwrap()
    }
    fn path(&self) -> String { format!("/socket.io/?EIO=4&transport=polling&sid={}", self.sid) }
    async fn connect(app: &Router, token: &str) -> Self {
        let open = Self::transport(app, Method::GET, "/socket.io/?EIO=4&transport=polling", String::new()).await;
        let handshake: Value = serde_json::from_str(open.strip_prefix('0').unwrap()).unwrap();
        let mut client = Self { app: app.clone(), sid: handshake["sid"].as_str().unwrap().into(), events: vec![] };
        Self::transport(app, Method::POST, &client.path(), format!("40{}", json!({"token":token}))).await;
        let connected = Self::transport(app, Method::GET, &client.path(), String::new()).await;
        assert!(connected.starts_with("40"), "{connected}");
        // Namespace acceptance is not the application's initialized state.
        // Match the real client: finish join/init before issuing admin commands.
        client.emit("join", json!("test client")).await;
        client.event("init").await;
        client
    }
    async fn emit(&self, event: &str, payload: Value) {
        Self::transport(&self.app, Method::POST, &self.path(), format!("42{}", json!([event, payload]))).await;
    }
    async fn event(&mut self, name: &str) -> Value {
        self.event_one_of(&[name]).await.1
    }
    async fn event_one_of(&mut self, names: &[&str]) -> (String, Value) {
        for _ in 0..20 {
            if let Some(index) = self.events.iter().position(|event| names.iter().any(|name| event[0] == *name)) {
                let event = self.events.remove(index);
                return (event[0].as_str().unwrap().into(), event[1].clone());
            }
            let batch = Self::transport(&self.app, Method::GET, &self.path(), String::new()).await;
            for packet in batch.split('\u{1e}') {
                if let Some(payload) = packet.strip_prefix("42") { self.events.push(serde_json::from_str(payload).unwrap()); }
                else if packet == "2" { Self::transport(&self.app, Method::POST, &self.path(), "3".into()).await; }
            }
        }
        panic!("missing {names:?} event");
    }
    async fn assign(&mut self, target: u64, role: &str, expected: &str) -> Value {
        let request = uuid::Uuid::new_v4().to_string();
        self.emit("assign-role", json!({"targetUserId":target,"roleName":role,"requestId":request})).await;
        let result = self.event(expected).await;
        assert_eq!(result["requestId"], request);
        result
    }
}

#[tokio::test]
async fn catalog_is_explicit_and_legacy_rename_cannot_write_or_change_membership() {
    let dir = tempfile::tempdir().unwrap(); let state = server(dir.path()).await;
    let (owner, _, _) = seed(&state).await; let app = router(&state);
    let mut client = Client::connect(&app, &token(&state, owner)).await;
    let before = state.wdb.engine().projection_state().applied_commit_seq();
    client.emit("get-role-definitions", json!(null)).await;
    let catalog = client.event("role-definitions-updated").await;
    assert_eq!(catalog["canRename"], false);
    assert_eq!(catalog["roles"].as_array().unwrap().iter().map(|r| r["roleName"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["owner", "admin", "mod", "member", "guest"]);
    for role in ["member", "Admin", "Owner", "unknown"] {
        client.emit("set-role-display-name", json!({"roleName":role,"displayName":"rename-canary"})).await;
        assert_eq!(client.event("set-role-display-name-error").await["code"], "unsupported");
    }
    assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), before);
    assert!(state.wdb.list_channel_members("").await.unwrap().is_empty());
    assert_eq!(state.get_user_highest_role(owner as i64).await, "Owner");
}

#[tokio::test]
async fn legacy_ban_rejects_without_persistence_disconnect_or_false_broadcasts() {
    let dir = tempfile::tempdir().unwrap(); let state = server(dir.path()).await;
    let (owner, member, _) = seed(&state).await; let app = router(&state);
    let mut admin = Client::connect(&app, &token(&state, owner)).await;
    let mut target = Client::connect(&app, &token(&state, member)).await;
    let before = state.wdb.engine().projection_state().applied_commit_seq();
    admin.emit("ban-user", json!({"targetUserId":member,"reason":"legacy request","requestId":"ban-canary"})).await;
    let error = admin.event("ban-error").await;
    assert_eq!(error["code"], "unsupported");
    assert_eq!(error["requestId"], "ban-canary");
    assert_eq!(error["targetUserId"], member);
    assert!(error["error"].as_str().unwrap().contains("No account access was changed"));
    assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), before);

    // A round trip on each live connection is an ordering barrier: any false
    // moderation broadcast queued before the rejection would be observed here.
    for client in [&mut admin, &mut target] {
        client.emit("get-role-definitions", json!(null)).await;
        client.event("role-definitions-updated").await;
        assert!(!client.events.iter().any(|event| event[0] == "ban" || event[0] == "user-banned"));
    }
    target.emit("ban-user", json!({"targetUserId":owner})).await;
    assert_eq!(target.event("ban-error").await["error"], "Only admins can ban users");
    assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), before);
}

#[tokio::test]
async fn legacy_minimum_role_settings_reject_atomically_without_false_channel_updates() {
    let dir = tempfile::tempdir().unwrap(); let state = server(dir.path()).await;
    let (owner, member, _) = seed(&state).await;
    let channel = state.wdb.create_channel("public canary", wabidb::domain::ChannelKind::Text, owner, false).await.unwrap();
    let app = router(&state);
    let mut admin = Client::connect(&app, &token(&state, owner)).await;
    let mut observer = Client::connect(&app, &token(&state, member)).await;
    let before = state.wdb.engine().projection_state().applied_commit_seq();
    let original = state.wdb.get_channel(&channel).await.unwrap().unwrap();
    let original_retention = state.channel_auto_delete_ms.read().await.get(&channel).copied();
    let original_retention_label = state.channel_auto_delete_label.read().await.get(&channel).cloned();
    for request in [
        json!({"channelId":channel,"minRole":"admin","name":"must not change","autoDeleteAfter":"1m"}),
        json!({"channelId":channel,"settings":{"minRole":"mod","name":"must not change","autoDeleteAfter":"live"}}),
        json!({"channelId":channel,"minRole":null,"settings":{"name":"must not change"}}),
        json!({"channelId":channel,"settings":{"minRole":null,"forceSpoiler":true}}),
    ] {
        admin.emit("update-channel-settings", request).await;
        let error = admin.event("channel-settings-error").await;
        assert_eq!(error["code"], "unsupported");
        assert_eq!(error["channelId"], channel);
        assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), before);
        assert_eq!(state.wdb.get_channel(&channel).await.unwrap().unwrap(), original);
        assert_eq!(state.channel_auto_delete_ms.read().await.get(&channel).copied(), original_retention);
        assert_eq!(state.channel_auto_delete_label.read().await.get(&channel).cloned(), original_retention_label);
        for client in [&mut admin, &mut observer] {
            client.emit("get-role-definitions", json!(null)).await;
            client.event("role-definitions-updated").await;
            assert!(!client.events.iter().any(|event| event[0] == "channel-settings-updated" || event[0] == "channel-updated"));
        }
    }

    // Only unsupported restrictions are retired; existing flat and nested
    // settings still persist and report the same result to connected clients.
    for request in [
        json!({"channelId":channel,"name":"supported flat rename"}),
        json!({"channelId":channel,"settings":{"name":"supported nested rename","forceSpoiler":true}}),
    ] {
        let expected = request.get("settings").unwrap_or(&request)["name"].clone();
        let before_update = state.wdb.engine().projection_state().applied_commit_seq();
        admin.emit("update-channel-settings", request).await;
        assert_eq!(admin.event("channel-settings-updated").await["name"], expected);
        assert_eq!(observer.event("channel-updated").await["name"], expected);
        assert_eq!(state.wdb.get_channel(&channel).await.unwrap().unwrap().name, expected.as_str().unwrap());
        assert!(state.wdb.engine().projection_state().applied_commit_seq() > before_update);
    }
    assert!(state.wdb.get_channel(&channel).await.unwrap().unwrap().force_spoiler);
}

#[tokio::test]
async fn lowercase_assignments_have_one_durable_authority_and_update_live_and_reloaded_rosters() {
    let dir = tempfile::tempdir().unwrap(); let state = server(dir.path()).await;
    let (owner, member, _) = seed(&state).await; let app = router(&state);
    let mut client = Client::connect(&app, &token(&state, owner)).await;
    for (input, stored, display) in [("admin", "Admin", "admin"), ("mod", "Moderator", "mod"), ("member", "Member", "member"), ("MoDeRaToR", "Moderator", "mod")] {
        let before = state.wdb.engine().projection_state().applied_commit_seq();
        assert_eq!(client.assign(member, input, "assign-role-success").await["role"], stored);
        assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), before + 1);
        assert_eq!(state.wdb.get_user_role("default-workspace", member).await.unwrap().as_deref(), Some(stored));
        assert_eq!(state.get_user_highest_role(member as i64).await, stored);
        assert_eq!(client.event("user-role-updated").await["highestRole"], display);
        let mut reload = Client::connect(&app, &token(&state, member)).await;
        reload.emit("join", json!("untrusted display name")).await;
        let init = reload.event("init").await;
        for field in ["users", "serverMembers"] {
            let user = init[field].as_array().unwrap().iter().find(|user| user["dbUserId"] == member).unwrap();
            assert_eq!(user["highestRole"], display, "{field}");
        }
        assert_eq!(init["roleDefinitions"].as_array().unwrap().len(), 5);
    }
    assert!(state.wdb.list_channel_members("").await.unwrap().is_empty());
}

#[tokio::test]
async fn role_changes_reject_unknown_guest_missing_member_and_owner_targets_without_writes() {
    let dir = tempfile::tempdir().unwrap(); let state = server(dir.path()).await;
    let (owner, member, guest) = seed(&state).await; let app = router(&state);
    let mut admin = Client::connect(&app, &token(&state, owner)).await;
    let mut ordinary = Client::connect(&app, &token(&state, member)).await;
    let before = state.wdb.engine().projection_state().applied_commit_seq();
    for (target, role) in [(member, "invalid"), (member, "guest"), (guest, "admin"), (999_999, "admin"), (owner, "member"), (member, "owner")] {
        admin.assign(target, role, "assign-role-error").await;
    }
    ordinary.assign(member, "admin", "assign-role-error").await;
    admin.emit("remove-role", json!({"targetUserId":owner,"roleName":"owner"})).await;
    admin.event("remove-role-error").await;
    assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), before);
    assert!(!state.is_admin(member as i64).await);
    assert!(!state.is_admin(guest as i64).await);
}

#[tokio::test]
async fn authorization_rechecks_current_role_and_legacy_removal_has_an_honest_receipt() {
    let dir = tempfile::tempdir().unwrap(); let state = server(dir.path()).await;
    let (owner, member, _) = seed(&state).await;
    let target = state.wdb.create_user("other-member", None, "registered-test-hash").await.unwrap();
    let app = router(&state);
    let mut admin = Client::connect(&app, &token(&state, owner)).await;
    let mut future_admin = Client::connect(&app, &token(&state, member)).await;
    admin.assign(member, "Admin", "assign-role-success").await;
    future_admin.assign(target, "mod", "assign-role-success").await;
    admin.assign(member, "member", "assign-role-success").await;
    future_admin.assign(target, "admin", "assign-role-error").await;
    admin.emit("remove-role", json!({"targetUserId":target,"roleName":"moderator"})).await;
    assert_eq!(admin.event("remove-role-success").await["role"], "Member");
    assert_eq!(state.get_user_highest_role(target as i64).await, "Member");
}

#[tokio::test]
async fn configured_administrator_cannot_be_reported_demoted_while_retaining_access() {
    let dir = tempfile::tempdir().unwrap();
    // Fresh fixture IDs are allocated in insertion order (owner=1, member=2).
    let state = configured_server(dir.path(), vec![2]).await;
    let (owner, member, _) = seed(&state).await;
    assert_eq!(member, 2);
    let app = router(&state); let mut client = Client::connect(&app, &token(&state, owner)).await;
    let before = state.wdb.engine().projection_state().applied_commit_seq();
    for role in ["member", "mod"] {
        assert!(client.assign(member, role, "assign-role-error").await["error"].as_str().unwrap().contains("server configuration"));
    }
    client.emit("remove-role", json!({"targetUserId":member,"roleName":"admin"})).await;
    assert!(client.event("remove-role-error").await["error"].as_str().unwrap().contains("server configuration"));
    assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), before);
    assert!(state.is_admin(member as i64).await);
    let response = app.oneshot(Request::get("/admin/stats")
        .header("authorization", format!("Bearer {}", token(&state, owner)))
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let stats: Value = serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap();
    for role in ["Owner", "Admin", "Guest"] {
        assert_eq!(stats["roleDistribution"].as_array().unwrap().iter().find(|entry| entry["role"] == role).unwrap()["count"], 1);
    }
    let unavailable = stats["extra"]["unavailableMetrics"].as_array().unwrap();
    for metric in ["totalMessages", "totalEmojis", "mutedUsers", "totalAuditEntries", "openReports", "recentAudit", "topUsers"] {
        assert!(unavailable.iter().any(|value| value == metric), "missing {metric} availability");
    }
    assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), before);
}

#[tokio::test]
#[ignore = "subprocess fixture invoked by role_assignment_survives_process_restart"]
async fn write_role_replay_fixture_child() {
    let dir = std::env::var("WABI_ROLE_REPLAY_TEST_DIR").expect("isolated replay fixture directory");
    let state = server(Path::new(&dir)).await; let (owner, member, _) = seed(&state).await;
    let app = router(&state); let mut client = Client::connect(&app, &token(&state, owner)).await;
    let _second_tab = Client::connect(&app, &token(&state, owner)).await;
    // This subprocess has exactly one server, matching the process-global
    // presence counter's production ownership. Other tests' servers cannot
    // interfere with its OnceLock while we prove the two-tab case.
    let response = app.clone().oneshot(Request::get("/admin/stats")
        .header("authorization", format!("Bearer {}", token(&state, owner)))
        .body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let stats: Value = serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap()).unwrap();
    assert_eq!(stats["overview"]["onlineUsers"], 1, "two tabs belong to one online member");
    client.assign(member, "admin", "assign-role-success").await;
}

#[tokio::test]
async fn concurrent_admin_replacements_publish_each_committed_role_in_order() {
    let dir = tempfile::tempdir().unwrap(); let state = server(dir.path()).await;
    let (owner, first_admin, _) = seed(&state).await;
    let second_admin = state.wdb.create_user("second-admin", None, "registered-test-hash").await.unwrap();
    let target = state.wdb.create_user("target", None, "registered-test-hash").await.unwrap();
    for admin in [first_admin, second_admin] {
        state.wdb.ingest_event("rbac", "assign_role", &json!({
            "userId":admin,"workspaceId":"default-workspace","role":"Admin","assignedBy":owner,
        })).await.unwrap();
    }
    let app = router(&state);
    let mut first = Client::connect(&app, &token(&state, first_admin)).await;
    let mut second = Client::connect(&app, &token(&state, second_admin)).await;
    let mut observer = Client::connect(&app, &token(&state, owner)).await;
    let before = state.wdb.engine().projection_state().applied_commit_seq();
    tokio::join!(
        first.emit("assign-role", json!({"targetUserId":target,"roleName":"admin","requestId":"first"})),
        second.emit("assign-role", json!({"targetUserId":target,"roleName":"mod","requestId":"second"})),
    );
    assert_eq!(first.event("assign-role-success").await["role"], "Admin");
    assert_eq!(second.event("assign-role-success").await["role"], "Moderator");
    let a = observer.event("user-role-updated").await;
    let b = observer.event("user-role-updated").await;
    assert_eq!(a["dbUserId"], target); assert_eq!(b["dbUserId"], target);
    assert_ne!(a["highestRole"], b["highestRole"], "neither committed transition may be overwritten before publication");
    let final_role = if b["highestRole"] == "admin" { "Admin" } else { "Moderator" };
    assert_eq!(state.get_user_highest_role(target as i64).await, final_role);
    assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), before + 2);

    // Demotion and another command by that same administrator have two valid
    // serial orders. Once demotion wins, stale socket identity cannot authorize
    // a new write. If the other command wins first, it must be acknowledged.
    let before_demotion = state.wdb.engine().projection_state().applied_commit_seq();
    tokio::join!(
        observer.emit("assign-role", json!({"targetUserId":first_admin,"roleName":"member","requestId":"demote"})),
        first.emit("assign-role", json!({"targetUserId":target,"roleName":"admin","requestId":"racing"})),
    );
    assert_eq!(observer.event("assign-role-success").await["requestId"], "demote");
    let (kind, result) = first.event_one_of(&["assign-role-success", "assign-role-error"]).await;
    assert_eq!(result["requestId"], "racing");
    let accepted = kind == "assign-role-success";
    assert_eq!(state.get_user_highest_role(first_admin as i64).await, "Member");
    assert_eq!(state.get_user_highest_role(target as i64).await, if accepted { "Admin" } else { final_role });
    assert_eq!(state.wdb.engine().projection_state().applied_commit_seq(), before_demotion + if accepted { 2 } else { 1 });
}

#[tokio::test]
async fn role_assignment_survives_process_restart() {
    let dir = tempfile::tempdir().unwrap();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "write_role_replay_fixture_child", "--ignored", "--nocapture"])
        .env("WABI_ROLE_REPLAY_TEST_DIR", dir.path()).output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let state = server(dir.path()).await;
    let member = state.wdb.list_users().await.unwrap().into_iter().find(|user| user.username == "member").unwrap().user_id;
    assert!(state.is_admin(member as i64).await);
    assert_eq!(state.wdb.get_user_role("default-workspace", member).await.unwrap().as_deref(), Some("Admin"));
    let app = router(&state); let mut client = Client::connect(&app, &token(&state, member)).await;
    client.emit("join", json!("restarted")).await;
    let init = client.event("init").await;
    assert_eq!(init["users"].as_array().unwrap().iter().find(|user| user["dbUserId"] == member).unwrap()["highestRole"], "admin");
}
