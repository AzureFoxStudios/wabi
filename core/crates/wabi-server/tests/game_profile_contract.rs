//! Exercise authorization through the production REST router and real WabiDB.
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
use wabidb::{
    engine::wabi_store::WabiStore,
};

async fn server(path: &Path) -> Arc<AppState> {
    Arc::new(
        AppState::new(ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            data_dir: path.to_string_lossy().into_owned(),
            uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
            jwt_secret: "channel-access-test-only".into(),
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

fn jwt(state: &AppState, uid: u64) -> String {
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

async fn request(
    app: &Router,
    method: Method,
    path: &str,
    token: &str,
    body: Value,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if !token.is_empty() {
        req = req.header("authorization", format!("Bearer {token}"));
    }
    let res = app
        .clone()
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))),
    )
}


fn entry(shared: bool) -> Value {
    json!({"key":"steam:570","title":"Dota 2","platform":"PC","tags":["Casual"],"note":"game-note-canary","rotation":true,"favorite":false,"invitations":true,"visibility":if shared {"server"} else {"private"}})
}
#[tokio::test]
async fn games_http_persistence_privacy_cas_and_membership() {
    let dir=tempfile::tempdir().unwrap();let state=server(dir.path()).await;
    let a=state.wdb.create_user("a",None,"hash").await.unwrap();
    let b=state.wdb.create_user("b",None,"hash").await.unwrap();
    let outsider=state.wdb.create_user("outsider",None,"hash").await.unwrap();
    let ta=jwt(&state,a);let tb=jwt(&state,b);let to=jwt(&state,outsider);
    let app=create_api_router(state.clone()).with_state(state.clone());
    assert_eq!(request(&app,Method::GET,"/games/me","",Value::Null).await.0,StatusCode::UNAUTHORIZED);
    let (status,initial)=request(&app,Method::GET,"/games/me",&ta,Value::Null).await;
    assert_eq!(status,StatusCode::OK);assert_eq!(initial["revision"],"0");
    let (_,saved)=request(&app,Method::PUT,"/games/me",&ta,json!({"revision":"0","entries":[entry(false)],"showSteamLink":false})).await;
    assert_ne!(saved["revision"],"0");
    let (_,read)=request(&app,Method::GET,"/games/me",&ta,Value::Null).await;assert_eq!(read,saved);
    let (_,visible)=request(&app,Method::GET,&format!("/games/profile/{a}"),&tb,Value::Null).await;
    assert_eq!(visible["entries"],json!([]));assert!(!visible.to_string().contains("canary"));assert!(visible.get("steamId").is_none());
    assert_eq!(request(&app,Method::PUT,"/games/me",&ta,json!({"revision":"0","entries":[],"showSteamLink":false})).await.0,StatusCode::CONFLICT);
    assert_eq!(request(&app,Method::PUT,"/games/me",&tb,json!({"revision":"0","entries":[],"showSteamLink":false,"steamId":"76561198000000000"})).await.0,StatusCode::UNPROCESSABLE_ENTITY);
    let (_,b_saved)=request(&app,Method::PUT,"/games/me",&tb,json!({"revision":"0","entries":[entry(true)],"showSteamLink":false})).await;
    assert!(b_saved["revision"].as_str().is_some());
    state.wdb.create_group("group-games", "games",a,&[a,b]).await.unwrap();
    let compare=json!({"channelId":"group-games","participantIds":[a.to_string(),b.to_string()]});
    let (_,no_match)=request(&app,Method::POST,"/games/match",&ta,compare.clone()).await;assert_eq!(no_match["games"],json!([]));
    let (_,shared)=request(&app,Method::PUT,"/games/me",&ta,json!({"revision":saved["revision"],"entries":[entry(true)],"showSteamLink":false})).await;
    let (s,matched)=request(&app,Method::POST,"/games/match",&ta,compare.clone()).await;
    assert_eq!(s,StatusCode::OK);assert_eq!(matched["games"].as_array().unwrap().len(),1);assert_eq!(matched["compatibilityVerified"],false);
    assert_eq!(request(&app,Method::GET,"/games/members/group-games",&to,Value::Null).await.0,StatusCode::FORBIDDEN);
    assert_ne!(request(&app,Method::POST,"/games/match",&to,json!({"channelId":"group-games","participantIds":[outsider.to_string(),b.to_string()]})).await.0,StatusCode::OK);
    state.wdb.remove_channel_member("group-games",b).await.unwrap();
    assert_eq!(request(&app,Method::POST,"/games/match",&ta,compare).await.0,StatusCode::FORBIDDEN);
    let (s,clear)=request(&app,Method::PUT,"/games/me",&ta,json!({"revision":shared["revision"],"entries":[],"showSteamLink":false})).await;
    assert_eq!(s,StatusCode::OK);assert_eq!(clear["entries"],json!([]));
    // A privacy boundary includes errors and empty responses, not just populated cards.
    let res=app.oneshot(Request::get("/games/me").header("authorization",format!("Bearer {ta}")).body(Body::empty()).unwrap()).await.unwrap();
    assert!(res.headers()["cache-control"].to_str().unwrap().contains("no-store"));
}
#[tokio::test]
async fn games_deleted_account_cannot_leave_a_live_profile() {
    let dir=tempfile::tempdir().unwrap();let state=server(dir.path()).await;
    let uid=state.wdb.create_user("delete-me",None,"hash").await.unwrap();
    state.wdb.mutate_game_profile(uid,"0",|row|{row.steam_id=Some("76561198000000000".into());Ok(())}).await.unwrap();
    state.wdb.delete_user(uid).await.unwrap();
    assert!(state.wdb.engine().projection_state().get(wabidb::projections::game_profiles::INDEX,&uid.to_be_bytes()).is_none());
    assert!(state.wdb.mutate_game_profile(uid,"0",|_|Ok(())).await.is_err());
}
#[tokio::test]
async fn game_profile_crash_writer() {
    let Ok(path)=std::env::var("WABI_GAME_REPLAY_TEST") else {return;};
    let store=wabi_server::adapter::WdbAdapter::open(Path::new(&path)).await.unwrap();
    let uid=store.create_user("replay-person",None,"unchanged-account-hash").await.unwrap();
    store.mutate_game_profile(uid,"0",|row|{row.steam_id=Some("76561198000000000".into());row.entries=serde_json::from_value(json!([entry(false)])).unwrap();Ok(())}).await.unwrap();
    std::process::exit(0); // Skip Drop/snapshot: parent must replay committed segments.
}
#[tokio::test]
async fn games_replay_after_process_exit_preserves_account_and_private_board() {
    let dir=tempfile::tempdir().unwrap();
    let status=std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","game_profile_crash_writer","--nocapture"])
        .env("WABI_GAME_REPLAY_TEST",dir.path()).status().unwrap();assert!(status.success());
    let store=wabi_server::adapter::WdbAdapter::open(dir.path()).await.unwrap();
    let user=store.get_user_by_username("replay-person").await.unwrap().unwrap();
    assert_eq!(user.password_hash,"unchanged-account-hash");
    let row=store.get_game_profile(user.user_id).unwrap();assert_eq!(row.entries.len(),1);assert_eq!(row.steam_id.as_deref(),Some("76561198000000000"));
    assert_eq!(row.entries[0].visibility,wabidb::projections::game_profiles::Visibility::Private);
}
