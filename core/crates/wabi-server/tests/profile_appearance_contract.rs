//! Actual profile saves, rejection, durable replay and media/container preservation.
use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc, time::Duration};
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
use wabidb::engine::wabi_store::WabiStore;

async fn server(path: &Path) -> Arc<AppState> {
    configured_server(path, vec![]).await
}

async fn configured_server(path: &Path, admin_user_ids: Vec<i64>) -> Arc<AppState> {
    Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "profile-appearance-contract-only".into(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
            node_id: "test".into(),
            is_primary: true,
            server_role: ServerRole::Authority,
            authority_url: None,
            admin_user_ids,
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

fn token(state: &AppState, uid: u64) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
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
    .unwrap()
}

fn router(state: &Arc<AppState>) -> Router {
    create_api_router(state.clone())
        .with_state(state.clone())
        .layer(wabi_server::socketio::create_socket_layer(state.clone()))
}

struct Client {
    app: Router,
    sid: String,
    events: Vec<Value>,
}
impl Client {
    async fn transport(app: &Router, method: Method, path: &str, body: String) -> String {
        let response = tokio::time::timeout(
            Duration::from_secs(3),
            app.clone().oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("content-type", "text/plain;charset=UTF-8")
                    .body(Body::from(body))
                    .unwrap(),
            ),
        )
        .await
        .expect("socket timeout")
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        String::from_utf8(
            to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap()
    }
    fn path(&self) -> String {
        format!("/socket.io/?EIO=4&transport=polling&sid={}", self.sid)
    }
    async fn connect(app: &Router, token: &str) -> Self {
        let open = Self::transport(
            app,
            Method::GET,
            "/socket.io/?EIO=4&transport=polling",
            String::new(),
        )
        .await;
        let handshake: Value = serde_json::from_str(open.strip_prefix('0').unwrap()).unwrap();
        let mut client = Self {
            app: app.clone(),
            sid: handshake["sid"].as_str().unwrap().into(),
            events: vec![],
        };
        Self::transport(
            app,
            Method::POST,
            &client.path(),
            format!("40{}", json!({"token":token})),
        )
        .await;
        let connected = Self::transport(app, Method::GET, &client.path(), String::new()).await;
        assert!(connected.starts_with("40"), "{connected}");
        // Namespace acceptance is not the application's initialized state.
        // Match the real client: finish join/init before issuing profile saves.
        client.emit("join", json!("test client")).await;
        client.event("init").await;
        client
    }
    async fn emit(&self, event: &str, payload: Value) {
        Self::transport(
            &self.app,
            Method::POST,
            &self.path(),
            format!("42{}", json!([event, payload])),
        )
        .await;
    }
    async fn event(&mut self, name: &str) -> Value {
        self.event_one_of(&[name]).await.1
    }
    async fn event_one_of(&mut self, names: &[&str]) -> (String, Value) {
        for _ in 0..20 {
            if let Some(index) = self
                .events
                .iter()
                .position(|event| names.iter().any(|name| event[0] == *name))
            {
                let event = self.events.remove(index);
                return (event[0].as_str().unwrap().into(), event[1].clone());
            }
            let batch = Self::transport(&self.app, Method::GET, &self.path(), String::new()).await;
            for packet in batch.split('\u{1e}') {
                if let Some(payload) = packet.strip_prefix("42") {
                    self.events.push(serde_json::from_str(payload).unwrap());
                } else if packet == "2" {
                    Self::transport(&self.app, Method::POST, &self.path(), "3".into()).await;
                }
            }
        }
        panic!("missing {names:?} event");
    }
}

fn design() -> Value {
    json!({"effect":"shimmer","color":"#55b3e8","color2":"#ea9bd7","angle":137.5,"glow":6.5,
        "animationSeconds":8,"plate":"gradient","plateColor":"#101820","plateColor2":"#324050","plateOpacity":0.65})
}

async fn http(
    app: &Router,
    token: &str,
    method: Method,
    path: &str,
    body: Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024)
        .await
        .unwrap();
    let body = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({"raw":String::from_utf8_lossy(&bytes)}));
    (status, body)
}

#[tokio::test]
#[ignore = "subprocess fixture invoked by profile_design_and_clears_survive_restart"]
async fn profile_replay_fixture_child() {
    let dir = std::env::var("WABI_PROFILE_REPLAY_TEST_DIR").unwrap();
    let state = server(Path::new(&dir)).await;
    let uid = state
        .wdb
        .create_user("artist", None, "registered-test-hash")
        .await
        .unwrap();
    let other = state
        .wdb
        .create_user("other", None, "registered-test-hash")
        .await
        .unwrap();
    let original = json!({"layout":{"panels":["people"]},"theme":{"theme_id":"light"},
        "railSide":"right","railDensity":"compact","background_image":{"url":"/uploads/background.gif"},
        "future_slot":{"keep":true},"profile_media":{"overlay_url":"/uploads/old.png","overlay_scale":1.25}});
    state
        .wdb
        .upsert_user_layout(uid, &original.to_string())
        .await
        .unwrap();
    let app = router(&state);
    let auth = token(&state, uid);
    let mut client = Client::connect(&app, &auth).await;
    let mut observer = Client::connect(&app, &token(&state, other)).await;
    client.emit("update-profile", json!({"requestId":"creator-save","targetUserId":other,
        "username":"Artist","profilePicture":"/uploads/avatar.gif","bio":"An artist","statusMessage":"Drawing",
        "usernameFont":{"family":"Georgia","design":design()},"bannerUrl":"/uploads/banner.gif",
        "overlayUrl":"/uploads/overlay.webp","overlayOffsetX":12})).await;
    let saved = client.event("profile-updated").await;
    assert_eq!(saved["profileRequestId"], "creator-save");
    assert_eq!(saved["dbUserId"], uid);
    assert_eq!(saved["usernameFont"]["design"], design());
    let public_update = observer.event("user-updated").await;
    assert_eq!(public_update["usernameFont"]["design"], design());
    assert!(
        public_update.get("profileRequestId").is_none(),
        "save correlation is private to its requester"
    );
    assert_eq!(
        state.wdb.get_user(other).await.unwrap().unwrap().username,
        "other"
    );
    let stored: Value = serde_json::from_str(
        &state
            .wdb
            .get_user_layout(uid)
            .await
            .unwrap()
            .unwrap()
            .layout_json,
    )
    .unwrap();
    for key in [
        "layout",
        "theme",
        "railSide",
        "railDensity",
        "background_image",
        "future_slot",
    ] {
        assert_eq!(stored[key], original[key], "clobbered {key}");
    }
    assert_eq!(stored["profile_media"]["overlay_scale"], 1.25);
    client
        .emit(
            "update-profile",
            json!({"requestId":"clear-fields","profilePicture":null,"bio":"","statusMessage":null}),
        )
        .await;
    let cleared = client.event("profile-updated").await;
    assert_eq!(cleared["profileRequestId"], "clear-fields");
    for key in ["profilePicture", "bio", "statusMessage"] {
        assert_eq!(cleared[key], "", "failed to clear {key}");
    }
    assert_eq!(
        http(&app, &auth, Method::POST, "/user/theme/reset", json!({}))
            .await
            .0,
        StatusCode::OK
    );
    let (status, media) = http(
        &app,
        &auth,
        Method::POST,
        "/user/profile-media",
        json!({"banner_url":"/uploads/replacement.png"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(media["overlay_url"], "/uploads/overlay.webp");
    assert_eq!(media["overlay_offset_x"], 12.0);
    assert_eq!(media["overlay_scale"], 1.25);
    let (status, settings) = http(&app, &auth, Method::GET, "/user/settings", json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(settings["displayName"], "Artist");
    assert_eq!(settings["avatarUrl"], "");
    assert_eq!(settings["statusMessage"], "");
    let (_, public) = http(
        &app,
        &auth,
        Method::GET,
        &format!("/user/profile/{uid}"),
        json!(null),
    )
    .await;
    assert_eq!(public["displayName"], "Artist");
    assert_eq!(public["avatarUrl"], "");
}

#[tokio::test]
async fn profile_design_and_clears_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "profile_replay_fixture_child",
            "--ignored",
            "--nocapture",
        ])
        .env("WABI_PROFILE_REPLAY_TEST_DIR", dir.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    let snapshot = dir.path().join("wabidb/projections/snapshot.json");
    if snapshot.exists() {
        std::fs::remove_file(snapshot).unwrap();
    }
    let state = server(dir.path()).await;
    let user = state
        .wdb
        .get_user_by_username("Artist")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(user.username_font.as_ref().unwrap()).unwrap()["design"],
        design()
    );
    assert_eq!(user.profile_picture.as_deref(), Some(""));
    assert_eq!(user.bio.as_deref(), Some(""));
    assert_eq!(user.status_message.as_deref(), Some(""));
    let root: Value = serde_json::from_str(
        &state
            .wdb
            .get_user_layout(user.user_id)
            .await
            .unwrap()
            .unwrap()
            .layout_json,
    )
    .unwrap();
    assert_eq!(root["theme"]["theme_id"], "dark");
    assert_eq!(root["railSide"], "right");
    assert_eq!(root["railDensity"], "compact");
    assert_eq!(root["future_slot"]["keep"], true);
    assert_eq!(root["background_image"]["url"], "/uploads/background.gif");
    assert_eq!(
        root["profile_media"]["banner_url"],
        "/uploads/replacement.png"
    );
    assert_eq!(
        root["profile_media"]["overlay_url"],
        "/uploads/overlay.webp"
    );
    let app = router(&state);
    let mut client = Client::connect(&app, &token(&state, user.user_id)).await;
    client.emit("join", json!("fresh connection")).await;
    let init = client.event("init").await;
    let roster_user = init["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["dbUserId"] == user.user_id)
        .unwrap();
    assert_eq!(
        roster_user["username"], "Artist",
        "a stale bearer name must not undo a saved rename"
    );
    assert_eq!(roster_user["usernameFont"]["design"], design());
    assert_eq!(roster_user["profilePicture"], "");
    assert_eq!(roster_user["statusMessage"], "");
}

#[tokio::test]
async fn malformed_designs_and_text_fail_before_any_profile_or_media_write() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let uid = state
        .wdb
        .create_user("artist", None, "registered-test-hash")
        .await
        .unwrap();
    let app = router(&state);
    let auth = token(&state, uid);
    let mut client = Client::connect(&app, &auth).await;
    let before = state.wdb.engine().projection_state().applied_commit_seq();
    let mut cases = Vec::new();
    for (field, invalid) in [
        ("color", json!("red;position:absolute")),
        ("angle", json!(361)),
        ("glow", json!(-1)),
        ("animationSeconds", json!(0.2)),
        ("plateOpacity", json!(2)),
        ("effect", json!("script")),
        ("plate", json!("image")),
    ] {
        let mut invalid_design = design();
        invalid_design[field] = invalid;
        cases.push(json!({"usernameFont":{"design":invalid_design}}));
    }
    let mut missing = design();
    missing.as_object_mut().unwrap().remove("plateColor");
    cases.push(json!({"usernameFont":{"design":missing}}));
    let mut extra = design();
    extra["css"] = json!("position:fixed");
    cases.push(json!({"usernameFont":{"design":extra}}));
    cases.extend([
        json!({"bio":"x".repeat(281)}),
        json!({"statusMessage":"bad\u{0001}"}),
        json!({"profilePicture":"data:image/png,bad"}),
        json!({"usernameFont":{"family":"Arial;position:fixed"}}),
        json!({"bannerUrl":42}),
        json!({"bio":42}),
    ]);
    for (index, mut request) in cases.into_iter().enumerate() {
        request["requestId"] = json!(format!("invalid-{index}"));
        request["username"] = json!("must not save");
        request["bannerUrl"] = request
            .get("bannerUrl")
            .cloned()
            .unwrap_or(json!("/uploads/must-not-save.png"));
        client.emit("update-profile", request).await;
        let failure = client.event("profile-update-failed").await;
        assert_eq!(failure["profileRequestId"], format!("invalid-{index}"));
        assert!(!failure["reason"].as_str().unwrap().is_empty());
        assert_eq!(
            state.wdb.engine().projection_state().applied_commit_seq(),
            before,
            "invalid case {index} wrote"
        );
    }
    assert_eq!(
        state.wdb.get_user(uid).await.unwrap().unwrap().username,
        "artist"
    );
    assert!(state.wdb.get_user_layout(uid).await.unwrap().is_none());
    // An application round trip flushes events queued before this rejection.
    client.emit("get-role-definitions", json!(null)).await;
    client.event("role-definitions-updated").await;
    assert!(!client
        .events
        .iter()
        .any(|event| event[0] == "profile-updated"));
    let (status, _) = http(
        &app,
        &auth,
        Method::POST,
        "/user/profile-media",
        json!({"overlay_url":"javascript:bad"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn media_write_failure_never_confirms_or_broadcasts_saved_media() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let uid = state
        .wdb
        .create_user("artist", None, "registered-test-hash")
        .await
        .unwrap();
    let app = router(&state);
    let mut client = Client::connect(&app, &token(&state, uid)).await;
    // Block this fresh layout stream with a file to cause a real storage I/O
    // failure using the baseline engine, without production fault-injection APIs.
    let stream_path = dir
        .path()
        .join("wabidb/streams/other")
        .join(format!("user_layouts:{uid}"));
    std::fs::create_dir_all(stream_path.parent().unwrap()).unwrap();
    std::fs::write(&stream_path, b"blocked layout stream").unwrap();
    client
        .emit(
            "update-profile",
            json!({"requestId":"media-fails","bannerUrl":"/uploads/banner.png"}),
        )
        .await;
    let failure = client.event("profile-update-failed").await;
    assert_eq!(failure["profileRequestId"], "media-fails");
    assert_eq!(failure["reason"], "failed to persist profile media");
    assert!(state.wdb.get_user_layout(uid).await.unwrap().is_none());
    client.emit("get-role-definitions", json!(null)).await;
    client.event("role-definitions-updated").await;
    assert!(!client
        .events
        .iter()
        .any(|event| event[0] == "profile-updated" || event[0] == "user-updated"));
}

#[tokio::test]
async fn legacy_fonts_and_settings_writes_remain_usable() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let uid = state
        .wdb
        .create_user("artist", None, "registered-test-hash")
        .await
        .unwrap();
    let app = router(&state);
    let auth = token(&state, uid);
    let mut client = Client::connect(&app, &auth).await;
    for value in [json!("Arial"), json!({"preset":"ocean","size":"1.2em"})] {
        client
            .emit("update-profile", json!({"usernameFont":value}))
            .await;
        assert!(client.event("profile-updated").await["usernameFont"].is_object());
    }
    let legacy_layout = json!({"dock":{"panels":["notes"]}});
    state
        .wdb
        .upsert_user_layout(uid, &legacy_layout.to_string())
        .await
        .unwrap();
    let (status, saved) = http(&app, &auth, Method::POST, "/user/settings", json!({
        "displayName":"REST Artist","avatarUrl":"/uploads/rest.gif","statusMessage":"REST status","theme":"light"})).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let user = state.wdb.get_user(uid).await.unwrap().unwrap();
    assert_eq!(user.username, "REST Artist");
    assert_eq!(user.profile_picture.as_deref(), Some("/uploads/rest.gif"));
    assert_eq!(user.status_message.as_deref(), Some("REST status"));
    let (_, settings) = http(&app, &auth, Method::GET, "/user/settings", json!(null)).await;
    assert_eq!(settings["theme"], "light");
    let root: Value = serde_json::from_str(
        &state
            .wdb
            .get_user_layout(uid)
            .await
            .unwrap()
            .unwrap()
            .layout_json,
    )
    .unwrap();
    assert_eq!(
        root["layout"], legacy_layout,
        "legacy raw layout must remain accessible"
    );
}

#[tokio::test]
async fn profile_upload_sniffs_the_extension_and_preserves_the_original_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let uid = state
        .wdb
        .create_user("artist", None, "registered-test-hash")
        .await
        .unwrap();
    let app = router(&state);
    let auth = token(&state, uid);
    let bytes = b"GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x00\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;";
    let mut body = b"--profile-fixture\r\nContent-Disposition: form-data; name=\"file\"; filename=\"pretend.html\"\r\nContent-Type: text/html\r\n\r\n".to_vec();
    body.extend_from_slice(bytes);
    body.extend_from_slice(b"\r\n--profile-fixture--\r\n");
    let response = app
        .clone()
        .oneshot(
            Request::post("/upload-profile-media")
                .header("authorization", format!("Bearer {auth}"))
                .header(
                    "content-type",
                    "multipart/form-data; boundary=profile-fixture",
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    let url = value["fileUrl"].as_str().unwrap();
    assert!(url.ends_with(".gif"));
    assert_eq!(
        std::fs::read(
            Path::new(&state.config.uploads_dir).join(url.strip_prefix("/uploads/").unwrap())
        )
        .unwrap(),
        bytes
    );
}
