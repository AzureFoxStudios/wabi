//! Lore capabilities that a role can grant must actually be enforced:
//! `lore.lock` gates lock/unlock, `lore.approve` gates review approve/reject,
//! `lore.admin` gates repo delete / PATCH, and a direct promote requires
//! `lore.commit` whatever the request or the binding asks for.
//! Real API router + real WabiDB; the Lore CLI is a protocol fixture.
#![cfg(all(feature = "wabi-lore", unix))]

use std::{os::unix::fs::PermissionsExt, path::{Path, PathBuf}, sync::Arc};

use axum::{
    body::{to_bytes, Body},
    http::{Method, Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;
use wabi_server::{
    api::routes::create_api_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    lore_roles::LoreRoleDef,
    state::AppState,
};
use wabidb::{
    domain::{ChannelKind, MemberRole},
    engine::wabi_store::WabiStore,
    projections::messages::FileAttachmentRecord,
};

fn server_config(path: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "lore-capability-enforcement-test-only".into(),
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
    }
}

fn jwt(state: &AppState, uid: u64, username: &str) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: uid.to_string(),
            username: username.into(),
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

fn numeric(channel: &str) -> i64 {
    i64::from_str_radix(channel.strip_prefix("ch_").unwrap(), 16).unwrap()
}

struct Fixture {
    _dir: tempfile::TempDir,
    app: axum::Router,
    state: Arc<AppState>,
    repo: i64,
    message_id: String,
    commit_log: PathBuf,
    tokens: std::collections::HashMap<&'static str, String>,
}

/// Role slug -> capabilities. Each user is named after its role.
const ROLES: [(&str, &[&str]); 7] = [
    // lore.stage only: no lock, no commit, no approve, no admin.
    ("stager", &["lore.stage"]),
    // stage + lock, but nothing else.
    ("locker", &["lore.stage", "lore.lock"]),
    // stage + commit (the old "edit" gate), but no lock/approve/admin.
    ("committer", &["lore.stage", "lore.commit"]),
    // everything except lore.admin.
    ("almost-admin", &["lore.stage", "lore.commit", "lore.approve", "lore.lock", "lore.manage-binding"]),
    // the other half of the old "edit" gate, alone.
    ("binder", &["lore.manage-binding"]),
    // may land other people's work: commit + approve.
    ("approver", &["lore.stage", "lore.commit", "lore.approve"]),
    // lore.admin and nothing else.
    ("repo-admin", &["lore.admin"]),
];

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(server_config(dir.path())).await.unwrap());

    let owner = state.wdb.create_user("owner", None, "test-registered-hash").await.unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);

    let chat = state.wdb.create_channel("chat", ChannelKind::Text, owner, false).await.unwrap();
    let lore_channel =
        state.wdb.create_channel("repo", ChannelKind::Lore, owner, false).await.unwrap();
    state.wdb.add_channel_member(&chat, owner, MemberRole::Member).await.unwrap();
    state.wdb.add_channel_member(&lore_channel, owner, MemberRole::Member).await.unwrap();

    let mut users = Vec::new();
    for (slug, caps) in ROLES {
        state
            .lore_roles
            .upsert(LoreRoleDef {
                id: slug.into(),
                name: slug.into(),
                description: String::new(),
                capabilities: caps.iter().map(|c| c.to_string()).collect(),
            })
            .unwrap();
        let uid = state.wdb.create_user(slug, None, "test-registered-hash").await.unwrap();
        state
            .wdb
            .ingest_event(
                "rbac",
                "assign_role",
                &json!({
                    "userId": uid,
                    "workspaceId": "default-workspace",
                    "role": slug,
                    "assignedBy": owner,
                }),
            )
            .await
            .unwrap();
        for channel in [&chat, &lore_channel] {
            state.wdb.add_channel_member(channel, uid, MemberRole::Member).await.unwrap();
        }
        users.push((slug, uid));
    }
    // A member with no Lore role at all, and the server owner.
    let nobody = state.wdb.create_user("nobody", None, "test-registered-hash").await.unwrap();
    for channel in [&chat, &lore_channel] {
        state.wdb.add_channel_member(channel, nobody, MemberRole::Member).await.unwrap();
    }
    users.push(("nobody", nobody));
    users.push(("owner", owner));
    let tokens = users.iter().map(|(slug, uid)| (*slug, jwt(&state, *uid, slug))).collect();

    std::fs::create_dir_all(dir.path().join("uploads")).unwrap();
    std::fs::write(dir.path().join("uploads/art.png"), b"png-bytes").unwrap();
    let message_id = state
        .wdb
        .send_message(
            &chat,
            owner,
            "look",
            false,
            &[FileAttachmentRecord {
                file_url: "/uploads/art.png".into(),
                file_name: "art.png".into(),
                file_size: 9,
            }],
        )
        .await
        .unwrap();

    let commit_log = dir.path().join("commits.log");
    let binary = dir.path().join("lore-fixture");
    std::fs::write(
        &binary,
        format!(
            "#!/bin/sh\n\
             if [ \"$1\" = \"--offline\" ] && [ \"$2\" = \"--local\" ]; then shift 2; fi\n\
             echo \"$*\" >> '{log}'\n\
             case \"$1\" in\n\
               commit) printf 'Revision  : 1\\nSignature : abcdef0123456789abcdef0123456789\\nDate      : Mon, 07 Sep 2026 00:00:00 +0000\\n    fixture\\nCommit succeeded\\n' ;;\n\
               branch) [ \"$2\" = list ] && echo '* main' ; exit 0 ;;\n\
               *) exit 0 ;;\n\
             esac\n",
            log = commit_log.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let lore = Arc::new(wabi_lore::LoreService::new(wabi_lore::LoreConfig {
        enabled: true,
        lore_binary_path: binary,
        lore_data_dir: dir.path().join("lore"),
        ..Default::default()
    }));
    let repo = numeric(&lore_channel);
    lore.create_repo(repo, owner as i64, "repo").await.unwrap();
    state.set_lore_service(lore).await;
    state.wdb.lore_create_repo(repo, "repo", "embedded://repo", owner as i64).await.unwrap();
    let _ = std::fs::remove_file(&commit_log);

    let app = create_api_router(state.clone()).with_state(state.clone());
    Fixture { _dir: dir, app, state, repo, message_id, commit_log, tokens }
}

async fn call(
    f: &Fixture,
    who: &str,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {}", f.tokens[who]));
    let body = match body {
        Some(v) => {
            builder = builder.header("content-type", "application/json");
            Body::from(v.to_string())
        }
        None => Body::empty(),
    };
    let response = f.app.clone().oneshot(builder.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let body =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (status, body)
}

#[tokio::test]
async fn lock_and_unlock_require_lore_lock() {
    let f = fixture().await;
    let uri = format!("/addons/lore/repos/{}/lock/a.bin", f.repo);

    let (status, body) = call(&f, "stager", Method::POST, &uri, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "lore.stage alone must not lock: {body}");
    let (status, body) = call(&f, "stager", Method::DELETE, &uri, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "lore.stage alone must not unlock: {body}");

    // The capability itself is sufficient.
    let (status, body) = call(&f, "locker", Method::POST, &uri, None).await;
    assert_eq!(status, StatusCode::OK, "lore.lock must allow locking: {body}");
}

#[tokio::test]
async fn review_approve_and_reject_require_lore_approve() {
    let f = fixture().await;
    for action in ["approve", "reject"] {
        let uri = format!("/addons/lore/repos/{}/review/chat-u1/{action}", f.repo);
        let (status, body) = call(&f, "committer", Method::POST, &uri, None).await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "lore.commit without lore.approve must not {action}: {body}"
        );
    }
}

#[tokio::test]
async fn repo_delete_and_patch_require_lore_admin() {
    let f = fixture().await;
    let uri = format!("/addons/lore/repos/{}", f.repo);

    let (status, body) = call(&f, "almost-admin", Method::DELETE, &uri, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "repo delete without lore.admin: {body}");
    let (status, body) = call(
        &f,
        "almost-admin",
        Method::PATCH,
        &uri,
        Some(json!({ "auto_branch_on_upload": true })),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "repo PATCH without lore.admin: {body}");
    assert!(
        f.state.lore_service.read().await.as_ref().unwrap().get_repo(f.repo).await.is_some(),
        "refused delete must leave the repo in place"
    );
}

#[tokio::test]
async fn stage_only_user_cannot_force_a_direct_commit() {
    let f = fixture().await;
    // A binding whose mode is "stage" must not be overridable either.
    let (status, body) = call(
        &f,
        "stager",
        Method::POST,
        "/addons/lore/promote/from-message",
        Some(json!({
            "message_id": f.message_id,
            "file_url": "/uploads/art.png",
            "repo_channel_id": f.repo,
            "path": "assets",
            "mode": "direct",
        })),
    )
    .await;
    // Staged or refused are both acceptable; a mainline commit is not.
    if status == StatusCode::OK {
        assert_eq!(body["mode"], "stage", "must be downgraded to stage: {body}");
        assert_eq!(body["pending_review"], true, "{body}");
        assert!(
            body["branch"].as_str().unwrap_or_default().starts_with("chat/"),
            "must land on a review branch, not the mainline: {body}"
        );
    } else {
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}; cli log: {:?}", std::fs::read_to_string(&f.commit_log));
        assert!(!f.commit_log.exists() || !std::fs::read_to_string(&f.commit_log).unwrap().contains("commit"));
    }
}

/// Merging a branch lands it on the mainline, which is what approving a
/// review branch does. The merge route must not be a way around lore.approve.
#[tokio::test]
async fn merging_a_branch_requires_lore_approve() {
    let f = fixture().await;
    let uri = format!("/addons/lore/repos/{}/branches/chat-u1/merge", f.repo);
    for who in ["binder", "committer"] {
        let (status, body) = call(&f, who, Method::POST, &uri, None).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{who} merged without lore.approve: {body}");
    }
    assert!(
        !std::fs::read_to_string(&f.commit_log).unwrap_or_default().contains("merge"),
        "a refused merge reached the CLI"
    );
    let (status, body) = call(&f, "approver", Method::POST, &uri, None).await;
    assert_eq!(status, StatusCode::OK, "lore.commit + lore.approve must merge: {body}");
}

/// POST /repos on a channel that already has a repo renames it, takes it
/// over and can turn review on. That is repo administration, so it needs
/// lore.admin, the same as PATCH.
#[tokio::test]
async fn recreating_an_existing_repo_requires_lore_admin() {
    let f = fixture().await;
    let body = json!({ "channelId": f.repo, "repoName": "renamed", "autoBranchOnUpload": true });
    for who in ["committer", "binder", "almost-admin"] {
        let (status, reply) =
            call(&f, who, Method::POST, "/addons/lore/repos", Some(body.clone())).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{who} re-created an existing repo: {reply}");
    }
    let repo =
        f.state.lore_service.read().await.as_ref().unwrap().get_repo(f.repo).await.unwrap();
    assert_eq!(repo.repo_name, "repo", "a refused request renamed the repo");
    assert!(!repo.auto_branch_on_upload, "a refused request turned review on");

    let (status, reply) = call(&f, "owner", Method::POST, "/addons/lore/repos", Some(body)).await;
    assert_eq!(status, StatusCode::OK, "the owner may: {reply}");
}

/// The "open" default policy gives a member with no role the working
/// capabilities. It must not hand out lore.admin: before these gates existed,
/// other users' connect tokens were for server admins only.
#[tokio::test]
async fn open_policy_does_not_hand_out_lore_admin() {
    let f = fixture().await;
    f.state.lore_roles.set_default_policy("open").unwrap();
    let tokens_uri = format!("/addons/lore/repos/{}/connect-tokens", f.repo);

    let (status, minted) =
        call(&f, "stager", Method::POST, &tokens_uri, Some(json!({ "scopes": "read" }))).await;
    assert_eq!(status, StatusCode::OK, "{minted}");

    // Open policy still lets a roleless member work: locking needs lore.lock.
    let lock = format!("/addons/lore/repos/{}/lock/assets/a.txt", f.repo);
    let (status, body) = call(&f, "nobody", Method::POST, &lock, None).await;
    assert_eq!(status, StatusCode::OK, "open policy should grant lore.lock: {body}");

    let (status, listed) = call(&f, "nobody", Method::GET, &tokens_uri, None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert_eq!(listed["tokens"].as_array().unwrap().len(), 0, "saw another user's token: {listed}");

    let (status, listed) = call(&f, "repo-admin", Method::GET, &tokens_uri, None).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    let all = listed["tokens"].as_array().unwrap();
    assert_eq!(all.len(), 1, "lore.admin lists other users' tokens: {listed}");
    let hash = all[0]["tokenHash"].as_str().unwrap().to_string();

    let (status, body) =
        call(&f, "nobody", Method::DELETE, &format!("{tokens_uri}/{hash}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "revoked another user's token: {body}");

    let repo_uri = format!("/addons/lore/repos/{}", f.repo);
    let (status, body) = call(&f, "nobody", Method::DELETE, &repo_uri, None).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "open policy deleted the repo: {body}");

    let (status, body) =
        call(&f, "repo-admin", Method::DELETE, &format!("{tokens_uri}/{hash}"), None).await;
    assert_eq!(status, StatusCode::OK, "lore.admin revokes other users' tokens: {body}");
}

/// The gates deny without the capability; these show they allow with it.
#[tokio::test]
async fn holders_of_the_new_capabilities_are_allowed() {
    let f = fixture().await;
    let approve = format!("/addons/lore/repos/{}/review/chat-u1/approve", f.repo);
    let (status, body) = call(&f, "approver", Method::POST, &approve, None).await;
    assert_ne!(status, StatusCode::FORBIDDEN, "lore.approve must pass the approve gate: {body}");

    let repo_uri = format!("/addons/lore/repos/{}", f.repo);
    let patch = Some(json!({ "auto_branch_on_upload": true }));
    let (status, body) = call(&f, "repo-admin", Method::PATCH, &repo_uri, patch.clone()).await;
    assert_eq!(status, StatusCode::OK, "lore.admin must PATCH: {body}");
    let (status, body) = call(&f, "owner", Method::PATCH, &repo_uri, patch).await;
    assert_eq!(status, StatusCode::OK, "the owner must PATCH: {body}");
}

// ---- Task 4.8b: a caller without lore.commit must not change the mainline ----
// All of these run against the shell stand-in for the lore binary, so they
// assert on the CLI call log: which branch was current when `commit` ran.

async fn call_bytes(
    f: &Fixture,
    bearer: &str,
    method: Method,
    uri: &str,
    body: &'static [u8],
) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {bearer}"))
        .header("content-type", "application/octet-stream")
        .body(Body::from(body))
        .unwrap();
    let response = f.app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))))
}

/// The branch each `commit` in the CLI log ran on (the fixture starts on main).
fn commit_branches(f: &Fixture) -> Vec<String> {
    let log = std::fs::read_to_string(&f.commit_log).unwrap_or_default();
    let mut current = "main".to_string();
    let mut out = Vec::new();
    for line in log.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        match words.as_slice() {
            ["branch", "switch", name] => current = name.to_string(),
            ["commit", ..] => out.push(current.clone()),
            _ => {}
        }
    }
    out
}

fn upload_uri(f: &Fixture, name: &str) -> String {
    format!("/addons/lore/repos/{}/files/{name}", f.repo)
}

fn delete_body(f: &Fixture, who: &str) -> Request<Body> {
    Request::builder()
        .method(Method::DELETE)
        .uri(upload_uri(f, "gone.txt"))
        .header("authorization", format!("Bearer {}", f.tokens[who]))
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap()
}

#[tokio::test]
async fn stage_only_upload_lands_on_a_review_branch() {
    let f = fixture().await;
    let (status, body) =
        call_bytes(&f, &f.tokens["stager"], Method::PUT, &upload_uri(&f, "direct.txt"), b"x").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["pendingReview"], true, "{body}");
    let branches = commit_branches(&f);
    assert_eq!(branches.len(), 1, "one commit expected: {branches:?}");
    assert_ne!(branches[0], "main", "stage-only upload committed on the mainline: {branches:?}");
}

#[tokio::test]
async fn stage_only_delete_is_refused_and_never_reaches_the_cli() {
    let f = fixture().await;
    let response = f.app.clone().oneshot(delete_body(&f, "stager")).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(
        commit_branches(&f).is_empty(),
        "refused delete reached the CLI: {:?}",
        std::fs::read_to_string(&f.commit_log)
    );
}

/// A stage-only upload writes into the working tree of the current branch
/// without a commit. The next commit by anyone would carry it to the mainline.
#[tokio::test]
async fn staging_a_batch_requires_lore_commit() {
    let f = fixture().await;
    let uri = format!("{}?stageOnly=true", upload_uri(&f, "batch.txt"));

    let (status, body) = call_bytes(&f, &f.tokens["stager"], Method::PUT, &uri, b"x").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let log = std::fs::read_to_string(&f.commit_log).unwrap_or_default();
    assert!(!log.contains("stage batch.txt"), "refused staging reached the CLI: {log}");

    let (status, body) = call_bytes(&f, &f.tokens["committer"], Method::PUT, &uri, b"x").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["staged"], true, "{body}");
    let log = std::fs::read_to_string(&f.commit_log).unwrap_or_default();
    assert!(log.contains("stage batch.txt"), "{log}");
    assert!(commit_branches(&f).is_empty(), "staging must not commit: {log}");
}

#[tokio::test]
async fn commit_holder_upload_and_delete_still_commit_directly() {
    let f = fixture().await;
    let (status, body) =
        call_bytes(&f, &f.tokens["committer"], Method::PUT, &upload_uri(&f, "a.txt"), b"x").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["pendingReview"], false, "{body}");
    let response = f.app.clone().oneshot(delete_body(&f, "committer")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(commit_branches(&f), vec!["main", "main"]);
}

#[tokio::test]
async fn write_connect_token_of_a_stage_only_user_behaves_like_that_user() {
    let f = fixture().await;
    let tokens_uri = format!("/addons/lore/repos/{}/connect-tokens", f.repo);
    let (status, minted) =
        call(&f, "stager", Method::POST, &tokens_uri, Some(json!({ "scopes": "write" }))).await;
    assert_eq!(status, StatusCode::OK, "{minted}");
    let token = minted["token"].as_str().unwrap().to_string();

    let (status, body) =
        call_bytes(&f, &token, Method::PUT, &upload_uri(&f, "tool.txt"), b"x").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(
        commit_branches(&f).iter().all(|b| b != "main"),
        "token upload committed on the mainline: {:?}",
        std::fs::read_to_string(&f.commit_log)
    );
    let request = Request::builder()
        .method(Method::DELETE)
        .uri(upload_uri(&f, "tool.txt"))
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();
    let response = f.app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}
