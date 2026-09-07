//! Repository credentials must remain capabilities, never become account logins.
//! Exercise the production API router and real WabiDB without an external Lore CLI.
#![cfg(feature = "wabi-lore")]

use std::{path::Path, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
    Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
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
            jwt_secret: "lore-contract-test-only".into(),
            turn_enabled: false,
            turn_uri: None,
            turn_secret: None,
            node_id: "test".into(),
            is_primary: true,
            server_role: ServerRole::Authority,
            authority_url: None,
            admin_user_ids: vec![],
            blacklist_file: path.join("blacklist.txt").to_string_lossy().into_owned(),
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
            username: "owner".into(),
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

async fn owner_and_repos(state: &AppState) -> (u64, i64, i64) {
    let uid = state
        .wdb
        .create_user("owner", None, "test-registered-hash")
        .await
        .unwrap();
    state.wdb.claim_owner(uid).await.unwrap();
    *state.owner_user_id.write().await = Some(uid as i64);
    let mut ids = Vec::new();
    for name in ["one", "two"] {
        let id = state
            .wdb
            .create_channel(name, ChannelKind::Lore, uid, false)
            .await
            .unwrap();
        state
            .wdb
            .add_channel_member(&id, uid, MemberRole::Member)
            .await
            .unwrap();
        ids.push(i64::from_str_radix(id.strip_prefix("ch_").unwrap(), 16).unwrap());
    }
    (uid, ids[0], ids[1])
}

async fn connect_token(state: &AppState, uid: u64, channel: i64, scopes: &str) -> (String, String) {
    let token = format!("wblore_{}", hex::encode(rand::random::<[u8; 32]>()));
    let hash = hex::encode(Sha256::digest(token.as_bytes()));
    state
        .wdb
        .lore_mint_token(&hash, channel, uid as i64, scopes)
        .await
        .unwrap();
    (token, hash)
}

async fn request(
    app: &Router,
    method: Method,
    path: &str,
    token: &str,
    payload: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(path);
    if !token.is_empty() {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let response = app
        .clone()
        .oneshot(
            builder
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let body =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (status, body)
}

#[tokio::test]
async fn connect_token_is_not_an_account_credential() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (uid, channel, _) = owner_and_repos(&state).await;
    let (token, _) = connect_token(&state, uid, channel, "read,write").await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    for path in ["/api/user/me", "/api/user/layout", "/api/user/profile/1"] {
        // create_api_router is mounted at /api by the application router.
        let (status, body) = request(
            &app,
            Method::GET,
            path.strip_prefix("/api").unwrap(),
            &token,
            json!(null),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}: {body}");
    }
    let (status, _) = request(
        &app,
        Method::GET,
        "/user/me",
        &jwt(&state, uid),
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "normal access JWT must still work");
}

#[tokio::test]
async fn connect_token_cannot_cross_repos_even_when_its_owner_can() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (uid, first, second) = owner_and_repos(&state).await;
    let (token, _) = connect_token(&state, uid, first, "read").await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let (status, _) = request(
        &app,
        Method::GET,
        &format!("/addons/lore/repos/{first}/changes"),
        &token,
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let path = format!("/addons/lore/repos/{second}/changes");
    let (status, body) = request(&app, Method::GET, &path, &token, json!(null)).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, _) = request(&app, Method::GET, &path, &jwt(&state, uid), json!(null)).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the owner still has ordinary access"
    );
}

#[tokio::test]
async fn connect_token_cannot_mint_a_successor_or_list_other_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (uid, channel, _) = owner_and_repos(&state).await;
    let (token, _) = connect_token(&state, uid, channel, "read,write").await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let path = format!("/addons/lore/repos/{channel}/connect-tokens");
    for method in [Method::GET, Method::POST] {
        let (status, body) = request(&app, method, &path, &token, json!({"scopes":"write"})).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    }
    assert_eq!(state.wdb.list_lore_tokens(channel).await.unwrap().len(), 1);
}

#[tokio::test]
async fn revocation_uses_the_identifier_returned_to_the_connect_panel() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (uid, channel, _) = owner_and_repos(&state).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let login = jwt(&state, uid);
    let path = format!("/addons/lore/repos/{channel}/connect-tokens");
    let (status, minted) =
        request(&app, Method::POST, &path, &login, json!({"scopes":"read"})).await;
    assert_eq!(status, StatusCode::OK, "{minted}");
    let token = minted["token"].as_str().unwrap();
    let (status, listed) = request(&app, Method::GET, &path, &login, json!(null)).await;
    assert_eq!(status, StatusCode::OK);
    let id = listed["tokens"][0]["tokenHashPrefix"].as_str().unwrap();
    let (status, body) = request(
        &app,
        Method::DELETE,
        &format!("{path}/{id}"),
        &login,
        json!(null),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the current UI submits this identifier: {body}"
    );
    let (status, _) = request(
        &app,
        Method::GET,
        &format!("/addons/lore/repos/{channel}/changes"),
        token,
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(state
        .wdb
        .list_lore_tokens(channel)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn read_only_and_cross_repo_writes_fail_before_file_side_effects() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (uid, channel, other) = owner_and_repos(&state).await;
    let (read, _) = connect_token(&state, uid, channel, "read").await;
    let (write, _) = connect_token(&state, uid, channel, "read,write").await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    for (method, suffix) in [
        (Method::PUT, "/files/example.txt"),
        (Method::DELETE, "/files/example.txt"),
        (Method::POST, "/lock/example.txt"),
        (Method::DELETE, "/lock/example.txt"),
        (Method::POST, "/snapshot"),
    ] {
        for (id, token) in [(channel, &read), (other, &write)] {
            let path = format!("/addons/lore/repos/{id}{suffix}");
            let (status, body) = request(&app, method.clone(), &path, token, json!({})).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {body}");
        }
    }
    for suffix in [
        "/files/nested/example.txt",
        "/manifest",
        "/archive",
        "/history",
        "/branches",
        "/history/example.txt",
        "/diff/example.txt?from=a&to=b",
    ] {
        let path = format!("/addons/lore/repos/{other}{suffix}");
        for method in [Method::GET, Method::HEAD] {
            let (status, body) = request(&app, method.clone(), &path, &write, json!(null)).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {body}");
        }
    }
    assert!(state
        .wdb
        .list_lore_file_changes(channel, 0)
        .await
        .unwrap()
        .is_empty());
    assert!(state
        .wdb
        .list_lore_file_changes(other, 0)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn write_tokens_cannot_manage_repos_execute_code_or_mint_download_capabilities() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (uid, channel, _) = owner_and_repos(&state).await;
    let (token, hash) = connect_token(&state, uid, channel, "read,write").await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    for (method, suffix) in [
        (Method::PATCH, ""),
        (Method::DELETE, ""),
        (Method::POST, "/editor"),
        (Method::GET, "/editor/sessions"),
        (Method::POST, "/scripts/run"),
        (Method::GET, "/scripts/active"),
        (Method::GET, "/mirror"),
        (Method::POST, "/mirror/run"),
        (Method::POST, "/external"),
        (Method::POST, "/branches"),
        (Method::GET, "/signed-url?path=example.txt"),
        (Method::POST, "/connect-tokens"),
    ] {
        let path = format!("/addons/lore/repos/{channel}{suffix}");
        let (status, body) = request(
            &app,
            method.clone(),
            &path,
            &token,
            json!({"scopes":"write"}),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}: {body}");
    }
    let path = format!("/addons/lore/repos/{channel}/connect-tokens/{hash}");
    assert_eq!(
        request(&app, Method::DELETE, &path, &token, json!(null))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    for path in [
        "/addons/lore/repos",
        "/addons/lore/repos/import",
        "/addons/lore/recordings",
        "/addons/lore/promote/from-message",
    ] {
        let (status, body) = request(
            &app,
            Method::POST,
            path,
            &token,
            json!({"channelId":channel}),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}: {body}");
    }
    assert_eq!(state.wdb.list_lore_tokens(channel).await.unwrap().len(), 1);
}

#[tokio::test]
async fn account_revocation_and_current_membership_apply_to_connect_tokens() {
    for revoke_all in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let state = server(dir.path()).await;
        let (uid, channel, _) = owner_and_repos(&state).await;
        let (token, _) = connect_token(&state, uid, channel, "read").await;
        let app = create_api_router(state.clone()).with_state(state.clone());
        let path = format!("/addons/lore/repos/{channel}/changes");
        assert_eq!(
            request(&app, Method::GET, &path, &token, json!(null))
                .await
                .0,
            StatusCode::OK
        );
        state
            .wdb
            .remove_channel_member(&format!("ch_{channel:x}"), uid)
            .await
            .unwrap();
        assert_eq!(
            request(&app, Method::GET, &path, &token, json!(null))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        state
            .wdb
            .add_channel_member(&format!("ch_{channel:x}"), uid, MemberRole::Member)
            .await
            .unwrap();
        if revoke_all {
            state.revoke_all_tokens().await;
        } else {
            state.revoke_user(uid as i64).await;
        }
        assert_eq!(
            request(&app, Method::GET, &path, &token, json!(null))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        drop(app);
        drop(state);
        let reopened = server(dir.path()).await;
        let app = create_api_router(reopened.clone()).with_state(reopened);
        assert_eq!(
            request(&app, Method::GET, &path, &token, json!(null))
                .await
                .0,
            StatusCode::UNAUTHORIZED,
            "account-wide revocation must survive restart"
        );
    }
}

#[tokio::test]
async fn token_management_is_self_service_unless_admin_and_prefix_collisions_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, channel, other) = owner_and_repos(&state).await;
    let member = state
        .wdb
        .create_user("member", None, "test-registered-hash")
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&format!("ch_{channel:x}"), member, MemberRole::Member)
        .await
        .unwrap();
    let (_, owner_hash) = connect_token(&state, owner, channel, "read").await;
    let (_, own_hash) = connect_token(&state, member, channel, "read").await;
    let (_, other_hash) = connect_token(&state, owner, other, "read").await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let path = format!("/addons/lore/repos/{channel}/connect-tokens");
    let login = jwt(&state, member);
    let (status, body) = request(&app, Method::GET, &path, &login, json!(null)).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "even after losing Artist, users can manage their own credentials"
    );
    assert_eq!(body["tokens"].as_array().unwrap().len(), 1);
    assert_eq!(body["tokens"][0]["userId"], member);
    for forbidden in [&owner_hash, &other_hash] {
        assert_eq!(
            request(
                &app,
                Method::DELETE,
                &format!("{path}/{}", &forbidden[..12]),
                &login,
                json!(null)
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("{path}/{}", &own_hash[..12]),
            &login,
            json!(null)
        )
        .await
        .0,
        StatusCode::OK
    );

    let hashes = [
        format!("abcdef012345{}", "a".repeat(52)),
        format!("abcdef012345{}", "b".repeat(52)),
    ];
    for hash in &hashes {
        state
            .wdb
            .lore_mint_token(hash, channel, owner as i64, "read")
            .await
            .unwrap();
    }
    let admin = jwt(&state, owner);
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("{path}/abcdef012345"),
            &admin,
            json!(null)
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    for hash in &hashes {
        assert!(state.wdb.lore_get_token(hash).await.unwrap().is_some());
    }
    assert_eq!(
        request(
            &app,
            Method::DELETE,
            &format!("{path}/{}", hashes[0]),
            &admin,
            json!(null)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(state
        .wdb
        .lore_get_token(&hashes[1])
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn unrecognized_scopes_neither_mint_nor_authenticate() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (uid, channel, _) = owner_and_repos(&state).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    for scope in [
        "overwrite",
        "read,admin",
        "",
        "read write",
        "read,write,admin",
    ] {
        let path = format!("/addons/lore/repos/{channel}/connect-tokens");
        assert_eq!(
            request(
                &app,
                Method::POST,
                &path,
                &jwt(&state, uid),
                json!({"scopes":scope})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        let (token, _) = connect_token(&state, uid, channel, scope).await;
        let path = format!("/addons/lore/repos/{channel}/changes");
        assert_eq!(
            request(&app, Method::GET, &path, &token, json!(null))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn token_scope_and_revocation_survive_reopening_wabidb() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (uid, channel, other) = owner_and_repos(&state).await;
    let (active, _) = connect_token(&state, uid, channel, "read").await;
    let (revoked, hash) = connect_token(&state, uid, channel, "read,write").await;
    state
        .wdb
        .lore_revoke_token(&hash, uid as i64)
        .await
        .unwrap();
    drop(state);
    let state = server(dir.path()).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    for (token, id, expected) in [
        (&active, channel, StatusCode::OK),
        (&active, other, StatusCode::FORBIDDEN),
        (&revoked, channel, StatusCode::UNAUTHORIZED),
    ] {
        let path = format!("/addons/lore/repos/{id}/changes");
        let (status, body) = request(&app, Method::GET, &path, token, json!(null)).await;
        assert_eq!(status, expected, "{body}");
    }
}

#[tokio::test]
async fn single_token_revocation_accepts_legacy_and_exact_session_ids_after_restart() {
    for short in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let state = server(dir.path()).await;
        let (uid, channel, _) = owner_and_repos(&state).await;
        let (revoked, hash) = connect_token(&state, uid, channel, "read").await;
        let (other, _) = connect_token(&state, uid, channel, "read").await;
        let id = if short { &hash[..12] } else { &hash };
        state
            .revoke_token_with_exp(format!("lore-token:{id}"), i64::MAX)
            .await;
        drop(state);
        let state = server(dir.path()).await;
        let app = create_api_router(state.clone()).with_state(state);
        let path = format!("/addons/lore/repos/{channel}/changes");
        assert_eq!(
            request(&app, Method::GET, &path, &revoked, json!(null))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&app, Method::GET, &path, &other, json!(null))
                .await
                .0,
            StatusCode::OK
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn scoped_tool_can_sync_files_but_cannot_bypass_revocation_with_a_cached_download() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (uid, channel, other) = owner_and_repos(&state).await;
    let binary = dir.path().join("lore-cli-fixture");
    std::fs::write(
        &binary,
        include_bytes!("fixtures/lore-cli-credential-fixture.sh"),
    )
    .unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let lore = Arc::new(wabi_lore::LoreService::new(wabi_lore::LoreConfig {
        enabled: true,
        lore_binary_path: binary,
        lore_data_dir: dir.path().join("lore"),
        ..Default::default()
    }));
    lore.create_repo(channel, uid as i64, "fixture")
        .await
        .unwrap();
    state
        .wdb
        .lore_create_repo(channel, "fixture", "embedded://fixture", uid as i64)
        .await
        .unwrap();
    state.set_lore_service(lore.clone()).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    let (write, hash) = connect_token(&state, uid, channel, "read,write").await;
    let (read, _) = connect_token(&state, uid, channel, "read").await;
    let (wrong_repo, _) = connect_token(&state, uid, other, "read").await;
    let filename = format!("credential-{}.json", uuid::Uuid::new_v4());
    let base = format!("/addons/lore/repos/{channel}");
    let file = format!("{base}/files/{filename}");
    let content = json!({"editor":"test", "content":"hello"});
    let (status, uploaded) = request(&app, Method::PUT, &file, &write, content.clone()).await;
    assert_eq!(status, StatusCode::OK, "{uploaded}");
    assert_eq!(uploaded["wdbRecorded"], true);
    assert!(uploaded["cursor"].as_u64().unwrap() > 0);
    assert_eq!(
        std::fs::read(
            lore.repo_working_tree(channel)
                .await
                .unwrap()
                .join(&filename)
        )
        .unwrap(),
        content.to_string().as_bytes()
    );
    let (status, manifest) = request(
        &app,
        Method::GET,
        &format!("{base}/manifest"),
        &read,
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{manifest}");
    assert!(manifest.to_string().contains(&filename));
    let (status, downloaded) = request(&app, Method::GET, &file, &read, json!(null)).await;
    assert_eq!(status, StatusCode::OK, "{downloaded}");
    assert_eq!(downloaded, content);
    let changes = state.wdb.list_lore_file_changes(channel, 0).await.unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].path, filename);

    let staged_path = format!("{file}?stage_only=true");
    let (status, body) = request(&app, Method::PUT, &staged_path, &write, content).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["staged"], true);
    let (status, body) = request(
        &app,
        Method::POST,
        &format!("{base}/snapshot"),
        &write,
        json!({"message":"batch sync"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["wdbRecorded"], true);
    assert!(body["cursor"].as_u64().unwrap() > uploaded["cursor"].as_u64().unwrap());

    // Normal accounts can mint signed URLs; an explicitly supplied wrong
    // credential must not downgrade into the anonymous signed-download path.
    let (status, signed) = request(
        &app,
        Method::GET,
        &format!("{base}/signed-url?path={filename}"),
        &jwt(&state, uid),
        json!(null),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let signed_path = signed["url"]
        .as_str()
        .unwrap()
        .strip_prefix("/api")
        .unwrap();
    assert_eq!(
        request(&app, Method::GET, signed_path, "", json!(null))
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        request(&app, Method::GET, signed_path, &wrong_repo, json!(null))
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    state
        .wdb
        .lore_revoke_token(&hash, uid as i64)
        .await
        .unwrap();
    for path in [&file, signed_path] {
        assert_eq!(
            request(&app, Method::GET, path, &write, json!(null))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
    // Clean up only this UUID-named fixture's shared download-cache entry.
    let cache_name: String = format!("{channel}_{filename}")
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cache = std::env::temp_dir()
        .join("wabi-lore-cache")
        .join(cache_name);
    if cache.exists() {
        std::fs::remove_file(cache).unwrap();
    }
}

#[tokio::test]
async fn role_loss_limits_writes_and_missing_membership_prevents_minting_dead_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let state = server(dir.path()).await;
    let (owner, channel, _) = owner_and_repos(&state).await;
    let uid = state
        .wdb
        .create_user("artist", None, "registered-test-hash")
        .await
        .unwrap();
    state
        .wdb
        .add_channel_member(&format!("ch_{channel:x}"), uid, MemberRole::Member)
        .await
        .unwrap();
    state
        .wdb
        .ingest_event(
            "rbac",
            "assign_role",
            &json!({"workspaceId":"default-workspace", "userId":uid,"role":"Artist", "assignedBy":owner}),
        )
        .await
        .unwrap();
    let app = create_api_router(state.clone()).with_state(state.clone());
    let path = format!("/addons/lore/repos/{channel}/connect-tokens");
    let (status, body) = request(
        &app,
        Method::POST,
        &path,
        &jwt(&state, uid),
        json!({"scopes":"write"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let token = body["token"].as_str().unwrap();
    state
        .wdb
        .ingest_event(
            "rbac",
            "remove_role",
            &json!({"workspaceId":"default-workspace", "userId":uid}),
        )
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            Method::PUT,
            &format!("/addons/lore/repos/{channel}/files/test.txt"),
            token,
            json!(null)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            Method::GET,
            &format!("/addons/lore/repos/{channel}/changes"),
            token,
            json!(null)
        )
        .await
        .0,
        StatusCode::OK
    );
    state
        .wdb
        .remove_channel_member(&format!("ch_{channel:x}"), owner)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            Method::POST,
            &path,
            &jwt(&state, owner),
            json!({"scopes":"read"})
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}
