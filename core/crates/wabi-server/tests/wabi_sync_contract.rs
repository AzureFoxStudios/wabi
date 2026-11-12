//! The real wabi-sync client against the real API router.
//!
//! Every other wabi-sync test runs against a hand-written server inside the
//! wabi-sync crate. That server once answered in a spelling the real handlers
//! never used, and the client's unit tests passed while every sync round
//! against a real server failed. These tests remove the second copy of the
//! wire format: the client's own engine (`SyncEngine`) and REST client
//! (`WabiClient`) talk HTTP to `create_api_router`, mounted under `/api` the
//! way `app_router` mounts it, on a 127.0.0.1 listener.
//!
//! Real: router, extractors, connect tokens (minted through the real route),
//! WabiDB, `LoreService` and its working tree. Stand-in: the `lore` program
//! is a shell script that accepts every command and prints a fresh revision
//! for `commit`. It keeps no branches and no history, so nothing here asserts
//! anything about review branches or about what a revision contains.
#![cfg(all(feature = "wabi-lore", unix))]

use std::{
    net::SocketAddr,
    os::unix::fs::PermissionsExt,
    path::Path,
    sync::{Arc, Mutex},
};

use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use serde_json::{json, Value};
use wabi_server::{
    api::routes::create_api_router,
    auth_extractor::JwtClaims,
    config::{LoreAddonConfig, ServerConfig, ServerRole},
    state::AppState,
};
use wabi_sync::{
    api::{DeleteOutcome, UploadOutcome, WabiClient},
    config::{LinkConfig, Linked, StateOwner, SyncState},
    etag::{etag_for_bytes, ETAG_FULL_HASH_MAX_BYTES},
    sync::{SyncEngine, SyncReport},
};
use wabidb::{
    domain::{ChannelKind, MemberRole},
    engine::wabi_store::WabiStore,
};

fn server_config(path: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "wabi-sync-contract-test-only".into(),
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

/// The one thing between the client and the real handlers: when a path is
/// set, the manifest answer has that file's `etag` replaced by `null`. The
/// real `list_files` sends `null` when it cannot hash a file (an I/O error),
/// which this fixture has no honest way to cause. Everything else in the
/// answer is what the handler wrote.
type NullEtag = Arc<Mutex<Option<String>>>;

async fn null_one_manifest_etag(State(target): State<NullEtag>, request: Request, next: Next) -> Response {
    let is_manifest = request.uri().path().ends_with("/manifest");
    let response = next.run(request).await;
    let path = target.lock().unwrap().clone();
    let (Some(path), true) = (path, is_manifest && response.status().is_success()) else {
        return response;
    };
    let (mut parts, body) = response.into_parts();
    let mut manifest: Value = serde_json::from_slice(&to_bytes(body, usize::MAX).await.unwrap()).unwrap();
    for file in manifest["files"].as_array_mut().unwrap() {
        if file["path"] == path.as_str() {
            assert!(file["etag"].is_string(), "the handler's own answer: {file}");
            file["etag"] = Value::Null;
        }
    }
    parts.headers.remove(axum::http::header::CONTENT_LENGTH);
    Response::from_parts(parts, Body::from(manifest.to_string()))
}

/// The other test-only layer: a fault armed for the next request with the
/// given method whose path ends with the given suffix. It is spent by that
/// request, which never reaches the handler.
#[derive(Clone, Copy, PartialEq)]
enum Fault {
    /// Answer 502: a failure that is not about one file (a gateway between
    /// the client and the server).
    BadGateway,
    /// Never answer: the client is left waiting, as when its process is
    /// about to be killed.
    Stall,
    /// Answer 500 in the shape of the server's own internal error, with
    /// nothing done on the server.
    InternalError,
}
type FailOnce = Arc<Mutex<Option<(Fault, String, String)>>>;

async fn fail_one_request(State(target): State<FailOnce>, request: Request, next: Next) -> Response {
    let fault = {
        let mut target = target.lock().unwrap();
        let hit = target.as_ref().is_some_and(|(_, method, suffix)| {
            request.method().as_str() == method && request.uri().path().ends_with(suffix.as_str())
        });
        if hit { target.take().map(|(fault, _, _)| fault) } else { None }
    };
    match fault {
        None => next.run(request).await,
        Some(Fault::Stall) => std::future::pending().await,
        Some(Fault::InternalError) => Response::builder()
            .status(500)
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"error":"Internal server error","type":"Internal"}"#))
            .unwrap(),
        Some(Fault::BadGateway) => Response::builder()
            .status(502)
            .header(axum::http::header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"error":"injected by the test","type":"BadGateway"}"#))
            .unwrap(),
    }
}

/// A record of what the client asked for: every request's method, path and
/// declared body length, in order. It changes nothing in either direction.
type Requests = Arc<Mutex<Vec<(String, String, u64)>>>;

async fn log_request(State(log): State<Requests>, request: Request, next: Next) -> Response {
    let length = request
        .headers()
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    log.lock().unwrap().push((request.method().to_string(), request.uri().path().to_string(), length));
    next.run(request).await
}

struct Server {
    _dir: tempfile::TempDir,
    state: Arc<AppState>,
    url: String,
    /// Numeric id of the Lore channel.
    repo: i64,
    /// Login JWTs, used only to mint connect tokens.
    owner_login: String,
    artist_login: String,
    /// A channel member with no Lore role: may read, may not write, and may
    /// not mint a connect token, so this JWT is the client's token.
    viewer_login: String,
    null_etag: NullEtag,
    fail_once: FailOnce,
    requests: Requests,
    owner_id: u64,
    viewer_id: u64,
    lore: Arc<wabi_lore::LoreService>,
}

/// A server with one Lore repo and three members: the owner and an Artist,
/// who may write to it, and a member with no role, who may only read.
async fn server() -> Server {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(server_config(dir.path())).await.unwrap());

    let owner = state.wdb.create_user("owner", None, "test-registered-hash").await.unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    let artist = state.wdb.create_user("artist", None, "test-registered-hash").await.unwrap();
    state
        .wdb
        .ingest_event(
            "rbac",
            "assign_role",
            &json!({
                "userId": artist,
                "workspaceId": "default-workspace",
                "role": "Artist",
                "assignedBy": owner,
            }),
        )
        .await
        .unwrap();
    let viewer = state.wdb.create_user("viewer", None, "test-registered-hash").await.unwrap();
    let channel = state.wdb.create_channel("repo", ChannelKind::Lore, owner, false).await.unwrap();
    for uid in [owner, artist, viewer] {
        state.wdb.add_channel_member(&channel, uid, MemberRole::Member).await.unwrap();
    }

    // The `lore` stand-in: every command succeeds, each commit prints a new
    // revision signature.
    let counter = dir.path().join("commit-counter");
    let binary = dir.path().join("lore-fixture");
    std::fs::write(
        &binary,
        format!(
            "#!/bin/sh\n\
             if [ \"$1\" = \"--offline\" ] && [ \"$2\" = \"--local\" ]; then shift 2; fi\n\
             if [ \"$1\" = stage ] && [ -e '{fail_stage}' ]; then echo 'stage failed (test)' >&2; exit 1; fi\n\
             case \"$1\" in\n\
               commit) n=$(( $(cat '{counter}' 2>/dev/null || echo 0) + 1 )); echo $n > '{counter}'\n\
                 printf 'Revision  : %s\\nSignature : %032d\\nBranch    : main\\nDate      : Mon, 07 Sep 2026 00:00:00 +0000\\n    fixture\\nCommit succeeded\\n' $n $n ;;\n\
               branch) [ \"$2\" = list ] && echo '* main' ; exit 0 ;;\n\
               *) exit 0 ;;\n\
             esac\n",
            counter = counter.display(),
            fail_stage = dir.path().join("fail-lore-stage").display(),
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
    let repo = i64::from_str_radix(channel.strip_prefix("ch_").unwrap(), 16).unwrap();
    lore.create_repo(repo, owner as i64, "repo").await.unwrap();
    state.set_lore_service(lore.clone()).await;
    state.wdb.lore_create_repo(repo, "repo", "embedded://repo", owner as i64).await.unwrap();

    let null_etag = NullEtag::default();
    let fail_once = FailOnce::default();
    let requests = Requests::default();
    let app = axum::Router::new()
        .nest("/api", create_api_router(state.clone()).with_state(state.clone()))
        .layer(axum::middleware::from_fn_with_state(null_etag.clone(), null_one_manifest_etag))
        .layer(axum::middleware::from_fn_with_state(fail_once.clone(), fail_one_request))
        .layer(axum::middleware::from_fn_with_state(requests.clone(), log_request));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    });

    Server {
        owner_login: jwt(&state, owner, "owner"),
        artist_login: jwt(&state, artist, "artist"),
        viewer_login: jwt(&state, viewer, "viewer"),
        state,
        _dir: dir,
        url,
        repo,
        null_etag,
        fail_once,
        requests,
        owner_id: owner,
        viewer_id: viewer,
        lore,
    }
}

impl Server {
    /// Mint a connect token through the real route, as the Connect panel does.
    async fn connect_token(&self, login: &str, scopes: &str) -> String {
        self.connect_token_for(self.repo, login, scopes).await
    }

    async fn connect_token_for(&self, repo: i64, login: &str, scopes: &str) -> String {
        let response = reqwest::Client::new()
            .post(format!("{}/api/addons/lore/repos/{}/connect-tokens", self.url, repo))
            .bearer_auth(login)
            .json(&json!({ "scopes": scopes }))
            .send()
            .await
            .unwrap();
        let status = response.status();
        let body: Value = response.json().await.unwrap();
        assert!(status.is_success(), "mint {scopes}: {status} {body}");
        // The server answers its canonical spelling of the scope.
        assert_eq!(body["scopes"], if scopes == "write" { "read,write" } else { scopes });
        body["token"].as_str().unwrap().to_string()
    }

    /// A folder linked to the repo the way `wabi-sync link ch_<hex> <folder>`
    /// links it, with a client holding `token`.
    fn folder(&self, token: &str) -> Folder {
        self.folder_for(self.repo, token)
    }

    fn folder_for(&self, repo: i64, token: &str) -> Folder {
        let dir = tempfile::tempdir().unwrap();
        let channel_id = LinkConfig::normalize_channel_id(&format!("ch_{:x}", repo)).unwrap();
        LinkConfig { server_url: self.url.clone(), channel_id }.save(dir.path()).unwrap();
        let link = LinkConfig::load(dir.path()).unwrap();
        assert_eq!(link.channel_id, repo);
        Folder { client: WabiClient::new(&link.server_url, token), link, dir }
    }

    /// A second, empty Lore repo on the same server, in a channel of its
    /// own, and the owner's write token for it.
    async fn second_repo(&self) -> (i64, String) {
        let owner = self.owner_id;
        let channel = self.state.wdb.create_channel("repo-b", ChannelKind::Lore, owner, false).await.unwrap();
        self.state.wdb.add_channel_member(&channel, owner, MemberRole::Member).await.unwrap();
        let repo = i64::from_str_radix(channel.strip_prefix("ch_").unwrap(), 16).unwrap();
        self.lore.create_repo(repo, owner as i64, "repo-b").await.unwrap();
        self.state.wdb.lore_create_repo(repo, "repo-b", "embedded://repo-b", owner as i64).await.unwrap();
        (repo, self.connect_token_for(repo, &self.owner_login, "write").await)
    }

    /// While set, the `lore` stand-in fails every `stage` command, which the
    /// real handlers answer with 500.
    fn lore_stage_fails(&self, fails: bool) {
        let flag = self._dir.path().join("fail-lore-stage");
        if fails {
            std::fs::write(flag, b"").unwrap();
        } else {
            std::fs::remove_file(flag).unwrap();
        }
    }

    /// Forget the requests seen so far.
    fn forget_requests(&self) {
        self.requests.lock().unwrap().clear();
    }

    /// The requests with `method` whose path contains `part`, since the last
    /// `forget_requests`: how many, and the sum of their declared bodies.
    fn requests(&self, method: &str, part: &str) -> (usize, u64) {
        let log = self.requests.lock().unwrap();
        let hits: Vec<u64> = log.iter().filter(|(m, p, _)| m == method && p.contains(part)).map(|(_, _, n)| *n).collect();
        (hits.len(), hits.iter().sum())
    }

    async fn owner_folder(&self) -> Folder {
        self.folder(&self.connect_token(&self.owner_login, "write").await)
    }

    async fn artist_folder(&self) -> Folder {
        self.folder(&self.connect_token(&self.artist_login, "write").await)
    }

    /// The next `method` request whose path ends with `suffix` is answered 502.
    fn fail_next(&self, method: &str, suffix: &str) {
        *self.fail_once.lock().unwrap() = Some((Fault::BadGateway, method.into(), suffix.into()));
    }

    /// The next `method` request whose path ends with `suffix` is answered
    /// 500 without reaching the handler.
    fn answer_500_next(&self, method: &str, suffix: &str) {
        *self.fail_once.lock().unwrap() = Some((Fault::InternalError, method.into(), suffix.into()));
    }

    /// The next `method` request whose path ends with `suffix` is never answered.
    fn stall_next(&self, method: &str, suffix: &str) {
        *self.fail_once.lock().unwrap() = Some((Fault::Stall, method.into(), suffix.into()));
    }

    /// Is the armed fault still waiting for its request?
    fn fault_is_armed(&self) -> bool {
        self.fail_once.lock().unwrap().is_some()
    }
}

struct Folder {
    dir: tempfile::TempDir,
    client: WabiClient,
    link: LinkConfig,
}

impl Folder {
    fn path(&self) -> &Path {
        self.dir.path()
    }

    /// What every command starts with: a new engine, so state goes through disk.
    fn engine(&self) -> anyhow::Result<SyncEngine<'_>> {
        SyncEngine::new(&self.client, self.path(), &self.link)
    }

    /// One `wabi-sync sync` round.
    async fn sync(&self) -> anyhow::Result<SyncReport> {
        self.engine()?.sync().await
    }

    /// One `wabi-sync push`.
    async fn push(&self) -> anyhow::Result<SyncReport> {
        self.engine()?.push().await
    }

    /// One `wabi-sync pull`.
    async fn pull(&self) -> anyhow::Result<SyncReport> {
        self.engine()?.pull().await
    }

    /// `wabi-sync link <repo> <this folder>` on a folder that is already
    /// linked: the link file is written again and nothing else is touched.
    fn relink(&mut self, server: &Server, repo: i64, token: &str) -> Linked {
        let link = LinkConfig { server_url: server.url.clone(), channel_id: repo };
        let linked = link.link(self.path(), &StateOwner::new(&server.url, repo), false).unwrap();
        self.link = LinkConfig::load(self.path()).unwrap();
        self.client = WabiClient::new(&self.link.server_url, token);
        linked
    }

    /// What an older build's `wabi-sync link` does: it writes the link file
    /// and nothing else (`LinkConfig::save`, before 4.8g).
    fn relink_with_an_older_build(&mut self, server: &Server, repo: i64, token: &str) {
        LinkConfig { server_url: server.url.clone(), channel_id: repo }.save(self.path()).unwrap();
        self.link = LinkConfig::load(self.path()).unwrap();
        self.client = WabiClient::new(&self.link.server_url, token);
    }

    /// A round run with `--allow-mass-delete`.
    async fn sync_allowing_mass_delete(&self) -> anyhow::Result<SyncReport> {
        let mut engine = self.engine()?;
        engine.allow_mass_delete = true;
        engine.sync().await
    }

    fn aside(&self, name: &str) -> Option<Vec<u8>> {
        std::fs::read(self.path().join(".wabi-sync").join(name)).ok()
    }

    fn state_file(&self) -> std::path::PathBuf {
        self.path().join(".wabi-sync/state.json")
    }

    /// The state file as an older build would have left it: no owner.
    fn forget_state_owner(&self) {
        let mut state: Value = serde_json::from_slice(&std::fs::read(self.state_file()).unwrap()).unwrap();
        state.as_object_mut().unwrap().remove("owner");
        std::fs::write(self.state_file(), state.to_string()).unwrap();
    }

    /// Every file under the folder that is not the client's own, with its
    /// contents.
    fn files(&self) -> Vec<(String, String)> {
        fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
            for entry in std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()) {
                let path = entry.path();
                let rel = path.strip_prefix(root).unwrap().to_string_lossy().to_string();
                if rel == ".wabi-sync" || rel == ".wabi-sync.json" {
                    continue;
                }
                if path.is_dir() {
                    walk(&path, root, out);
                } else {
                    out.push((rel, String::from_utf8_lossy(&std::fs::read(&path).unwrap()).to_string()));
                }
            }
        }
        let mut out = Vec::new();
        walk(self.path(), self.path(), &mut out);
        out.sort();
        out
    }

    fn write(&self, rel: &str, bytes: impl AsRef<[u8]>) {
        let full = self.path().join(rel);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, bytes).unwrap();
    }

    fn read(&self, rel: &str) -> Option<Vec<u8>> {
        std::fs::read(self.path().join(rel)).ok()
    }

    fn state(&self) -> SyncState {
        SyncState::load(self.path()).unwrap()
    }

    fn has_state_file(&self) -> bool {
        self.path().join(".wabi-sync/state.json").exists()
    }

    fn conflict_copies(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".wabi-conflict-"))
            .collect();
        names.sort();
        names
    }

    /// The contents of every conflict copy in the folder's root.
    fn conflict_copy_contents(&self) -> Vec<String> {
        self.conflict_copies()
            .iter()
            .map(|name| String::from_utf8(self.read(name).unwrap()).unwrap())
            .collect()
    }

    /// Every path the server's manifest lists.
    async fn listed(&self) -> Vec<String> {
        let manifest = self.client.manifest(self.link.channel_id).await.unwrap();
        manifest.files.into_iter().map(|f| f.path).collect()
    }

    /// What the server holds for `rel`, read through the download route.
    async fn on_server(&self, rel: &str) -> Vec<u8> {
        self.client.download(self.link.channel_id, rel, None).await.unwrap().unwrap()
    }

    /// The server's manifest etag for `rel` (None: not listed).
    async fn manifest_etag(&self, rel: &str) -> Option<String> {
        let manifest = self.client.manifest(self.link.channel_id).await.unwrap();
        manifest.files.into_iter().find(|f| f.path == rel).map(|f| f.etag.unwrap())
    }

    /// How many change-feed entries the server recorded for `rel` with
    /// `action` ("upload" or "delete").
    async fn recorded(&self, rel: &str, action: &str) -> usize {
        let feed = self.client.changes(self.link.channel_id, 0).await.unwrap();
        feed.changes.iter().filter(|c| c.path == rel && c.action == action).count()
    }
}

fn describe(report: &SyncReport) -> String {
    format!(
        "downloaded {:?}, uploaded {:?}, deleted_local {:?}, deleted_remote {:?}, conflicts {:?}, waiting_review {:?}, not_deleted {:?}, not_uploaded {:?}, skipped {:?}, notices {:?}",
        report.downloaded,
        report.uploaded,
        report.deleted_local,
        report.deleted_remote,
        report.conflicts,
        report.waiting_review,
        report.not_deleted,
        report.not_uploaded,
        report.skipped,
        report.notices
    )
}

#[track_caller]
fn assert_quiet(report: &SyncReport) {
    assert!(report.is_empty(), "the round was not quiet: {}", describe(report));
}

// -- The sync round ----------------------------------------------------------

/// A new local file: uploaded, the manifest and the change feed decode, the
/// state is saved, and the second round has nothing to do.
#[tokio::test]
async fn first_sync_uploads_a_new_file_once() {
    let server = server().await;
    let folder = server.owner_folder().await;
    folder.write("a.txt", "first");
    folder.write("docs/b.txt", "nested");

    let first = folder.sync().await.expect("the first round against the real server");
    assert_eq!(first.uploaded, vec!["a.txt", "docs/b.txt"], "{}", describe(&first));
    assert!(first.downloaded.is_empty() && first.conflicts.is_empty(), "{}", describe(&first));
    assert_eq!(folder.on_server("a.txt").await, b"first");
    assert_eq!(folder.on_server("docs/b.txt").await, b"nested");

    assert!(folder.has_state_file(), "the round did not save its state");
    let state = folder.state();
    assert_eq!(state.baselines.get("a.txt"), Some(&Some(etag_for_bytes(b"first"))));
    assert_eq!(state.baselines.get("docs/b.txt"), Some(&Some(etag_for_bytes(b"nested"))));
    assert!(state.pending_review.is_empty());

    let second = folder.sync().await.unwrap();
    assert_quiet(&second);
    assert_eq!(folder.recorded("a.txt", "upload").await, 1, "uploaded again");
    assert_eq!(folder.recorded("docs/b.txt", "upload").await, 1, "uploaded again");
}

/// Every manifest field the client reads, from the real handler.
#[tokio::test]
async fn manifest_fields_decode() {
    let server = server().await;
    let folder = server.owner_folder().await;

    let empty = folder.client.manifest(server.repo).await.expect("manifest of an empty repo");
    assert_eq!(empty.channel_id, server.repo);
    assert!(empty.files.is_empty());
    assert_eq!(empty.head_revision, "");
    assert!(!empty.read_only);

    folder.write("a.txt", "first");
    folder.sync().await.unwrap();
    let manifest = folder.client.manifest(server.repo).await.unwrap();
    assert_eq!(manifest.channel_id, server.repo);
    assert!(!manifest.read_only);
    // The stand-in's first commit has signature 000…01.
    assert_eq!(manifest.head_revision, format!("{:032}", 1), "headRevision was not read");
    assert_eq!(manifest.files.len(), 1);
    assert_eq!(manifest.files[0].path, "a.txt");
    assert_eq!(manifest.files[0].size, 5);
    assert_eq!(manifest.files[0].etag, Some(etag_for_bytes(b"first")));
}

/// A file another member changed on the server is downloaded.
#[tokio::test]
async fn change_by_another_member_is_downloaded() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;

    mine.write("a.txt", "v1");
    mine.sync().await.unwrap();
    let report = theirs.sync().await.unwrap();
    assert_eq!(report.downloaded, vec!["a.txt"], "{}", describe(&report));
    assert_eq!(theirs.read("a.txt").as_deref(), Some(&b"v1"[..]));

    theirs.write("a.txt", "v2 by the artist");
    let report = theirs.sync().await.unwrap();
    assert_eq!(report.uploaded, vec!["a.txt"], "{}", describe(&report));
    assert!(report.conflicts.is_empty(), "{}", describe(&report));

    let report = mine.sync().await.unwrap();
    assert_eq!(report.downloaded, vec!["a.txt"], "{}", describe(&report));
    assert!(report.conflicts.is_empty() && report.uploaded.is_empty(), "{}", describe(&report));
    assert_eq!(mine.read("a.txt").as_deref(), Some(&b"v2 by the artist"[..]));
    assert!(mine.conflict_copies().is_empty());
    assert_eq!(mine.state().baselines.get("a.txt"), Some(&Some(etag_for_bytes(b"v2 by the artist"))));

    assert_quiet(&mine.sync().await.unwrap());
    assert_quiet(&theirs.sync().await.unwrap());
    assert_eq!(mine.recorded("a.txt", "upload").await, 2);
}

/// A local edit over a stale baseline: the server answers 409 and the client
/// reads `currentEtag` from the real conflict body.
#[tokio::test]
async fn edit_over_a_stale_baseline_takes_the_409_path() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    mine.write("a.txt", "v1");
    mine.sync().await.unwrap();
    theirs.sync().await.unwrap();
    theirs.write("a.txt", "theirs");
    theirs.sync().await.unwrap();

    mine.write("a.txt", "mine");
    let report = mine.push().await.unwrap();
    assert_eq!(report.conflicts.len(), 1, "{}", describe(&report));
    assert!(report.uploaded.is_empty(), "{}", describe(&report));
    assert_eq!(mine.on_server("a.txt").await, b"theirs", "the stale upload must not land");
    assert_eq!(mine.recorded("a.txt", "upload").await, 2, "v1 and theirs only");

    // The conflict copy is named after the server's current etag, which only
    // the 409 body carries.
    let their_etag = etag_for_bytes(b"theirs");
    assert_eq!(mine.conflict_copies(), vec![format!("a.txt.wabi-conflict-{}", &their_etag[..8])]);
    assert_eq!(mine.read(&mine.conflict_copies()[0]).as_deref(), Some(&b"mine"[..]));
    assert_eq!(mine.read("a.txt").as_deref(), Some(&b"theirs"[..]));
    assert_eq!(mine.state().baselines.get("a.txt"), Some(&Some(their_etag)));
}

/// The raw answers behind the engine's decisions: an accepted upload, a
/// create-only upload of an existing file, and a stale delete.
#[tokio::test]
async fn upload_and_conflict_answers_decode() {
    let server = server().await;
    let folder = server.owner_folder().await;
    let repo = server.repo;

    let outcome = folder.client.upload(repo, "a.txt", b"one".to_vec(), "wabi-sync: update a.txt", Some("")).await.unwrap();
    let UploadOutcome::Ok { etag, revision, pending_review } = outcome else {
        panic!("create-only upload of a new file was refused: {outcome:?}");
    };
    assert_eq!(etag, etag_for_bytes(b"one"));
    assert_eq!(revision, format!("{:032}", 1));
    assert!(!pending_review);

    let outcome = folder.client.upload(repo, "a.txt", b"two".to_vec(), "m", Some("")).await.unwrap();
    let UploadOutcome::Conflict(conflict) = outcome else {
        panic!("create-only upload over an existing file was accepted: {outcome:?}");
    };
    assert_eq!(conflict.current_etag, Some(etag_for_bytes(b"one")));

    let outcome = folder.client.upload(repo, "a.txt", b"two".to_vec(), "m", Some("not-the-etag")).await.unwrap();
    assert!(matches!(outcome, UploadOutcome::Conflict(_)), "{outcome:?}");
    // A file that does not exist: the conflict body's currentEtag is null.
    let outcome = folder.client.upload(repo, "missing.txt", b"x".to_vec(), "m", Some("some-etag")).await.unwrap();
    let UploadOutcome::Conflict(conflict) = outcome else {
        panic!("If-Match on a missing file was accepted: {outcome:?}");
    };
    assert_eq!(conflict.current_etag, None);

    assert_eq!(folder.client.delete(repo, "a.txt", Some("not-the-etag")).await.unwrap(), DeleteOutcome::Conflict);
    assert_eq!(folder.on_server("a.txt").await, b"one");
    let etag = etag_for_bytes(b"one");
    assert_eq!(folder.client.delete(repo, "a.txt", Some(etag.as_str())).await.unwrap(), DeleteOutcome::Deleted);
    assert!(folder.client.download(repo, "a.txt", None).await.is_err(), "deleted file still downloads");
}

/// A local delete is pushed, and the other folder's copy goes with it.
#[tokio::test]
async fn local_delete_is_pushed() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    mine.write("a.txt", "v1");
    mine.write("keep.txt", "stays");
    mine.sync().await.unwrap();
    theirs.sync().await.unwrap();

    std::fs::remove_file(mine.path().join("a.txt")).unwrap();
    let report = mine.sync().await.unwrap();
    assert_eq!(report.deleted_remote, vec!["a.txt"], "{}", describe(&report));
    assert!(report.conflicts.is_empty() && report.not_deleted.is_empty(), "{}", describe(&report));
    assert_eq!(mine.manifest_etag("a.txt").await, None, "still listed on the server");
    assert!(mine.manifest_etag("keep.txt").await.is_some());
    assert_eq!(mine.recorded("a.txt", "delete").await, 1);
    assert!(!mine.state().baselines.contains_key("a.txt"));
    assert_quiet(&mine.sync().await.unwrap());
    assert_eq!(mine.recorded("a.txt", "delete").await, 1, "deleted twice");

    let report = theirs.sync().await.unwrap();
    assert_eq!(report.deleted_local, vec!["a.txt"], "{}", describe(&report));
    assert!(theirs.read("a.txt").is_none());
    assert_eq!(theirs.read("keep.txt").as_deref(), Some(&b"stays"[..]));
}

/// A read-scope token reads, and every write is refused with a message that
/// says why.
#[tokio::test]
async fn read_only_token_reads_and_is_told_why_it_cannot_write() {
    let server = server().await;
    let writer = server.owner_folder().await;
    writer.write("a.txt", "v1");
    writer.sync().await.unwrap();

    let reader = server.folder(&server.connect_token(&server.artist_login, "read").await);
    let repo = server.repo;
    let report = reader.pull().await.expect("a read token may pull");
    assert_eq!(report.downloaded, vec!["a.txt"], "{}", describe(&report));
    assert_eq!(reader.read("a.txt").as_deref(), Some(&b"v1"[..]));
    assert_quiet(&reader.sync().await.expect("a round with nothing to push"));
    assert!(reader.client.changes(repo, 0).await.is_ok());

    let refused = reader.client.upload(repo, "b.txt", b"x".to_vec(), "m", Some("")).await.unwrap();
    let UploadOutcome::Refused(refusal) = refused else {
        panic!("a read token uploaded: {refused:?}");
    };
    assert_eq!(refusal.status, 403);
    assert!(refusal.to_string().contains("read-only"), "the 403 was not explained: {refusal}");
    let refused = reader.client.set_lock(repo, "a.txt", true).await.unwrap_err().to_string();
    assert!(refused.contains("read-only"), "the 403 was not explained: {refused}");
    let etag = etag_for_bytes(b"v1");
    assert_eq!(reader.client.delete(repo, "a.txt", Some(etag.as_str())).await.unwrap(), DeleteOutcome::Forbidden);
    assert_eq!(writer.on_server("a.txt").await, b"v1");
    assert_eq!(writer.manifest_etag("b.txt").await, None);
}

/// A revoked or unknown token is a 401, reported as an authentication error.
#[tokio::test]
async fn unknown_token_is_an_authentication_error() {
    let server = server().await;
    let folder = server.folder(&format!("wblore_{}", "0".repeat(64)));
    let error = folder.sync().await.err().expect("an unknown token must not sync").to_string();
    assert!(error.contains("401"), "{error}");
}

/// The change feed: `latestSeq` is the cursor the client stores.
#[tokio::test]
async fn change_feed_cursor_is_read_and_stored() {
    let server = server().await;
    let folder = server.owner_folder().await;
    let repo = server.repo;

    let empty = folder.client.changes(repo, 0).await.expect("change feed of an empty repo");
    assert_eq!(empty.latest_seq, 0);
    assert!(empty.changes.is_empty());
    folder.sync().await.unwrap();
    assert_eq!(folder.state().cursor, 0);

    folder.write("a.txt", "v1");
    folder.sync().await.unwrap();
    let feed = folder.client.changes(repo, 0).await.unwrap();
    assert_eq!(feed.changes.len(), 1);
    assert_eq!(feed.changes[0].path, "a.txt");
    assert_eq!(feed.changes[0].action, "upload");
    assert_eq!(feed.changes[0].etag, Some(etag_for_bytes(b"v1")));
    assert!(feed.changes[0].seq > 0);
    assert_eq!(feed.latest_seq, feed.changes[0].seq, "latestSeq is the last entry's seq");
    assert_eq!(folder.state().cursor, feed.latest_seq, "the round stores latestSeq");

    // Nothing after the cursor: the server echoes it back.
    let after = folder.client.changes(repo, feed.latest_seq).await.unwrap();
    assert!(after.changes.is_empty());
    assert_eq!(after.latest_seq, feed.latest_seq);

    // One round uploads first and deletes after.
    std::fs::remove_file(folder.path().join("a.txt")).unwrap();
    folder.write("b.txt", "v1");
    folder.sync().await.unwrap();
    let after = folder.client.changes(repo, feed.latest_seq).await.unwrap();
    let seen: Vec<(&str, &str)> = after.changes.iter().map(|c| (c.path.as_str(), c.action.as_str())).collect();
    assert_eq!(seen, vec![("b.txt", "upload"), ("a.txt", "delete")]);
    assert_eq!(after.changes[1].etag, None, "a delete entry has a null etag");
    assert!(after.latest_seq > feed.latest_seq);
    assert_eq!(folder.state().cursor, after.latest_seq);
}

/// A manifest entry whose etag is `null` (see `null_one_manifest_etag`): the
/// manifest still decodes and the round neither fails nor disturbs the file.
#[tokio::test]
async fn manifest_entry_with_a_null_etag_decodes() {
    let server = server().await;
    let mine = server.owner_folder().await;
    mine.write("a.txt", "v1");
    mine.sync().await.unwrap();
    *server.null_etag.lock().unwrap() = Some("a.txt".into());

    let manifest = mine.client.manifest(server.repo).await.expect("a null etag must decode");
    assert_eq!(manifest.files.len(), 1);
    assert_eq!(manifest.files[0].etag, None);

    // A folder that already has the file.
    let report = mine.sync().await.expect("a round with a null etag in the manifest");
    // A null etag says nothing about the file, so the round leaves it alone:
    // it is not fetched again and written over the local copy.
    assert_quiet(&report);
    assert_eq!(mine.read("a.txt").as_deref(), Some(&b"v1"[..]));
    assert!(mine.conflict_copies().is_empty());
    assert_eq!(mine.state().baselines.get("a.txt"), Some(&Some(etag_for_bytes(b"v1"))));
    // A folder that does not: it waits for an etag too.
    let theirs = server.artist_folder().await;
    assert_quiet(&theirs.sync().await.expect("a first round with a null etag in the manifest"));
    assert_eq!(theirs.read("a.txt"), None);

    // Once the server can say the etag again, both folders settle.
    *server.null_etag.lock().unwrap() = None;
    assert_quiet(&mine.sync().await.unwrap());
    let report = theirs.sync().await.unwrap();
    assert_eq!(report.downloaded, vec!["a.txt"], "{}", describe(&report));
    assert_eq!(theirs.read("a.txt").as_deref(), Some(&b"v1"[..]));
    assert_quiet(&theirs.sync().await.unwrap());
    assert_eq!(mine.recorded("a.txt", "upload").await, 1);
}

// -- Two people, one file ----------------------------------------------------

/// Both folders hold `a.txt` = "v1"; the artist then uploads "theirs".
async fn two_folders_and_a_change_by_the_artist(server: &Server) -> (Folder, Folder) {
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    mine.write("a.txt", "v1");
    mine.sync().await.unwrap();
    theirs.sync().await.unwrap();
    theirs.write("a.txt", "theirs");
    theirs.sync().await.unwrap();
    (mine, theirs)
}

/// After a 409 the other member's change stays on the server until the user
/// acts: the canonical file holds the server's version, the user's version is
/// in the conflict copy, and the next round uploads nothing.
#[tokio::test]
async fn after_a_409_the_other_members_change_is_not_replaced() {
    let server = server().await;
    let (mine, theirs) = two_folders_and_a_change_by_the_artist(&server).await;

    mine.write("a.txt", "mine");
    let report = mine.sync().await.unwrap();
    assert_eq!(report.conflicts.len(), 1, "{}", describe(&report));
    assert!(report.uploaded.is_empty(), "{}", describe(&report));
    assert_eq!(mine.read("a.txt").as_deref(), Some(&b"theirs"[..]), "a.txt must hold the server's version");
    assert_eq!(mine.conflict_copy_contents(), vec!["mine"], "the user's version must be in the conflict copy");

    // The next rounds change nothing anywhere.
    let report = mine.sync().await.unwrap();
    assert!(report.uploaded.is_empty() && report.conflicts.is_empty(), "{}", describe(&report));
    assert_eq!(mine.on_server("a.txt").await, b"theirs", "the artist's change was replaced without a merge");
    let report = theirs.sync().await.unwrap();
    assert!(report.downloaded.is_empty(), "{}", describe(&report));
    assert_eq!(theirs.read("a.txt").as_deref(), Some(&b"theirs"[..]));
    assert_eq!(mine.recorded("a.txt", "upload").await, 2, "v1 and theirs only");

    // Keeping their own version is the user's act: put the conflict copy's
    // bytes back in a.txt. It then goes up as an ordinary edit.
    let copy = mine.conflict_copies().remove(0);
    std::fs::copy(mine.path().join(&copy), mine.path().join("a.txt")).unwrap();
    let report = mine.sync().await.unwrap();
    assert_eq!(report.uploaded, vec!["a.txt"], "{}", describe(&report));
    assert!(report.conflicts.is_empty(), "{}", describe(&report));
    assert_eq!(mine.on_server("a.txt").await, b"mine");
    let report = theirs.sync().await.unwrap();
    assert_eq!(report.downloaded, vec!["a.txt"], "{}", describe(&report));
    assert!(report.conflicts.is_empty(), "{}", describe(&report));
    assert_eq!(theirs.read("a.txt").as_deref(), Some(&b"mine"[..]));
}

/// The 409 for a file the other member deleted (`currentEtag` is null): the
/// file is not put back on the server; the user's version is the conflict copy.
#[tokio::test]
async fn after_a_409_a_file_deleted_by_the_other_member_is_not_put_back() {
    let server = server().await;
    let mine = server.owner_folder().await;
    // Deleting a file needs lore.commit (Task 4.8b), which the Artist role
    // does not have, so the other member here is a second owner folder.
    let theirs = server.owner_folder().await;
    mine.write("a.txt", "v1");
    mine.sync().await.unwrap();
    theirs.sync().await.unwrap();
    std::fs::remove_file(theirs.path().join("a.txt")).unwrap();
    theirs.sync().await.unwrap();
    assert_eq!(mine.manifest_etag("a.txt").await, None);

    mine.write("a.txt", "mine");
    let report = mine.sync().await.unwrap();
    assert_eq!(report.conflicts.len(), 1, "{}", describe(&report));
    assert!(report.uploaded.is_empty(), "{}", describe(&report));
    assert_eq!(mine.read("a.txt"), None, "a.txt must be what the server has: nothing");
    assert_eq!(mine.conflict_copy_contents(), vec!["mine"]);

    let report = mine.sync().await.unwrap();
    assert!(report.uploaded.is_empty(), "{}", describe(&report));
    assert_eq!(mine.manifest_etag("a.txt").await, None, "the deleted file was put back");
    assert_eq!(mine.recorded("a.txt", "upload").await, 1, "v1 only");
}

// -- What is never uploaded --------------------------------------------------

/// A conflict copy stays in the folder it was made in.
#[tokio::test]
async fn conflict_copies_are_not_synced() {
    let server = server().await;
    let (mine, theirs) = two_folders_and_a_change_by_the_artist(&server).await;
    mine.write("a.txt", "mine");
    mine.sync().await.unwrap();
    assert_eq!(mine.conflict_copies().len(), 1);
    let report = mine.sync().await.unwrap();
    assert!(report.uploaded.is_empty(), "a conflict copy was uploaded: {}", describe(&report));
    assert_eq!(mine.listed().await, vec!["a.txt"], "a conflict copy is on the server");
    theirs.sync().await.unwrap();
    assert!(theirs.conflict_copies().is_empty(), "the other member received {:?}", theirs.conflict_copies());
}

/// A conflict copy an earlier build already uploaded: no pull writes over a
/// local file of that name or downloads it, and no push deletes it.
#[tokio::test]
async fn conflict_copies_already_on_the_server_are_left_alone() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    let repo = server.repo;
    let stray = "a.txt.wabi-conflict-deadbeef";
    let listed = "b.txt.wabi-conflict-deadbeef";
    for path in [stray, listed] {
        theirs.client.upload(repo, path, b"from the server".to_vec(), "m", None).await.unwrap();
    }

    // The same name, other bytes, in my folder.
    mine.write(stray, "my own bytes");
    // A copy my folder synced with an earlier build: baseline recorded, then
    // removed from the folder by hand.
    let mut state = mine.state();
    state.baselines.insert(listed.into(), Some(etag_for_bytes(b"from the server")));
    state.save(mine.path()).unwrap();

    let report = mine.sync().await.unwrap();
    assert_quiet(&report);
    assert_eq!(mine.read(stray).as_deref(), Some(&b"my own bytes"[..]));
    assert_eq!(mine.on_server(stray).await, b"from the server", "a conflict copy was uploaded over the server's file");
    assert_eq!(mine.read(listed), None, "a conflict copy was downloaded");
    assert!(mine.manifest_etag(listed).await.is_some(), "a conflict copy was deleted on the server");
}

/// Names the server refuses: reserved metadata is never sent, and a file
/// the server turns down does not stop the rest of the round.
#[tokio::test]
async fn names_the_server_refuses_do_not_abort_the_round() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    theirs.write("other.txt", "from the artist");
    theirs.sync().await.unwrap();

    mine.write("ok.txt", "fine");
    mine.write("sub/.git/config", "reserved at any depth");
    mine.write("sub/.wabiignore", "*");
    mine.write("AUX.txt", "not a portable name");
    mine.write("node_modules/pkg/x.js", "ignored by the repo's .wabiignore");

    let report = mine.sync().await.expect("a refused file must not abort the round");
    assert_eq!(report.uploaded, vec!["ok.txt"], "{}", describe(&report));
    assert_eq!(report.downloaded, vec!["other.txt"], "{}", describe(&report));
    assert_eq!(mine.listed().await, vec!["ok.txt", "other.txt"]);
    // The reserved names were not offered at all; the other two were, and
    // each is reported with what the server answered.
    assert_eq!(report.not_uploaded.len(), 2, "{}", describe(&report));
    assert!(report.not_uploaded[0].starts_with("AUX.txt (not uploaded: "), "{}", describe(&report));
    assert!(report.not_uploaded[0].contains("400: Invalid repository file path"), "{}", describe(&report));
    assert!(report.not_uploaded[1].starts_with("node_modules/pkg/x.js (not uploaded: "), "{}", describe(&report));
    // 422 with the server's reason, not a 500 with none.
    assert!(
        report.not_uploaded[1]
            .ends_with("(not uploaded: path is ignored by .wabiignore (422))"),
        "{}",
        describe(&report)
    );
    // Unchanged, they are not sent again; the next round says they are
    // still refused (a_refused_file_is_not_sent_again_until_it_changes).
    let again = mine.sync().await.unwrap();
    assert_eq!(again.not_uploaded.len(), 2, "{}", describe(&again));
    assert!(again.not_uploaded[0].starts_with("AUX.txt (still not uploaded: "), "{}", describe(&again));
    assert!(again.uploaded.is_empty() && again.downloaded.is_empty(), "{}", describe(&again));
    for kept in ["sub/.git/config", "sub/.wabiignore", "AUX.txt", "node_modules/pkg/x.js"] {
        assert!(mine.read(kept).is_some(), "{kept} was removed from the folder");
    }
}

// -- A round that fails part-way ---------------------------------------------

/// A pull makes a conflict copy and then fails on a later file. The retry
/// must not write the server's version over the copy that holds the user's.
#[tokio::test]
async fn a_retry_does_not_write_over_the_conflict_copy() {
    let server = server().await;
    let (mine, theirs) = two_folders_and_a_change_by_the_artist(&server).await;
    theirs.write("z.txt", "new");
    theirs.sync().await.unwrap();

    mine.write("a.txt", "mine");
    server.fail_next("GET", "/files/z.txt");
    let error = mine.pull().await.err().expect("the injected failure").to_string();
    assert!(error.contains("502"), "{error}");
    assert_eq!(mine.conflict_copy_contents(), vec!["mine"]);

    let report = mine.pull().await.unwrap();
    assert!(report.downloaded.contains(&"z.txt".to_string()), "{}", describe(&report));
    assert_eq!(mine.read("a.txt").as_deref(), Some(&b"theirs"[..]));
    assert_eq!(mine.read("z.txt").as_deref(), Some(&b"new"[..]));
    assert_eq!(mine.conflict_copy_contents(), vec!["mine"], "the retry replaced the user's bytes");
}

/// A file already sits at the name a new conflict copy would get. It is the
/// user's; the new copy takes another name.
#[tokio::test]
async fn an_existing_conflict_copy_is_never_written_over() {
    let server = server().await;
    let taken = format!("a.txt.wabi-conflict-{}", &etag_for_bytes(b"theirs")[..8]);

    // The 409 on push.
    let (mine, _theirs) = two_folders_and_a_change_by_the_artist(&server).await;
    mine.write(&taken, "precious");
    mine.write("a.txt", "mine");
    mine.sync().await.unwrap();
    assert_eq!(mine.read(&taken).as_deref(), Some(&b"precious"[..]), "an existing conflict copy was replaced");
    assert_eq!(mine.conflict_copy_contents(), vec!["precious", "mine"]);

    // The conflict found by a pull.
    let server = self::server().await;
    let (mine, _theirs) = two_folders_and_a_change_by_the_artist(&server).await;
    mine.write(&taken, "precious");
    mine.write("a.txt", "mine");
    mine.pull().await.unwrap();
    assert_eq!(mine.read(&taken).as_deref(), Some(&b"precious"[..]), "an existing conflict copy was replaced");
    assert_eq!(mine.conflict_copy_contents(), vec!["precious", "mine"]);
}

/// The push succeeded and the pull failed: what the push did is on disk, so
/// the retry does not upload the file again.
#[tokio::test]
async fn state_is_saved_after_the_push_when_the_pull_fails() {
    let server = server().await;
    let mine = server.owner_folder().await;
    // Not a first round: a folder with no baseline at all pulls before it
    // pushes, and the failure would come before the upload.
    mine.write("first.txt", "synced");
    mine.sync().await.unwrap();
    mine.write("n.txt", "new");
    server.fail_next("GET", "/manifest");
    let error = mine.sync().await.err().expect("the injected failure").to_string();
    assert!(error.contains("502"), "{error}");
    assert_eq!(mine.on_server("n.txt").await, b"new");
    assert_eq!(
        mine.state().baselines.get("n.txt"),
        Some(&Some(etag_for_bytes(b"new"))),
        "the upload happened and was not recorded"
    );

    assert_quiet(&mine.sync().await.unwrap());
    assert_eq!(mine.recorded("n.txt", "upload").await, 1, "the retry uploaded it again");
}

/// A folder that holds the server's bytes with no record of it (a round was
/// killed before it saved, or the folder was filled by hand before linking):
/// the pull adopts the file and makes no conflict copy of identical bytes.
#[tokio::test]
async fn pull_adopts_a_file_that_already_matches_the_server() {
    let server = server().await;
    let (mine, _theirs) = two_folders_and_a_change_by_the_artist(&server).await;
    // My baseline says "v1"; the file was replaced by the server's version
    // and the state was not saved.
    mine.write("a.txt", "theirs");
    assert_quiet(&mine.pull().await.unwrap());
    assert!(mine.conflict_copies().is_empty(), "{:?}", mine.conflict_copies());
    assert_eq!(mine.state().baselines.get("a.txt"), Some(&Some(etag_for_bytes(b"theirs"))));

    let fresh = server.owner_folder().await;
    fresh.write("a.txt", "theirs");
    assert_quiet(&fresh.pull().await.unwrap());
    assert!(fresh.conflict_copies().is_empty(), "{:?}", fresh.conflict_copies());
    assert_quiet(&fresh.sync().await.unwrap());
    assert_eq!(fresh.recorded("a.txt", "upload").await, 2, "v1 and theirs only");
}

/// The conflict is settled and saved, and then the round fails. The user's
/// file now holds someone else's version: they must still be told.
#[tokio::test]
async fn a_conflict_is_reported_even_when_the_round_then_fails() {
    let server = server().await;
    let (mine, theirs) = two_folders_and_a_change_by_the_artist(&server).await;
    theirs.write("z.txt", "new");
    theirs.sync().await.unwrap();

    mine.write("a.txt", "mine");
    server.fail_next("GET", "/files/z.txt");
    assert!(mine.pull().await.is_err(), "the injected failure");
    assert_eq!(mine.read("a.txt").as_deref(), Some(&b"theirs"[..]));
    // The line is on disk with the conflict it describes.
    assert_eq!(mine.state().unreported_conflicts.len(), 1);

    let report = mine.pull().await.unwrap();
    assert_eq!(report.conflicts.len(), 1, "the conflict was never reported: {}", describe(&report));
    assert!(report.conflicts[0].starts_with("a.txt ("), "{}", describe(&report));
    // Once.
    assert!(mine.state().unreported_conflicts.is_empty());
    assert_quiet(&mine.pull().await.unwrap());

    // What the command line does with a failed round: it takes the lines to
    // print them with the error, and they are not printed a second time.
    theirs.write("a.txt", "theirs again");
    theirs.write("z.txt", "newer");
    theirs.sync().await.unwrap();
    mine.write("a.txt", "mine again");
    server.fail_next("GET", "/files/z.txt");
    let mut engine = SyncEngine::new(&mine.client, mine.path(), &mine.link).unwrap();
    assert!(engine.sync().await.is_err(), "the injected failure");
    let shown = engine.take_unreported_conflicts();
    assert_eq!(shown.len(), 1, "{shown:?}");
    assert!(shown[0].starts_with("a.txt ("), "{shown:?}");
    // The command ends, and with it the engine and its hold on the folder.
    drop(engine);
    let report = mine.sync().await.unwrap();
    assert!(report.conflicts.is_empty(), "reported twice: {}", describe(&report));
    assert_eq!(report.downloaded, vec!["z.txt"], "{}", describe(&report));
}

/// The same edit made in two folders. The 409 names the etag of the very
/// bytes that were sent, so the push adopts it: no conflict, and no download
/// (the armed fault would fail one).
#[tokio::test]
async fn the_same_edit_made_twice_is_adopted_without_a_download() {
    let server = server().await;
    let (mine, _theirs) = two_folders_and_a_change_by_the_artist(&server).await;
    mine.write("a.txt", "theirs");
    server.fail_next("GET", "/files/a.txt");
    assert_quiet(&mine.push().await.expect("no download is needed"));
    assert!(server.fault_is_armed(), "the file was downloaded");
    assert!(mine.conflict_copies().is_empty());
    assert_eq!(mine.state().baselines.get("a.txt"), Some(&Some(etag_for_bytes(b"theirs"))));
    assert_eq!(mine.recorded("a.txt", "upload").await, 2, "v1 and theirs only");
}

/// A round was killed after it wrote the conflict copy and before it
/// replaced the file. The next round finds the same conflict and the copy
/// already there with the same bytes: it is used, not duplicated.
#[tokio::test]
async fn an_identical_conflict_copy_is_used_again() {
    let server = server().await;
    let (mine, _theirs) = two_folders_and_a_change_by_the_artist(&server).await;
    let copy = format!("a.txt.wabi-conflict-{}", &etag_for_bytes(b"theirs")[..8]);
    mine.write("a.txt", "mine");
    mine.write(&copy, "mine");
    let report = mine.sync().await.unwrap();
    assert_eq!(report.conflicts.len(), 1, "{}", describe(&report));
    assert!(report.conflicts[0].ends_with(&format!("yours is saved as {copy})")), "{}", describe(&report));
    assert_eq!(mine.conflict_copies(), vec![copy]);
    assert_eq!(mine.read("a.txt").as_deref(), Some(&b"theirs"[..]));
}

/// The process dies right after a conflict was settled (here: the round is
/// dropped while its next request hangs). The conflict and its report line
/// are already on disk, and the next round reports it without finding it
/// a second time.
#[tokio::test]
async fn a_settled_conflict_is_on_disk_before_the_round_goes_on() {
    let server = server().await;
    let (mine, theirs) = two_folders_and_a_change_by_the_artist(&server).await;
    theirs.write("z.txt", "new");
    theirs.sync().await.unwrap();
    mine.write("a.txt", "mine");

    server.stall_next("GET", "/files/z.txt");
    let killed = tokio::time::timeout(std::time::Duration::from_secs(2), mine.pull()).await;
    assert!(killed.is_err(), "the round was meant to hang on z.txt");
    assert_eq!(mine.read("a.txt").as_deref(), Some(&b"theirs"[..]));
    let state = mine.state();
    assert_eq!(state.baselines.get("a.txt"), Some(&Some(etag_for_bytes(b"theirs"))), "the conflict was not saved");
    assert_eq!(state.unreported_conflicts.len(), 1, "the report line was not saved");

    let report = mine.pull().await.unwrap();
    assert_eq!(report.conflicts.len(), 1, "{}", describe(&report));
    assert_eq!(mine.conflict_copy_contents(), vec!["mine"]);
}

/// A pull downloads one file and fails on the next: the download is recorded.
#[tokio::test]
async fn state_is_saved_when_a_pull_fails_part_way() {
    let server = server().await;
    let (mine, theirs) = two_folders_and_a_change_by_the_artist(&server).await;
    theirs.write("z.txt", "new");
    theirs.sync().await.unwrap();

    server.fail_next("GET", "/files/z.txt");
    assert!(mine.pull().await.is_err(), "the injected failure");
    assert_eq!(mine.read("a.txt").as_deref(), Some(&b"theirs"[..]));
    assert_eq!(
        mine.state().baselines.get("a.txt"),
        Some(&Some(etag_for_bytes(b"theirs"))),
        "the download happened and was not recorded"
    );
    let report = mine.pull().await.unwrap();
    assert_eq!(report.downloaded, vec!["z.txt"], "{}", describe(&report));
}

/// A push uploads one file and fails on the next: the upload is recorded,
/// and the retry sends only the other file.
#[tokio::test]
async fn state_is_saved_when_a_push_fails_part_way() {
    let server = server().await;
    let mine = server.owner_folder().await;
    mine.write("a.txt", "first");
    mine.write("b.txt", "second");
    server.fail_next("PUT", "/files/b.txt");
    let error = mine.push().await.err().expect("the injected failure").to_string();
    assert!(error.contains("502"), "{error}");
    assert_eq!(mine.on_server("a.txt").await, b"first");
    assert_eq!(
        mine.state().baselines.get("a.txt"),
        Some(&Some(etag_for_bytes(b"first"))),
        "the upload happened and was not recorded"
    );
    assert_eq!(mine.state().baselines.get("b.txt"), None);

    let report = mine.push().await.unwrap();
    assert_eq!(report.uploaded, vec!["b.txt"], "{}", describe(&report));
    assert_eq!(mine.recorded("a.txt", "upload").await, 1);
}

/// sync is killed during the pull (its manifest request hangs): what the
/// push did was saved before the pull started.
#[tokio::test]
async fn sync_saves_what_the_push_did_before_the_pull_starts() {
    let server = server().await;
    let mine = server.owner_folder().await;
    // Not a first round, which pulls before it pushes.
    mine.write("first.txt", "synced");
    mine.sync().await.unwrap();
    mine.write("n.txt", "new");
    server.stall_next("GET", "/manifest");
    let killed = tokio::time::timeout(std::time::Duration::from_secs(2), mine.sync()).await;
    assert!(killed.is_err(), "the round was meant to hang on the manifest");
    assert_eq!(mine.state().baselines.get("n.txt"), Some(&Some(etag_for_bytes(b"new"))));
}

// -- A file with no baseline -------------------------------------------------

/// Two people create the same new path. The second upload must not replace
/// the first.
#[tokio::test]
async fn two_new_files_with_one_name_are_both_kept() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    theirs.write("n.txt", "theirs");
    theirs.sync().await.unwrap();

    mine.write("n.txt", "mine");
    let report = mine.sync().await.unwrap();
    assert!(report.uploaded.is_empty(), "{}", describe(&report));
    assert_eq!(report.conflicts.len(), 1, "{}", describe(&report));
    assert_eq!(mine.on_server("n.txt").await, b"theirs", "the first version was replaced");
    assert_eq!(mine.read("n.txt").as_deref(), Some(&b"theirs"[..]));
    assert_eq!(mine.conflict_copy_contents(), vec!["mine"]);
    assert_quiet(&theirs.sync().await.unwrap());
    assert_quiet(&mine.sync().await.unwrap());
    assert_eq!(mine.recorded("n.txt", "upload").await, 1);
}

/// A folder filled with an old copy of the repo, then linked and synced: the
/// old copy must not replace the server's current file for everyone.
#[tokio::test]
async fn a_stale_prefilled_folder_does_not_replace_the_servers_files() {
    let server = server().await;
    let (_mine, theirs) = two_folders_and_a_change_by_the_artist(&server).await;

    let stale = server.owner_folder().await;
    stale.write("a.txt", "v1");
    let report = stale.sync().await.unwrap();
    assert!(report.uploaded.is_empty(), "{}", describe(&report));
    assert_eq!(report.conflicts.len(), 1, "{}", describe(&report));
    assert_eq!(stale.on_server("a.txt").await, b"theirs", "the old copy replaced the current file");
    assert_eq!(stale.read("a.txt").as_deref(), Some(&b"theirs"[..]));
    assert_eq!(stale.conflict_copy_contents(), vec!["v1"]);
    assert_quiet(&theirs.sync().await.unwrap());
    assert_eq!(theirs.read("a.txt").as_deref(), Some(&b"theirs"[..]));
}

/// First link of a folder whose files are already the server's, one small
/// and one over the full-hash limit: nothing is stored again and no conflict
/// copy is made, whichever of sync and pull runs first.
#[tokio::test]
async fn first_link_of_a_folder_identical_to_the_server_changes_nothing() {
    let server = server().await;
    let theirs = server.artist_folder().await;
    theirs.write("a.txt", "same");
    theirs.write(BIG, big(7));
    theirs.sync().await.unwrap();

    for pull_first in [false, true] {
        let mine = server.owner_folder().await;
        mine.write("a.txt", "same");
        mine.write(BIG, big(7));
        let report = if pull_first { mine.pull().await.unwrap() } else { mine.sync().await.unwrap() };
        assert_quiet(&report);
        assert!(mine.conflict_copies().is_empty(), "pull_first={pull_first}: {:?}", mine.conflict_copies());
        assert_quiet(&mine.sync().await.unwrap());
        assert_eq!(mine.state().baselines.get(BIG), Some(&mine.manifest_etag(BIG).await));
        assert_eq!(mine.recorded("a.txt", "upload").await, 1, "pull_first={pull_first}");
        assert_eq!(mine.recorded(BIG, "upload").await, 1, "pull_first={pull_first}");
    }
}

// -- A member who may read and not write -------------------------------------

/// The folder of someone whose uploads the server refuses with 403, holding
/// `a.txt` = "v1" from the owner.
async fn reader_with_a_synced_file(server: &Server, token: &str) -> (Folder, Folder) {
    let writer = server.owner_folder().await;
    writer.write("a.txt", "v1");
    writer.write("shared.txt", "v1");
    writer.sync().await.unwrap();
    let reader = server.folder(token);
    reader.pull().await.unwrap();
    (writer, reader)
}

async fn refused_uploads_do_not_stop_the_pull(server: &Server, token: &str) -> SyncReport {
    let (writer, reader) = reader_with_a_synced_file(server, token).await;
    reader.write("a.txt", "my local edit");
    reader.write("mine-only.txt", "a new local file");
    reader.write("shared.txt", "my edit of the file the owner is about to change");
    writer.write("c.txt", "from the owner");
    writer.write("shared.txt", "v2 by the owner");
    writer.sync().await.unwrap();

    let report = reader.sync().await.expect("a refused upload must not stop the pull");
    assert!(report.uploaded.is_empty(), "{}", describe(&report));
    assert!(report.downloaded.contains(&"c.txt".to_string()), "{}", describe(&report));
    assert_eq!(reader.read("c.txt").as_deref(), Some(&b"from the owner"[..]));
    // Nothing reached the server, and the local work is still there.
    assert_eq!(writer.on_server("a.txt").await, b"v1");
    assert_eq!(writer.manifest_etag("mine-only.txt").await, None);
    assert_eq!(reader.read("a.txt").as_deref(), Some(&b"my local edit"[..]));
    assert_eq!(reader.read("mine-only.txt").as_deref(), Some(&b"a new local file"[..]));
    // A file both changed: the server's version, and the edit in a copy.
    assert_eq!(reader.read("shared.txt").as_deref(), Some(&b"v2 by the owner"[..]));
    assert_eq!(reader.conflict_copy_contents(), vec!["my edit of the file the owner is about to change"]);
    report
}

#[tokio::test]
async fn member_without_write_permission_still_receives_changes() {
    let server = server().await;
    let report = refused_uploads_do_not_stop_the_pull(&server, &server.viewer_login).await;
    // Each local change is reported with the server's reason.
    let reason = "(not uploaded: you do not have permission (403: Lore asset uploads require at least Artist role))";
    assert_eq!(
        report.not_uploaded,
        vec![format!("a.txt {reason}"), format!("mine-only.txt {reason}"), format!("shared.txt {reason}")],
    );
}

#[tokio::test]
async fn read_only_token_with_a_local_edit_still_receives_changes() {
    let server = server().await;
    let token = server.connect_token(&server.artist_login, "read").await;
    let report = refused_uploads_do_not_stop_the_pull(&server, &token).await;
    assert_eq!(report.not_uploaded.len(), 3, "{}", describe(&report));
    for line in &report.not_uploaded {
        assert!(line.contains("(not uploaded: this connect token is read-only; mint one with write scope"), "{line}");
        assert!(line.ends_with("(403))"), "{line}");
    }
}

/// Someone who may not read the repo either: the manifest's 403 ends the
/// round, as before.
#[tokio::test]
async fn no_access_at_all_still_ends_the_round() {
    let server = server().await;
    let outsider = server.state.wdb.create_user("outsider", None, "test-registered-hash").await.unwrap();
    let folder = server.folder(&jwt(&server.state, outsider, "outsider"));
    folder.write("a.txt", "mine");
    let error = folder.sync().await.err().expect("a non-member must not sync").to_string();
    assert!(error.contains("403"), "{error}");
    assert_eq!(folder.read("a.txt").as_deref(), Some(&b"mine"[..]));
}

// -- The change-feed cursor --------------------------------------------------

/// The server sends at most 1000 entries per page. The cursor a round stores
/// is the end of the feed, not the end of the first page.
#[tokio::test]
async fn cursor_reaches_the_end_of_a_feed_longer_than_one_page() {
    let server = server().await;
    let folder = server.owner_folder().await;
    let repo = server.repo;
    folder.write("a.txt", "v1");
    folder.sync().await.unwrap();
    for n in 0..1100 {
        server
            .state
            .wdb
            .lore_file_change(repo, "elsewhere.bin", "upload", Some("etag"), &format!("{n:032}"), 1)
            .await
            .unwrap();
    }
    let first_page = folder.client.changes(repo, 0).await.unwrap();
    assert_eq!(first_page.changes.len(), 1000, "the server's page size");
    let rest = folder.client.changes(repo, first_page.latest_seq).await.unwrap();
    assert_eq!(rest.changes.len(), 101);
    let head = rest.latest_seq;

    folder.sync().await.unwrap();
    assert_eq!(folder.state().cursor, head, "the cursor stopped at the end of the first page");

    // What `watch` asks between rounds: is there anything after my cursor?
    assert!(!folder.client.remote_moved(repo, head).await.unwrap());
    let theirs = server.artist_folder().await;
    theirs.write("b.txt", "from the artist");
    theirs.push().await.unwrap();
    assert!(folder.client.remote_moved(repo, head).await.unwrap(), "a change past entry 1000 goes unnoticed");
    let report = folder.sync().await.unwrap();
    assert_eq!(report.downloaded, vec!["b.txt"], "{}", describe(&report));
    let cursor = folder.state().cursor;
    assert!(cursor > head);
    assert!(!folder.client.remote_moved(repo, cursor).await.unwrap());

    // A folder that starts at 0 pages through the whole feed.
    theirs.sync().await.unwrap();
    assert_eq!(theirs.state().cursor, cursor);
}

// -- Routes outside the sync round -------------------------------------------

/// `wabi-sync lock` / `unlock`.
#[tokio::test]
async fn lock_and_unlock_are_accepted() {
    let server = server().await;
    let folder = server.owner_folder().await;
    folder.write("docs/a.txt", "v1");
    folder.sync().await.unwrap();
    folder.client.set_lock(server.repo, "docs/a.txt", true).await.expect("lock");
    folder.client.set_lock(server.repo, "docs/a.txt", false).await.expect("unlock");
}

/// `wabi-sync login` and `status` probe the health route. (`wabi-sync link`
/// itself sends nothing; it writes the link file used by every test here.)
#[tokio::test]
async fn health_probe_answers() {
    let server = server().await;
    let folder = server.owner_folder().await;
    folder.client.ping().await.expect("health probe");
}

// -- Files over the full-hash limit ------------------------------------------

const BIG: &str = "big.bin";

/// Just over 4 MiB; `fill` makes two versions differ in every byte.
fn big(fill: u8) -> Vec<u8> {
    vec![fill; ETAG_FULL_HASH_MAX_BYTES as usize + 1]
}

/// Above 4 MiB the manifest and If-Match use the server's sampled `q-` etag
/// of its own copy, which is not the hash of the uploaded body.
#[tokio::test]
async fn large_file_round_trip_is_quiet() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;

    mine.write(BIG, big(1));
    let first = mine.sync().await.unwrap();
    assert_eq!(first.uploaded, vec![BIG], "{}", describe(&first));
    assert!(first.downloaded.is_empty(), "downloaded its own upload: {}", describe(&first));
    let server_etag = mine.manifest_etag(BIG).await.unwrap();
    assert!(server_etag.starts_with("q-"), "the manifest etag of a large file is sampled: {server_etag}");

    assert_quiet(&mine.sync().await.unwrap());
    assert_eq!(mine.state().baselines.get(BIG), Some(&Some(server_etag.clone())), "baseline is not the server's etag");
    assert_eq!(mine.recorded(BIG, "upload").await, 1);

    let report = theirs.sync().await.unwrap();
    assert_eq!(report.downloaded, vec![BIG], "{}", describe(&report));
    assert_eq!(theirs.read(BIG), Some(big(1)));
    assert_quiet(&theirs.sync().await.unwrap());
    assert_eq!(theirs.state().baselines.get(BIG), Some(&Some(server_etag)));
    assert_eq!(theirs.recorded(BIG, "upload").await, 1, "the downloaded file was uploaded back");

    // An edit goes up with If-Match carrying the server's etag, and the other
    // folder takes it without a conflict copy.
    mine.write(BIG, big(2));
    let report = mine.sync().await.unwrap();
    assert_eq!(report.uploaded, vec![BIG], "{}", describe(&report));
    assert!(report.conflicts.is_empty() && report.downloaded.is_empty(), "{}", describe(&report));
    assert!(mine.conflict_copies().is_empty());
    assert_quiet(&mine.sync().await.unwrap());

    let report = theirs.sync().await.unwrap();
    assert_eq!(report.downloaded, vec![BIG], "{}", describe(&report));
    assert!(report.conflicts.is_empty(), "{}", describe(&report));
    assert_eq!(theirs.read(BIG), Some(big(2)));
    assert!(theirs.conflict_copies().is_empty());
    assert_quiet(&theirs.sync().await.unwrap());
    assert_eq!(mine.recorded(BIG, "upload").await, 2);
}

// -- Task 4.8g: whose state is it --------------------------------------------

/// B1. A folder synced with one repo is linked to another, empty one. The
/// baselines belong to the first repo; read against the second they say
/// "every file vanished on the server and is clean here".
#[tokio::test]
async fn relinking_to_an_empty_repo_deletes_nothing() {
    let server = server().await;
    let mut folder = server.owner_folder().await;
    let first_repo = server.owner_folder().await;
    folder.write("a.txt", "one");
    folder.write("docs/b.txt", "two");
    folder.sync().await.unwrap();
    let before = folder.files();

    let (repo_b, token_b) = server.second_repo().await;
    let state_a = std::fs::read(folder.state_file()).unwrap();
    let linked = folder.relink(&server, repo_b, &token_b);
    // `link` moved the first repo's state aside, whole.
    assert!(matches!(linked, Linked::Replaced { state_moved_to: Some(_), .. }), "{linked:?}");
    assert_eq!(folder.aside("state.json.previous-link"), Some(state_a));
    assert!(!folder.state_file().exists());
    let report = folder.sync().await.unwrap();
    assert!(report.deleted_local.is_empty(), "{}", describe(&report));
    assert_eq!(folder.files(), before, "the folder lost files: {}", describe(&report));
    assert_eq!(report.uploaded, vec!["a.txt", "docs/b.txt"], "{}", describe(&report));
    assert_eq!(folder.listed().await, vec!["a.txt", "docs/b.txt"]);
    // The first repo is as it was.
    assert_eq!(first_repo.listed().await, vec!["a.txt", "docs/b.txt"]);
    assert_quiet(&folder.sync().await.unwrap());
}

/// B1. The other repo holds a different file under the same name: both
/// versions are kept, as for any file with no baseline.
#[tokio::test]
async fn relinking_to_a_repo_with_other_contents_keeps_both_versions() {
    let server = server().await;
    let mut folder = server.owner_folder().await;
    folder.write("a.txt", "from the first repo");
    folder.write("same.txt", "same in both");
    folder.sync().await.unwrap();

    let (repo_b, token_b) = server.second_repo().await;
    let other = server.folder_for(repo_b, &token_b);
    other.write("a.txt", "from the second repo");
    other.write("same.txt", "same in both");
    other.sync().await.unwrap();

    folder.relink(&server, repo_b, &token_b);
    let report = folder.sync().await.unwrap();
    assert!(report.deleted_local.is_empty() && report.uploaded.is_empty(), "{}", describe(&report));
    assert_eq!(report.conflicts.len(), 1, "{}", describe(&report));
    assert_eq!(folder.read("a.txt").as_deref(), Some(&b"from the second repo"[..]));
    assert_eq!(folder.conflict_copy_contents(), vec!["from the first repo"]);
    assert_eq!(folder.on_server("a.txt").await, b"from the second repo");
    assert_quiet(&folder.sync().await.unwrap());
}

/// B1. A state file written before the owner was recorded, and then a new
/// link file: the state is not this link's.
#[tokio::test]
async fn relinking_with_a_state_file_from_an_older_build_deletes_nothing() {
    let server = server().await;
    let mut folder = server.owner_folder().await;
    folder.write("a.txt", "one");
    folder.sync().await.unwrap();
    folder.forget_state_owner();
    let before = folder.files();

    let (repo_b, token_b) = server.second_repo().await;
    // H3: whatever the files' times are. Equal times (a coarse file
    // system, a restore) once made the old state win.
    let linked = folder.relink(&server, repo_b, &token_b);
    assert!(matches!(linked, Linked::Replaced { state_moved_to: Some(_), .. }), "{linked:?}");
    let report = folder.sync().await.unwrap();
    assert!(report.deleted_local.is_empty(), "{}", describe(&report));
    assert_eq!(folder.files(), before);
    assert_eq!(folder.listed().await, vec!["a.txt"]);
    assert_quiet(&folder.sync().await.unwrap());
}

/// H3. Equal times on the link file and an owner-less state, and a relink
/// to an empty repo.
#[tokio::test]
async fn relinking_with_equal_file_times_deletes_nothing() {
    let server = server().await;
    let mut folder = server.owner_folder().await;
    for name in ["a.txt", "b.txt", "c.txt", "d.txt"] {
        folder.write(name, name);
    }
    folder.sync().await.unwrap();
    folder.forget_state_owner();
    let before = folder.files();

    // The link file and the state file get the same time, as on a coarse
    // file system or after a restore; then the folder is linked elsewhere.
    let when = std::time::SystemTime::now();
    for file in [folder.state_file(), folder.path().join(".wabi-sync.json")] {
        std::fs::File::options().write(true).open(file).unwrap().set_modified(when).unwrap();
    }
    let (repo_b, token_b) = server.second_repo().await;
    folder.relink(&server, repo_b, &token_b);
    std::fs::File::options().write(true).open(folder.path().join(".wabi-sync.json")).unwrap().set_modified(when).unwrap();
    let report = folder.sync().await.unwrap();
    assert!(report.deleted_local.is_empty(), "{}", describe(&report));
    assert_eq!(folder.files(), before);
    assert_eq!(report.uploaded.len(), 4, "{}", describe(&report));
}

/// H3 the other way: an older build's `link` rewrites the same link. The
/// state is still this link's: a local deletion is pushed, not undone.
#[tokio::test]
async fn rewriting_the_same_link_keeps_the_state() {
    let server = server().await;
    let mut folder = server.owner_folder().await;
    let token = server.connect_token(&server.owner_login, "write").await;
    folder.write("a.txt", "one");
    folder.write("b.txt", "two");
    folder.sync().await.unwrap();
    folder.forget_state_owner();
    std::fs::remove_file(folder.path().join("a.txt")).unwrap();

    std::thread::sleep(std::time::Duration::from_millis(20));
    folder.relink_with_an_older_build(&server, server.repo, &token);
    let report = folder.sync().await.unwrap();
    assert_eq!(report.deleted_remote, vec!["a.txt"], "{}", describe(&report));
    assert!(folder.read("a.txt").is_none(), "the deletion was undone");
    assert_eq!(folder.listed().await, vec!["b.txt"]);
}

/// H3 with an older build: its `link` leaves an owner-less state behind a
/// new link file. That state is adopted; the mass-deletion guard is what
/// stops it emptying the folder.
#[tokio::test]
async fn an_older_builds_relink_to_an_empty_repo_is_stopped_by_the_guard() {
    let server = server().await;
    let mut folder = server.owner_folder().await;
    for name in ["a.txt", "b.txt", "c.txt"] {
        folder.write(name, name);
    }
    folder.sync().await.unwrap();
    folder.forget_state_owner();
    let before = folder.files();

    let (repo_b, token_b) = server.second_repo().await;
    folder.relink_with_an_older_build(&server, repo_b, &token_b);
    let error = format!("{:#}", folder.sync().await.err().expect("the round emptied the folder"));
    assert!(error.contains("would delete 3 of the 3 synced files in this folder"), "{error}");
    assert_eq!(folder.files(), before);
}

/// H2. The same server reached by another address. The state is the
/// server's; nothing in it may be read as "newly linked", and the round
/// that meets it changes nothing until the user says which it is.
#[tokio::test]
async fn the_same_server_under_another_address_is_not_a_new_link() {
    let server = server().await;
    let mut mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    let token = server.connect_token(&server.owner_login, "write").await;
    for name in ["gone.txt", "deleted-here.txt", "edit.txt", "keep.txt"] {
        mine.write(name, "v1");
    }
    mine.sync().await.unwrap();
    theirs.sync().await.unwrap();
    std::fs::remove_file(theirs.path().join("gone.txt")).unwrap();
    theirs.sync().await.unwrap();
    std::fs::remove_file(mine.path().join("deleted-here.txt")).unwrap();
    mine.write("edit.txt", "v2");

    let other_address = server.url.replace("127.0.0.1", "localhost");
    mine.client = WabiClient::new(&other_address, &token);
    let before = (mine.files(), std::fs::read(mine.state_file()).unwrap(), mine.listed().await);
    for _ in 0..2 {
        let error = format!("{:#}", mine.sync().await.err().expect("the state of another address was used"));
        assert!(error.contains(&format!("{} channel {}", server.url, server.repo)), "{error}");
        assert!(error.contains(&format!("{other_address} channel {}", server.repo)), "{error}");
        assert!(error.contains("--keep-state"), "{error}");
        assert_eq!((mine.files(), std::fs::read(mine.state_file()).unwrap(), mine.listed().await), before);
    }

    // The user says it is the same server.
    let link = LinkConfig { server_url: server.url.clone(), channel_id: server.repo };
    let linked = link.link(mine.path(), &StateOwner::new(&other_address, server.repo), true).unwrap();
    assert!(matches!(linked, Linked::KeptState { .. }), "{linked:?}");
    let report = mine.sync().await.unwrap();
    assert_eq!(report.deleted_local, vec!["gone.txt"], "{}", describe(&report));
    assert_eq!(report.deleted_remote, vec!["deleted-here.txt"], "{}", describe(&report));
    assert_eq!(report.uploaded, vec!["edit.txt"], "{}", describe(&report));
    assert!(report.conflicts.is_empty() && mine.conflict_copies().is_empty(), "{}", describe(&report));
    assert_eq!(mine.listed().await, vec!["edit.txt", "keep.txt"]);

    // And back to the first address: refused again, not silently replaced.
    mine.client = WabiClient::new(&server.url, &token);
    assert!(mine.sync().await.is_err());
}

/// B1. A state file written before the owner was recorded, with the link
/// file it was made for: it goes on being used, and the owner is recorded.
#[tokio::test]
async fn a_state_file_from_an_older_build_is_kept_for_its_own_link() {
    let server = server().await;
    let folder = server.owner_folder().await;
    folder.write("a.txt", "one");
    folder.sync().await.unwrap();
    folder.forget_state_owner();

    // With its baseline, removing the file is a deletion to push. With no
    // baseline the file would come back from the server.
    std::fs::remove_file(folder.path().join("a.txt")).unwrap();
    let report = folder.sync().await.unwrap();
    assert_eq!(report.deleted_remote, vec!["a.txt"], "{}", describe(&report));
    let state: Value = serde_json::from_slice(&std::fs::read(folder.state_file()).unwrap()).unwrap();
    assert_eq!(state["owner"]["channel_id"], json!(server.repo), "no owner recorded: {state}");
    assert_eq!(state["owner"]["server_url"], json!(server.url), "{state}");
}

// -- Task 4.8g: a state file that cannot be read, and two processes -----------

/// B2. Half a state file. Read as "nothing was ever synced" it sends a stale
/// file up and puts back a file someone else deleted.
#[tokio::test]
async fn a_state_file_that_cannot_be_read_stops_the_round() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    mine.write("a.txt", "v1");
    mine.write("gone.txt", "to be deleted by the artist");
    mine.sync().await.unwrap();
    theirs.sync().await.unwrap();
    theirs.write("a.txt", "v2");
    std::fs::remove_file(theirs.path().join("gone.txt")).unwrap();
    theirs.sync().await.unwrap();

    let whole = std::fs::read(mine.state_file()).unwrap();
    std::fs::write(mine.state_file(), &whole[..whole.len() / 2]).unwrap();
    let before = mine.files();

    let error = match mine.sync().await {
        Ok(report) => panic!("the round ran without its state: {}", describe(&report)),
        Err(error) => format!("{error:#}"),
    };
    assert!(error.contains(&mine.state_file().display().to_string()), "the file is not named: {error}");
    assert!(error.contains("move it aside"), "no way out is offered: {error}");
    assert_eq!(mine.files(), before, "the folder was changed");
    assert_eq!(std::fs::read(mine.state_file()).unwrap(), &whole[..whole.len() / 2], "the state file was replaced");
    assert_eq!(mine.listed().await, vec!["a.txt"], "gone.txt was put back");
    assert_eq!(mine.on_server("a.txt").await, b"v2");
    assert!(mine.push().await.is_err() && mine.pull().await.is_err());

    // The way out the message offers: the folder starts as a fresh link.
    std::fs::rename(mine.state_file(), mine.path().join(".wabi-sync/state.json.aside")).unwrap();
    let report = mine.sync().await.unwrap();
    assert_eq!(mine.read("a.txt").as_deref(), Some(&b"v2"[..]), "{}", describe(&report));
    assert_eq!(mine.conflict_copy_contents(), vec!["v1"]);
}

/// B2. Two wabi-sync processes on one folder (`watch` and a manual `sync`).
#[tokio::test]
async fn two_engines_cannot_work_one_folder_at_once() {
    let server = server().await;
    let folder = server.owner_folder().await;
    folder.write("a.txt", "v1");
    folder.sync().await.unwrap();

    let first = folder.engine().unwrap();
    let error = match folder.engine() {
        Ok(_) => panic!("a second engine started on a folder that is being synced"),
        Err(error) => format!("{error:#}"),
    };
    assert!(error.contains("another wabi-sync"), "{error}");
    assert!(error.contains(".wabi-sync/lock"), "the lock file is not named: {error}");
    drop(first);
    // The lock file stays where it is and holds nobody back.
    assert!(folder.path().join(".wabi-sync/lock").exists());
    assert_quiet(&folder.sync().await.unwrap());
}

// -- Task 4.8g: ignored paths --------------------------------------------------

/// B3. A path the local `.wabiignore` starts to exclude is no longer synced.
/// That is not a deletion.
#[tokio::test]
async fn a_newly_ignored_path_is_not_deleted_on_the_server() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    mine.write("scratch/notes.txt", "v1");
    mine.write("keep.txt", "stays");
    mine.sync().await.unwrap();
    theirs.sync().await.unwrap();

    mine.write(".wabiignore", "scratch\n");
    let report = mine.sync().await.unwrap();
    assert!(report.deleted_remote.is_empty(), "{}", describe(&report));
    assert_eq!(mine.listed().await, vec!["keep.txt", "scratch/notes.txt"]);
    assert_eq!(mine.recorded("scratch/notes.txt", "delete").await, 0);
    assert!(!mine.state().baselines.contains_key("scratch/notes.txt"), "the baseline was kept");
    assert_eq!(mine.read("scratch/notes.txt").as_deref(), Some(&b"v1"[..]));

    let report = theirs.sync().await.unwrap();
    assert!(report.deleted_local.is_empty(), "{}", describe(&report));
    assert_eq!(theirs.read("scratch/notes.txt").as_deref(), Some(&b"v1"[..]));

    // Ignored in both directions: the other member's edit stays theirs.
    theirs.write("scratch/notes.txt", "v2");
    theirs.sync().await.unwrap();
    mine.write("scratch/notes.txt", "my private notes");
    assert_quiet(&mine.sync().await.unwrap());
    assert_quiet(&mine.sync().await.unwrap());
    assert_eq!(mine.read("scratch/notes.txt").as_deref(), Some(&b"my private notes"[..]));
    assert_eq!(mine.on_server("scratch/notes.txt").await, b"v2");
    assert!(mine.conflict_copies().is_empty());
}

// -- Task 4.8g: first link of a folder that already holds the files -----------

/// B4. With no baseline every upload is create-only, and the server reads
/// the whole body before it answers 409. A folder that already holds the
/// repo's files must not send them to find that out.
#[tokio::test]
async fn first_link_of_a_filled_folder_sends_no_file_the_server_has() {
    let server = server().await;
    let theirs = server.artist_folder().await;
    let names: Vec<String> = (0..5).map(|n| format!("docs/{n}.txt")).collect();
    for name in &names {
        theirs.write(name, format!("contents of {name}"));
    }
    theirs.write(BIG, big(7));
    theirs.sync().await.unwrap();

    let mine = server.owner_folder().await;
    for name in &names {
        mine.write(name, format!("contents of {name}"));
    }
    mine.write(BIG, big(7));
    mine.write("only-here.txt", "new");
    server.forget_requests();
    let report = mine.sync().await.unwrap();
    assert_eq!(report.uploaded, vec!["only-here.txt"], "{}", describe(&report));
    assert!(report.conflicts.is_empty() && report.downloaded.is_empty(), "{}", describe(&report));

    let (puts, put_bytes) = server.requests("PUT", "/files/");
    let (gets, _) = server.requests("GET", "/files/");
    println!("first link of a filled folder: {puts} PUT ({put_bytes} bytes), {gets} GET of file contents");
    // The one file the server does not have.
    assert_eq!((puts, put_bytes), (1, 3), "files the server already has were sent");
    // A file over the full-hash limit has an etag only the server can
    // compute, so its contents are fetched once and compared here.
    assert_eq!(gets, 1, "small identical files were downloaded");
    assert_eq!(server.requests("GET", &format!("/files/{BIG}")).0, 1);
    assert_quiet(&mine.sync().await.unwrap());

    // The first round of a folder that fails in its leading pull has sent
    // nothing, and the retry is the same first round.
    let late = server.owner_folder().await;
    late.write("docs/0.txt", "contents of docs/0.txt");
    server.forget_requests();
    server.fail_next("GET", "/manifest");
    assert!(late.sync().await.is_err());
    assert_eq!(server.requests("PUT", "/files/").0, 0);
    let report = late.sync().await.unwrap();
    assert!(report.uploaded.is_empty() && report.conflicts.is_empty(), "{}", describe(&report));
    assert_eq!(report.downloaded.len(), 6, "{}", describe(&report));
    assert_eq!(server.requests("PUT", "/files/").0, 0);
}

// -- Task 4.8g: one path's trouble is one path's report -----------------------

/// B5. The server answers 500 to a DELETE (here: its `lore stage` fails).
#[tokio::test]
async fn a_delete_answered_500_does_not_stop_the_round() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    mine.write("a.txt", "v1");
    mine.write("b.txt", "v1");
    mine.sync().await.unwrap();
    theirs.write("c.txt", "from the artist");
    theirs.sync().await.unwrap();

    std::fs::remove_file(mine.path().join("a.txt")).unwrap();
    std::fs::remove_file(mine.path().join("b.txt")).unwrap();
    server.forget_requests();
    server.lore_stage_fails(true);
    let result = mine.sync().await;
    server.lore_stage_fails(false);
    let report = result.expect("one refused deletion must not stop the round");
    assert_eq!(server.requests("DELETE", "/files/").0, 2, "the second deletion was not tried");
    assert_eq!(report.downloaded, vec!["c.txt"], "{}", describe(&report));
    assert!(report.deleted_remote.is_empty(), "{}", describe(&report));
    let line = |path: &str| {
        format!("{path} (not deleted on the server, which answered 500: Internal server error; asked again next round if it is still there)")
    };
    assert_eq!(report.skipped, vec![line("a.txt"), line("b.txt")]);
    // This server had already taken both files out of its working tree
    // when `stage` failed, so the pull of the same round found them gone
    // and there is nothing left to ask for.
    assert_eq!(mine.listed().await, vec!["c.txt"]);
    assert_quiet(&mine.sync().await.unwrap());

    // A 500 that leaves the file on the server: it stays tracked, and the
    // deletion is asked for again and goes through.
    std::fs::remove_file(mine.path().join("c.txt")).unwrap();
    server.answer_500_next("DELETE", "/files/c.txt");
    let report = mine.sync().await.unwrap();
    assert_eq!(report.skipped, vec![line("c.txt")]);
    assert!(mine.read("c.txt").is_none(), "the file came back: {}", describe(&report));
    assert!(mine.state().baselines["c.txt"].is_some());
    let report = mine.sync().await.unwrap();
    assert_eq!(report.deleted_remote, vec!["c.txt"], "{}", describe(&report));
    assert!(mine.listed().await.is_empty());
}

/// B5. A conflict on a file whose name leaves no room for
/// `.wabi-conflict-<tag>` within one file name.
#[tokio::test]
async fn a_conflict_on_a_very_long_name_still_keeps_both() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    let long = format!("{}.txt", "n".repeat(245));
    mine.write(&long, "v1");
    mine.write("other.txt", "v1");
    mine.sync().await.unwrap();
    theirs.sync().await.unwrap();
    theirs.write(&long, "theirs");
    theirs.write("other.txt", "v2");
    theirs.sync().await.unwrap();

    mine.write(&long, "mine");
    let report = mine.sync().await.expect("the conflict copy could not be named");
    assert_eq!(report.conflicts.len(), 1, "{}", describe(&report));
    assert_eq!(report.downloaded, vec!["other.txt"], "{}", describe(&report));
    assert_eq!(mine.read(&long).as_deref(), Some(&b"theirs"[..]));
    assert_eq!(mine.conflict_copy_contents(), vec!["mine"], "the user's bytes are gone");
    let copy = &mine.conflict_copies()[0];
    assert!(copy.len() <= 255 && copy.starts_with("nnnn"), "{copy}");
    assert!(report.conflicts[0].contains(copy.as_str()), "{}", describe(&report));
    // The copy is not synced, and the next round has nothing to do.
    assert_quiet(&mine.sync().await.unwrap());
    assert_eq!(mine.listed().await, vec![long.as_str(), "other.txt"]);

    // A second conflict on the same file gets a copy of its own.
    theirs.sync().await.unwrap();
    theirs.write(&long, "theirs again");
    theirs.sync().await.unwrap();
    mine.write(&long, "mine again");
    mine.sync().await.unwrap();
    assert_eq!(mine.conflict_copy_contents().len(), 2);
}

/// B5. The server has a file where this folder has a directory.
#[tokio::test]
async fn a_remote_file_where_a_local_directory_sits_does_not_stop_the_round() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    theirs.write("thing", "a file");
    theirs.write("z.txt", "from the artist");
    theirs.sync().await.unwrap();

    std::fs::create_dir_all(mine.path().join("thing")).unwrap();
    for _ in 0..2 {
        let report = mine.sync().await.expect("one path that cannot be written must not stop the round");
        assert_eq!(mine.read("z.txt").as_deref(), Some(&b"from the artist"[..]), "{}", describe(&report));
        assert!(mine.path().join("thing").is_dir());
        assert_eq!(
            report.skipped,
            vec!["thing (not downloaded: thing is a directory in this folder and a file on the server; rename one of the two)"],
        );
    }
    // The other way round: a file here where the server has a directory.
    theirs.write("dir/inner.txt", "inside");
    theirs.write("zz.txt", "later");
    theirs.sync().await.unwrap();
    mine.write("dir", "a file of mine");
    let report = mine.sync().await.expect("one path that cannot be written must not stop the round");
    assert_eq!(mine.read("zz.txt").as_deref(), Some(&b"later"[..]), "{}", describe(&report));
    assert_eq!(mine.read("dir").as_deref(), Some(&b"a file of mine"[..]));
    assert!(
        report.skipped.contains(
            &"dir/inner.txt (not downloaded: dir is a file in this folder and a directory on the server; rename one of the two)"
                .to_string()
        ),
        "{}",
        describe(&report)
    );
    assert!(report.not_uploaded.iter().any(|line| line.starts_with("dir (not uploaded: ")), "{}", describe(&report));
}

/// B5. A symbolic link to nothing.
#[tokio::test]
async fn a_dangling_symlink_does_not_stop_the_round() {
    let server = server().await;
    let mine = server.owner_folder().await;
    mine.write("a.txt", "v1");
    mine.write("b.txt", "v1");
    mine.sync().await.unwrap();

    std::os::unix::fs::symlink("nowhere", mine.path().join("broken")).unwrap();
    mine.write("c.txt", "new");
    let report = mine.sync().await.expect("a dangling symlink must not stop the round");
    assert_eq!(report.uploaded, vec!["c.txt"], "{}", describe(&report));
    // Said once, though the push and the pull both scanned the folder.
    assert_eq!(
        report.skipped,
        vec!["broken (not synced: it is a symbolic link to something that is not there)"],
        "{}",
        describe(&report)
    );

    // A synced file replaced by a link to nothing cannot be read. That is
    // not a deletion, and nothing is downloaded through the link.
    std::fs::remove_file(mine.path().join("a.txt")).unwrap();
    std::os::unix::fs::symlink(mine.path().join("../outside-the-folder"), mine.path().join("a.txt")).unwrap();
    let report = mine.sync().await.unwrap();
    assert!(report.deleted_remote.is_empty() && report.downloaded.is_empty(), "{}", describe(&report));
    assert_eq!(report.skipped.len(), 2, "{}", describe(&report));
    assert!(report.skipped[0].starts_with("a.txt (not synced: "), "{}", describe(&report));
    assert_eq!(mine.on_server("a.txt").await, b"v1");
    assert!(!mine.path().join("../outside-the-folder").exists());
    assert!(mine.state().baselines["a.txt"].is_some(), "the file is no longer tracked");
}

/// B5. A refused file is sent whole again every round.
#[tokio::test]
async fn a_refused_file_is_not_sent_again_until_it_changes() {
    let server = server().await;
    let mine = server.owner_folder().await;
    mine.write("AUX.txt", "not a portable name");
    mine.write("node_modules/pkg/x.js", "ignored by the repo's .wabiignore");
    let first = mine.sync().await.unwrap();
    assert_eq!(first.not_uploaded.len(), 2, "{}", describe(&first));

    server.forget_requests();
    let second = mine.sync().await.unwrap();
    // A 400 and a 422 (the repo's .wabiignore, Task 4.7) are about the file
    // and are remembered: neither is sent again unchanged. A 5xx is tried
    // again (an_upload_answered_500_is_tried_again).
    assert_eq!(server.requests("PUT", "/files/AUX.txt").0, 0, "a file refused with 400 was sent again unchanged");
    assert_eq!(server.requests("PUT", "/files/node_modules").0, 0, "a file refused with 422 was sent again unchanged");
    assert_eq!(second.not_uploaded.len(), 2, "{}", describe(&second));
    assert!(second.not_uploaded[0].starts_with("AUX.txt (still not uploaded"), "{}", describe(&second));
    assert!(second.not_uploaded[0].contains("400: Invalid repository file path"), "{}", describe(&second));
    assert!(second.not_uploaded[1].starts_with("node_modules/pkg/x.js (still not uploaded"), "{}", describe(&second));
    assert!(second.not_uploaded[1].contains("422"), "{}", describe(&second));
    assert!(mine.state().refused_uploads.contains_key("node_modules/pkg/x.js"));

    // Changed: offered again.
    mine.write("AUX.txt", "edited");
    server.forget_requests();
    let third = mine.sync().await.unwrap();
    assert_eq!(server.requests("PUT", "/files/AUX.txt"), (1, 6));
    assert!(third.not_uploaded[0].starts_with("AUX.txt (not uploaded: "), "{}", describe(&third));

    // What `wabi-sync resubmit <path>` does for a refused file.
    let mut state = mine.state();
    assert!(state.refused_uploads.remove("AUX.txt").is_some());
    state.save(mine.path()).unwrap();
    server.forget_requests();
    mine.sync().await.unwrap();
    assert_eq!(server.requests("PUT", "/files/AUX.txt").0, 1);

    // A refused file that is removed is forgotten.
    std::fs::remove_file(mine.path().join("AUX.txt")).unwrap();
    std::fs::remove_dir_all(mine.path().join("node_modules")).unwrap();
    assert_quiet(&mine.sync().await.unwrap());
    assert!(mine.state().refused_uploads.is_empty());
}

/// B5. A refusal for lack of permission is about the member, not the file:
/// one file per round asks again, and when it is accepted the rest follow.
#[tokio::test]
async fn files_refused_for_lack_of_permission_go_up_once_permission_is_given() {
    let server = server().await;
    let reader = server.folder(&server.viewer_login);
    reader.write("one.txt", "1");
    reader.write("two.txt", "2");
    reader.write("three.txt", "3");
    assert_eq!(reader.sync().await.unwrap().not_uploaded.len(), 3);

    server.forget_requests();
    let report = reader.sync().await.unwrap();
    assert_eq!(report.not_uploaded.len(), 3, "{}", describe(&report));
    assert_eq!(server.requests("PUT", "/files/").0, 1, "every refused file was sent again");
    assert!(report.not_uploaded[0].starts_with("one.txt (not uploaded: you do not have permission"), "{}", describe(&report));
    assert!(report.not_uploaded[1].starts_with("three.txt (still not uploaded: you do not have permission"), "{}", describe(&report));

    server
        .state
        .wdb
        .ingest_event(
            "rbac",
            "assign_role",
            &json!({ "userId": server.viewer_id, "workspaceId": "default-workspace", "role": "Artist", "assignedBy": server.owner_id }),
        )
        .await
        .unwrap();
    let report = reader.sync().await.unwrap();
    assert_eq!(report.uploaded, vec!["one.txt", "three.txt", "two.txt"], "{}", describe(&report));
    assert!(report.not_uploaded.is_empty(), "{}", describe(&report));
}

// -- Task 4.8g: the cursor ------------------------------------------------------

/// B6. A server restored from a backup has a shorter feed than the cursor
/// this folder stored. Nothing after that cursor ever appears.
#[tokio::test]
async fn a_cursor_ahead_of_the_feed_comes_back() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    mine.write("a.txt", "v1");
    mine.sync().await.unwrap();
    let end = mine.state().cursor;
    assert!(end > 0);

    // What the folder holds after the server went back in time.
    let mut state = mine.state();
    state.cursor = end + 10_000;
    state.save(mine.path()).unwrap();
    let ahead = state.cursor;

    assert_quiet(&mine.sync().await.unwrap());
    assert_eq!(mine.state().cursor, end, "the cursor stayed ahead of the feed");

    // And what `watch` asks between rounds, before any round has repaired it.
    theirs.write("b.txt", "from the artist");
    theirs.sync().await.unwrap();
    assert!(mine.client.remote_moved(server.repo, ahead).await.unwrap(), "a cursor ahead of the feed sees no change");
    assert!(mine.client.remote_moved(server.repo, end).await.unwrap());
    let report = mine.sync().await.unwrap();
    assert_eq!(report.downloaded, vec!["b.txt"], "{}", describe(&report));
    let cursor = mine.state().cursor;
    assert!(cursor > end && cursor < ahead, "{cursor}");
    assert!(!mine.client.remote_moved(server.repo, cursor).await.unwrap());
}

// -- Task 4.8g: names that only look like the client's own -------------------

/// B7. The server accepts all of these; the client dropped them without a
/// word, in both directions.
#[tokio::test]
async fn names_that_only_look_internal_are_synced() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    let names = ["How.Wabi-Conflict-Works.md", "about.wabi-conflict-handling.md", "notes.wabi-conflict-old/a.md"];
    for name in names {
        mine.write(name, format!("contents of {name}"));
    }
    // Real conflict copies, which stay where they are: this build's, and
    // the two tags builds before 4.8f also wrote (H5).
    mine.write("a.txt.wabi-conflict-0a1b2c3d", "mine");
    mine.write("a.txt.wabi-conflict-server", "mine, older");
    mine.write("b.txt.wabi-conflict-", "mine, older still");
    let report = mine.sync().await.unwrap();
    let mut expected: Vec<&str> = names.to_vec();
    expected.sort();
    assert_eq!(report.uploaded, expected, "{}", describe(&report));
    assert_eq!(mine.listed().await, expected);

    let report = theirs.sync().await.unwrap();
    assert_eq!(report.downloaded, expected, "{}", describe(&report));
    // The folder's own link file and state are still its own.
    assert_eq!(LinkConfig::load(theirs.path()).unwrap().channel_id, server.repo);
    assert_quiet(&mine.sync().await.unwrap());
}

// -- Task 4.8g review: a round that would empty one side --------------------

const FOUR: [&str; 4] = ["a.txt", "b.txt", "docs/c.txt", "docs/d.txt"];

async fn two_folders_with_four_files(server: &Server) -> (Folder, Folder) {
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    for name in FOUR {
        mine.write(name, format!("contents of {name}"));
    }
    mine.sync().await.unwrap();
    theirs.sync().await.unwrap();
    (mine, theirs)
}

/// H1. The repo is deleted (default mode: the server's tree goes) and
/// created again in the same channel. Every member's next round read "all
/// files deleted on the server, all clean here" and deleted them all: no
/// copy was left anywhere.
#[tokio::test]
async fn a_repo_deleted_and_created_again_does_not_empty_the_folders() {
    let server = server().await;
    let (mine, theirs) = two_folders_with_four_files(&server).await;
    let response = reqwest::Client::new()
        .delete(format!("{}/api/addons/lore/repos/{}", server.url, server.repo))
        .bearer_auth(&server.owner_login)
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success(), "{}", response.status());
    server.lore.create_repo(server.repo, server.owner_id as i64, "repo").await.unwrap();
    server.state.wdb.lore_create_repo(server.repo, "repo", "embedded://repo", server.owner_id as i64).await.unwrap();
    assert!(mine.listed().await.is_empty(), "the repo was not emptied");

    for folder in [&mine, &theirs] {
        let before = folder.files();
        assert_eq!(before.len(), 4);
        let error = format!("{:#}", folder.sync().await.err().expect("the round deleted every file"));
        assert!(error.contains("would delete 4 of the 4 synced files in this folder"), "{error}");
        assert!(error.contains("--allow-mass-delete"), "{error}");
        assert_eq!(folder.files(), before);
    }

    // The way back the message offers: the folder as a fresh link, whose
    // files go up to the new repo.
    std::fs::rename(mine.state_file(), mine.path().join(".wabi-sync/state.json.old-repo")).unwrap();
    let report = mine.sync().await.unwrap();
    assert_eq!(report.uploaded.len(), 4, "{}", describe(&report));
    let report = theirs.sync().await.unwrap();
    assert!(report.deleted_local.is_empty(), "{}", describe(&report));
    assert_eq!(theirs.files().len(), 4);
}

/// H1. Most files deleted on purpose by another member: the guard asks,
/// and `--allow-mass-delete` goes ahead.
#[tokio::test]
async fn deleting_most_files_needs_to_be_allowed_on_each_side() {
    let server = server().await;
    let (mine, theirs) = two_folders_with_four_files(&server).await;
    for name in &FOUR[..3] {
        std::fs::remove_file(theirs.path().join(name)).unwrap();
    }
    let error = format!("{:#}", theirs.sync().await.err().expect("3 of 4 deletions pushed without asking"));
    assert!(error.contains("would delete 3 of the 4 synced files on the server"), "{error}");
    assert_eq!(theirs.listed().await.len(), 4);
    let report = theirs.sync_allowing_mass_delete().await.unwrap();
    assert_eq!(report.deleted_remote.len(), 3, "{}", describe(&report));

    let before = mine.files();
    let error = format!("{:#}", mine.sync().await.err().expect("3 of 4 deleted here without asking"));
    assert!(error.contains("would delete 3 of the 4 synced files in this folder"), "{error}");
    assert_eq!(mine.files(), before);
    let report = mine.sync_allowing_mass_delete().await.unwrap();
    assert_eq!(report.deleted_local.len(), 3, "{}", describe(&report));
    assert_eq!(mine.files().len(), 1);
}

/// H1. A folder emptied by accident does not empty the server.
#[tokio::test]
async fn an_emptied_folder_does_not_empty_the_server() {
    let server = server().await;
    let (mine, theirs) = two_folders_with_four_files(&server).await;
    std::fs::remove_dir_all(mine.path().join("docs")).unwrap();
    std::fs::remove_file(mine.path().join("a.txt")).unwrap();
    std::fs::remove_file(mine.path().join("b.txt")).unwrap();
    server.forget_requests();
    let error = format!("{:#}", mine.sync().await.err().expect("the server was emptied"));
    assert!(error.contains("would delete 4 of the 4 synced files on the server"), "{error}");
    assert_eq!(server.requests("DELETE", "/files/").0, 0);
    assert_eq!(theirs.listed().await.len(), 4);
    assert!(theirs.sync().await.unwrap().deleted_local.is_empty());

    // The way back the message offers: the files come down again.
    std::fs::rename(mine.state_file(), mine.path().join(".wabi-sync/state.json.emptied")).unwrap();
    let report = mine.sync().await.unwrap();
    assert_eq!(report.downloaded.len(), 4, "{}", describe(&report));
    assert!(report.deleted_remote.is_empty(), "{}", describe(&report));
    assert_eq!(mine.files().len(), 4);
}

/// H1. Below the guard: two files, or fewer than half.
#[tokio::test]
async fn a_few_deletions_need_no_permission() {
    let server = server().await;
    let (mine, theirs) = two_folders_with_four_files(&server).await;
    for name in &FOUR[..2] {
        std::fs::remove_file(mine.path().join(name)).unwrap();
    }
    assert_eq!(mine.sync().await.unwrap().deleted_remote.len(), 2);
    assert_eq!(theirs.sync().await.unwrap().deleted_local.len(), 2);
}

// -- Task 4.8g review: refusals that may pass next round ---------------------

/// H4. A 500 on an upload (an overloaded server, a disk that was full) is
/// tried again on the next round, unchanged file or not.
#[tokio::test]
async fn an_upload_answered_500_is_tried_again() {
    let server = server().await;
    let mine = server.owner_folder().await;
    mine.write("first.txt", "synced");
    mine.sync().await.unwrap();
    mine.write("new.txt", "new");
    server.answer_500_next("PUT", "/files/new.txt");
    let report = mine.sync().await.unwrap();
    assert!(report.not_uploaded[0].starts_with("new.txt (not uploaded: "), "{}", describe(&report));
    let report = mine.sync().await.unwrap();
    assert_eq!(report.uploaded, vec!["new.txt"], "{}", describe(&report));
    assert_eq!(mine.on_server("new.txt").await, b"new");
}

// -- Task 4.8g review: a folder linked inside a folder ------------------------

/// H5. The link file and state of a nested linked folder are not synced:
/// another member with the same nested folder would get the uploader's
/// state.json over theirs.
#[tokio::test]
async fn a_nested_linked_folders_state_is_not_synced() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let (repo_b, token_b) = server.second_repo().await;
    let nested = mine.path().join("vendor/other");
    std::fs::create_dir_all(&nested).unwrap();
    LinkConfig { server_url: server.url.clone(), channel_id: repo_b }.save(&nested).unwrap();
    std::fs::write(nested.join("lib.rs"), "pub fn f() {}").unwrap();
    let inner_client = WabiClient::new(&server.url, &token_b);
    let inner_link = LinkConfig::load(&nested).unwrap();
    SyncEngine::new(&inner_client, &nested, &inner_link).unwrap().sync().await.unwrap();
    assert!(nested.join(".wabi-sync/state.json").exists() && nested.join(".wabi-sync/lock").exists());

    let report = mine.sync().await.unwrap();
    assert_eq!(report.uploaded, vec!["vendor/other/lib.rs"], "{}", describe(&report));
    assert_eq!(mine.listed().await, vec!["vendor/other/lib.rs"]);
    assert_eq!(
        report.skipped,
        vec![
            "vendor/other/.wabi-sync (not synced: it is the sync state of a folder linked inside this one)",
            "vendor/other/.wabi-sync.json (not synced: it is the link file of a folder linked inside this one)",
        ],
        "{}",
        describe(&report)
    );
}

// -- Task 4.8g review: lines no test covered ----------------------------------

/// A pull alone after a path became ignored. Without the pull's own
/// `forget_ignored` the path, missing from the filtered manifest, read as
/// "deleted on the server, clean here" and the file was deleted.
#[tokio::test]
async fn a_pull_after_a_path_became_ignored_deletes_nothing() {
    let server = server().await;
    let mine = server.owner_folder().await;
    mine.write("scratch/notes.txt", "v1");
    mine.write("keep.txt", "v1");
    mine.sync().await.unwrap();
    mine.write(".wabiignore", "scratch\n");
    let report = mine.pull().await.unwrap();
    assert!(report.deleted_local.is_empty(), "{}", describe(&report));
    assert_eq!(mine.read("scratch/notes.txt").as_deref(), Some(&b"v1"[..]));
    assert!(!mine.state().baselines.contains_key("scratch/notes.txt"));
}

/// A synced file that cannot be read for a while (here a link to nothing)
/// is deleted on the server meanwhile. Its baseline must stay: when the
/// user's file is back with an edit, that is a conflict with a deletion,
/// not a new file uploaded over the other member's deletion.
#[tokio::test]
async fn a_file_unreadable_while_deleted_on_the_server_is_a_conflict_later() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    mine.write("a.txt", "v1");
    mine.sync().await.unwrap();
    theirs.sync().await.unwrap();
    std::fs::remove_file(mine.path().join("a.txt")).unwrap();
    std::os::unix::fs::symlink("nowhere", mine.path().join("a.txt")).unwrap();
    std::fs::remove_file(theirs.path().join("a.txt")).unwrap();
    theirs.sync().await.unwrap();

    mine.sync().await.unwrap();
    assert!(mine.state().baselines.contains_key("a.txt"), "the baseline was dropped while the file could not be read");
    std::fs::remove_file(mine.path().join("a.txt")).unwrap();
    mine.write("a.txt", "my edit");
    let report = mine.sync().await.unwrap();
    assert!(report.uploaded.is_empty(), "{}", describe(&report));
    assert!(mine.listed().await.is_empty(), "the other member's deletion was undone");
    assert_eq!(mine.conflict_copy_contents(), vec!["my edit"]);
}

/// A download must not write through a link to nothing: the bytes would
/// land outside the folder, wherever the link points.
#[tokio::test]
async fn a_download_does_not_write_through_a_dangling_symlink() {
    let server = server().await;
    let mine = server.owner_folder().await;
    let theirs = server.artist_folder().await;
    let outside = tempfile::tempdir().unwrap();
    mine.write("a.txt", "v1");
    mine.sync().await.unwrap();
    theirs.sync().await.unwrap();
    std::fs::remove_file(mine.path().join("a.txt")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("a"), mine.path().join("a.txt")).unwrap();
    std::os::unix::fs::symlink(outside.path().join("n"), mine.path().join("n.txt")).unwrap();
    theirs.write("a.txt", "v2");
    theirs.write("n.txt", "new");
    theirs.sync().await.unwrap();

    let report = mine.sync().await.unwrap();
    assert!(report.downloaded.is_empty(), "{}", describe(&report));
    assert!(!outside.path().join("a").exists() && !outside.path().join("n").exists(), "written outside the folder");
}

/// A refused file that cannot be read for a round is still refused when it
/// can be read again, unchanged: it is not sent again.
#[tokio::test]
async fn a_refused_file_unreadable_for_a_round_stays_refused() {
    let server = server().await;
    let mine = server.owner_folder().await;
    mine.write("AUX.txt", "not a portable name");
    mine.sync().await.unwrap();
    let away = tempfile::tempdir().unwrap();
    std::fs::rename(mine.path().join("AUX.txt"), away.path().join("AUX.txt")).unwrap();
    std::os::unix::fs::symlink("nowhere", mine.path().join("AUX.txt")).unwrap();
    mine.sync().await.unwrap();
    std::fs::remove_file(mine.path().join("AUX.txt")).unwrap();
    std::fs::rename(away.path().join("AUX.txt"), mine.path().join("AUX.txt")).unwrap();
    server.forget_requests();
    let report = mine.sync().await.unwrap();
    assert_eq!(server.requests("PUT", "/files/").0, 0, "{}", describe(&report));
    assert!(report.not_uploaded[0].starts_with("AUX.txt (still not uploaded"), "{}", describe(&report));
}

/// The pull a first round runs before its push is on disk before the push
/// starts: a round killed in the push does not lose what the pull adopted.
#[tokio::test]
async fn the_first_pull_is_saved_before_the_push() {
    let server = server().await;
    let theirs = server.artist_folder().await;
    theirs.write("a.txt", "same");
    theirs.sync().await.unwrap();
    let mine = server.owner_folder().await;
    mine.write("a.txt", "same");
    mine.write("new.txt", "new");
    server.stall_next("PUT", "/files/new.txt");
    let killed = tokio::time::timeout(std::time::Duration::from_secs(2), mine.sync()).await;
    assert!(killed.is_err(), "the round was meant to hang on the upload");
    assert_eq!(mine.state().baselines.get("a.txt"), Some(&Some(etag_for_bytes(b"same"))), "the pull's work was lost");
}
