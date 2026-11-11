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
    config::{LinkConfig, SyncState},
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

struct Server {
    _dir: tempfile::TempDir,
    url: String,
    /// Numeric id of the Lore channel.
    repo: i64,
    /// Login JWTs, used only to mint connect tokens.
    owner_login: String,
    artist_login: String,
    null_etag: NullEtag,
}

/// A server with one Lore repo and two members who may write to it: the
/// owner and an Artist.
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
    let channel = state.wdb.create_channel("repo", ChannelKind::Lore, owner, false).await.unwrap();
    for uid in [owner, artist] {
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
             case \"$1\" in\n\
               commit) n=$(( $(cat '{counter}' 2>/dev/null || echo 0) + 1 )); echo $n > '{counter}'\n\
                 printf 'Revision  : %s\\nSignature : %032d\\nBranch    : main\\nDate      : Mon, 07 Sep 2026 00:00:00 +0000\\n    fixture\\nCommit succeeded\\n' $n $n ;;\n\
               branch) [ \"$2\" = list ] && echo '* main' ; exit 0 ;;\n\
               *) exit 0 ;;\n\
             esac\n",
            counter = counter.display(),
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
    state.set_lore_service(lore).await;
    state.wdb.lore_create_repo(repo, "repo", "embedded://repo", owner as i64).await.unwrap();

    let null_etag = NullEtag::default();
    let app = axum::Router::new()
        .nest("/api", create_api_router(state.clone()).with_state(state.clone()))
        .layer(axum::middleware::from_fn_with_state(null_etag.clone(), null_one_manifest_etag));
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
        _dir: dir,
        url,
        repo,
        null_etag,
    }
}

impl Server {
    /// Mint a connect token through the real route, as the Connect panel does.
    async fn connect_token(&self, login: &str, scopes: &str) -> String {
        let response = reqwest::Client::new()
            .post(format!("{}/api/addons/lore/repos/{}/connect-tokens", self.url, self.repo))
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
        let dir = tempfile::tempdir().unwrap();
        let channel_id = LinkConfig::normalize_channel_id(&format!("ch_{:x}", self.repo)).unwrap();
        LinkConfig { server_url: self.url.clone(), channel_id }.save(dir.path()).unwrap();
        let link = LinkConfig::load(dir.path()).unwrap();
        assert_eq!(link.channel_id, self.repo);
        Folder { client: WabiClient::new(&link.server_url, token), link, dir }
    }

    async fn owner_folder(&self) -> Folder {
        self.folder(&self.connect_token(&self.owner_login, "write").await)
    }

    async fn artist_folder(&self) -> Folder {
        self.folder(&self.connect_token(&self.artist_login, "write").await)
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

    /// One `wabi-sync sync` round: a new engine, so state goes through disk.
    async fn sync(&self) -> anyhow::Result<SyncReport> {
        SyncEngine::new(&self.client, self.path(), &self.link).sync().await
    }

    /// One `wabi-sync push`.
    async fn push(&self) -> anyhow::Result<SyncReport> {
        let mut engine = SyncEngine::new(&self.client, self.path(), &self.link);
        let report = engine.push().await?;
        engine.save_state()?;
        Ok(report)
    }

    /// One `wabi-sync pull`.
    async fn pull(&self) -> anyhow::Result<SyncReport> {
        let mut engine = SyncEngine::new(&self.client, self.path(), &self.link);
        let report = engine.pull().await?;
        engine.save_state()?;
        Ok(report)
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
        std::fs::read_dir(self.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".wabi-conflict-"))
            .collect()
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
        "downloaded {:?}, uploaded {:?}, deleted_local {:?}, deleted_remote {:?}, conflicts {:?}, waiting_review {:?}, not_deleted {:?}",
        report.downloaded,
        report.uploaded,
        report.deleted_local,
        report.deleted_remote,
        report.conflicts,
        report.waiting_review,
        report.not_deleted
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

    let refused = reader.client.upload(repo, "b.txt", b"x".to_vec(), "m", Some("")).await.unwrap_err().to_string();
    assert!(refused.contains("read-only"), "the 403 was not explained: {refused}");
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
    assert!(report.uploaded.is_empty() && report.conflicts.is_empty(), "{}", describe(&report));
    assert_eq!(mine.read("a.txt").as_deref(), Some(&b"v1"[..]));
    assert!(mine.conflict_copies().is_empty());
    assert_eq!(mine.state().baselines.get("a.txt"), Some(&Some(etag_for_bytes(b"v1"))));
    // A folder that does not.
    let theirs = server.artist_folder().await;
    theirs.sync().await.expect("a first round with a null etag in the manifest");

    // Once the server can say the etag again, both folders settle.
    *server.null_etag.lock().unwrap() = None;
    assert_quiet(&mine.sync().await.unwrap());
    theirs.sync().await.unwrap();
    assert_eq!(theirs.read("a.txt").as_deref(), Some(&b"v1"[..]));
    assert_quiet(&theirs.sync().await.unwrap());
    assert_eq!(mine.recorded("a.txt", "upload").await, 1);
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
