//! Lore file and recording uploads must authorize before reading the body,
//! stream the body to a private temporary file, and stop reading with 413 the
//! moment the blob cap is exceeded. Real API router + real WabiDB; the Lore CLI
//! is a protocol fixture that logs every invocation so the tests can prove
//! that nothing was staged or committed.
#![cfg(all(feature = "wabi-lore", unix))]

use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::{
    body::{to_bytes, Body, Bytes},
    http::{Method, Request, StatusCode},
};
use futures::StreamExt;
use serde_json::{json, Value};
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

/// The fixture's blob cap is 1 MiB (`default_blob_max_size_mb: 1`).
const CAP: usize = 1024 * 1024;

/// Every test in this binary shares one private TMPDIR so leftover upload
/// temporaries can be detected. Serialize the tests so one test's in-flight
/// temporary is never mistaken for another test's leak.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static TMPDIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn private_tmpdir() -> &'static Path {
    TMPDIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("wabi-lore-upload-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("TMPDIR", &dir);
        dir
    })
}

/// Plain files directly in the private TMPDIR (upload temporaries are files;
/// the per-test data directories are directories).
fn temporary_files() -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(private_tmpdir())
        .unwrap()
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    files.sort();
    files
}

fn server_config(path: &Path) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "lore-upload-streaming-test-only".into(),
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
    state: Arc<AppState>,
    app: axum::Router,
    cli_log: PathBuf,
    asset_tree: PathBuf,
    recordings_tree: PathBuf,
    asset_channel: i64,
    member_token: String,
    outsider_token: String,
    /// Member of the Recordings channel with no Lore capability (Member role).
    viewer_token: String,
}

impl Fixture {
    fn cli_calls(&self) -> String {
        std::fs::read_to_string(&self.cli_log).unwrap_or_default()
    }
}

/// Owner, an Artist who is a member of the asset channel and the Recordings
/// channel, and an Artist who is a member of neither.
async fn fixture() -> Fixture {
    fixture_with_max_body(None).await
}

/// Same fixture with an explicit transport-wide body limit
/// (`ServerConfig::max_body_size`), for the transport-limit test.
async fn fixture_with_max_body(max_body_size: Option<usize>) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let mut config = server_config(dir.path());
    config.max_body_size = max_body_size;
    let state = Arc::new(AppState::new(config).await.unwrap());

    let owner = state
        .wdb
        .create_user("owner", None, "test-registered-hash")
        .await
        .unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);

    let mut artists = Vec::new();
    for (name, role) in [("artist", "Artist"), ("outsider", "Artist"), ("viewer", "Member")] {
        let uid = state
            .wdb
            .create_user(name, None, "test-registered-hash")
            .await
            .unwrap();
        state
            .wdb
            .ingest_event(
                "rbac",
                "assign_role",
                &json!({
                    "userId": uid,
                    "workspaceId": "default-workspace",
                    "role": role,
                    "assignedBy": owner,
                }),
            )
            .await
            .unwrap();
        artists.push(uid);
    }
    let (artist, outsider, viewer) = (artists[0], artists[1], artists[2]);

    let assets = state
        .wdb
        .create_channel("assets", ChannelKind::Lore, owner, false)
        .await
        .unwrap();
    let recordings = state
        .wdb
        .create_channel("Recordings", ChannelKind::Lore, owner, false)
        .await
        .unwrap();
    for channel in [&assets, &recordings] {
        for uid in [owner, artist, viewer] {
            state
                .wdb
                .add_channel_member(channel, uid, MemberRole::Member)
                .await
                .unwrap();
        }
    }

    // Lore CLI fixture: logs each invocation; every commit gets a fresh
    // signature so successive uploads produce distinct revisions.
    let cli_log = dir.path().join("lore-cli.log");
    let counter = dir.path().join("commit-counter");
    let binary = dir.path().join("lore-fixture");
    std::fs::write(
        &binary,
        format!(
            "#!/bin/sh\n\
             if [ \"$1\" = \"--offline\" ] && [ \"$2\" = \"--local\" ]; then shift 2; fi\n\
             echo \"$*\" >> '{log}'\n\
             case \"$1\" in\n\
               commit) n=$(( $(cat '{counter}' 2>/dev/null || echo 0) + 1 )); echo $n > '{counter}'\n\
                 printf 'Revision  : %s\\nSignature : %032d\\nBranch    : main\\nDate      : Mon, 07 Sep 2026 00:00:00 +0000\\n    fixture\\nCommit succeeded\\n' $n $n ;;\n\
               branch) [ \"$2\" = list ] && echo '* main' ; exit 0 ;;\n\
               *) exit 0 ;;\n\
             esac\n",
            log = cli_log.display(),
            counter = counter.display(),
        ),
    )
    .unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let lore = Arc::new(wabi_lore::LoreService::new(wabi_lore::LoreConfig {
        enabled: true,
        lore_binary_path: binary,
        lore_data_dir: dir.path().join("lore"),
        default_blob_max_size_mb: 1,
        ..Default::default()
    }));
    let asset_channel = numeric(&assets);
    lore.create_repo(asset_channel, owner as i64, "assets")
        .await
        .unwrap();
    lore.create_repo(numeric(&recordings), owner as i64, "recordings")
        .await
        .unwrap();
    let asset_tree = lore.repo_working_tree(asset_channel).await.unwrap();
    let recordings_tree = lore.repo_working_tree(numeric(&recordings)).await.unwrap();
    state.set_lore_service(lore).await;
    // Repo creation is setup, not upload behavior.
    let _ = std::fs::remove_file(&cli_log);

    // The API router alone has no transport body limit; the full app adds
    // RequestBodyLimitLayer in build_app_router. Mirror that layer here when a
    // limit is requested so the transport-limit path can be exercised.
    let router = create_api_router(state.clone());
    let router = match max_body_size {
        Some(limit) => router.layer(tower_http::limit::RequestBodyLimitLayer::new(limit)),
        None => router,
    };
    let app = router.with_state(state.clone());
    Fixture {
        member_token: jwt(&state, artist, "artist"),
        outsider_token: jwt(&state, outsider, "outsider"),
        viewer_token: jwt(&state, viewer, "viewer"),
        _dir: dir,
        state,
        app,
        cli_log,
        asset_tree,
        recordings_tree,
        asset_channel,
    }
}

/// A request body that yields `bytes` in 64 KiB chunks, counting every byte
/// the server pulls, then either ends or stays open forever (`then_hang`).
fn counted_body(bytes: Vec<u8>, pulled: Arc<AtomicUsize>, then_hang: bool) -> Body {
    let chunks: Vec<Result<Bytes, std::io::Error>> = bytes
        .chunks(64 * 1024)
        .map(|chunk| Ok(Bytes::copy_from_slice(chunk)))
        .collect();
    let counted = futures::stream::iter(chunks).inspect(move |chunk| {
        if let Ok(chunk) = chunk {
            pulled.fetch_add(chunk.len(), Ordering::SeqCst);
        }
    });
    if then_hang {
        Body::from_stream(counted.chain(futures::stream::pending()))
    } else {
        Body::from_stream(counted)
    }
}

fn upload_request(method: Method, uri: &str, token: &str, body: Body) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/octet-stream")
        .body(body)
        .unwrap()
}

async fn send(app: &axum::Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = tokio::time::timeout(Duration::from_secs(10), app.clone().oneshot(request))
        .await
        .expect("upload must answer without waiting for the rest of the body")
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let body =
        serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes)));
    (status, body)
}

fn file_uri(channel: i64, path: &str) -> String {
    format!("/addons/lore/repos/{channel}/files/{path}")
}

/// Test 1: one byte over the cap is refused with 413 as soon as that byte
/// arrives. The body never ends, so a handler that buffers the whole body
/// before checking the cap cannot answer at all.
#[tokio::test]
async fn upload_one_byte_over_the_blob_cap_is_413_without_reading_the_rest_and_stages_nothing() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;
    let before = temporary_files();

    for (label, method, uri, tree_path) in [
        (
            "file",
            Method::PUT,
            file_uri(f.asset_channel, "big.bin"),
            f.asset_tree.join("big.bin"),
        ),
        (
            "recording",
            Method::POST,
            "/addons/lore/recordings?filename=big.webm".to_string(),
            f.recordings_tree.join("recordings/big.webm"),
        ),
    ] {
        let pulled = Arc::new(AtomicUsize::new(0));
        let body = counted_body(vec![7u8; CAP + 1], pulled.clone(), true);
        let (status, response) =
            send(&f.app, upload_request(method, &uri, &f.member_token, body)).await;
        assert_eq!(
            status,
            StatusCode::PAYLOAD_TOO_LARGE,
            "{label}: body over the cap must be 413: {response}"
        );
        assert_eq!(response["type"], "BlobTooLarge", "{label}: {response}");
        assert!(
            pulled.load(Ordering::SeqCst) <= CAP + 64 * 1024,
            "{label}: server kept reading past the cap"
        );
        assert!(
            !tree_path.exists(),
            "{label}: rejected upload must not reach the working tree"
        );
    }
    let calls = f.cli_calls();
    assert!(
        !calls.contains("stage") && !calls.contains("commit"),
        "rejected uploads must not stage or commit: {calls}"
    );
    assert_eq!(
        temporary_files(),
        before,
        "rejected uploads must remove their private temporary file"
    );
}

/// Test 2: a non-member is refused before any of the body is read. The body
/// is over the cap, so a handler that read first would see 413 or would have
/// pulled bytes before answering 403.
#[tokio::test]
async fn non_member_upload_is_403_before_any_body_byte_is_read() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;

    for (label, method, uri) in [
        ("file", Method::PUT, file_uri(f.asset_channel, "intruder.bin")),
        (
            "recording",
            Method::POST,
            "/addons/lore/recordings?filename=intruder.webm".to_string(),
        ),
    ] {
        let pulled = Arc::new(AtomicUsize::new(0));
        let body = counted_body(vec![1u8; CAP + 1], pulled.clone(), false);
        let (status, response) =
            send(&f.app, upload_request(method, &uri, &f.outsider_token, body)).await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "{label}: non-member upload must be 403, not 413: {response}"
        );
        assert_eq!(
            pulled.load(Ordering::SeqCst),
            0,
            "{label}: the body must not be read before authorization"
        );
    }
    assert!(!f.asset_tree.join("intruder.bin").exists());
    assert!(!f.recordings_tree.join("recordings/intruder.webm").exists());
    let calls = f.cli_calls();
    assert!(
        !calls.contains("stage") && !calls.contains("commit"),
        "refused uploads must not stage or commit: {calls}"
    );
}

/// Test 3: uploads under the cap behave as before: a commit with a fresh
/// revision per upload, the SHA-256 etag of the bytes, the bytes in the
/// working tree, the stage-only path, and the recordings path.
#[tokio::test]
async fn upload_under_the_cap_commits_a_new_revision_with_the_content_etag() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;
    let before = temporary_files();
    let uri = file_uri(f.asset_channel, "docs/note.txt");

    let mut revisions = Vec::new();
    for content in [b"version one".to_vec(), vec![3u8; CAP]] {
        let body = counted_body(content.clone(), Arc::new(AtomicUsize::new(0)), false);
        let (status, response) =
            send(&f.app, upload_request(Method::PUT, &uri, &f.member_token, body)).await;
        assert_eq!(status, StatusCode::OK, "{response}");
        assert_eq!(response["etag"], wabi_lore::etag_for_bytes(&content));
        assert_eq!(response["pendingReview"], false, "{response}");
        assert_eq!(response["wdbRecorded"], true, "{response}");
        let revision = response["revision"]["hash"].as_str().unwrap().to_string();
        assert!(!revision.is_empty(), "{response}");
        revisions.push(revision);
        assert_eq!(
            std::fs::read(f.asset_tree.join("docs/note.txt")).unwrap(),
            content,
            "uploaded bytes must land in the working tree unchanged"
        );
    }
    assert_ne!(revisions[0], revisions[1], "each upload is a new revision");

    // Stage-only: bytes land, nothing is committed, etag matches the bytes.
    let commits_before = f.cli_calls().matches("commit").count();
    let body = counted_body(b"staged".to_vec(), Arc::new(AtomicUsize::new(0)), false);
    let (status, response) = send(
        &f.app,
        upload_request(
            Method::PUT,
            &format!("{}?stage_only=true", file_uri(f.asset_channel, "docs/staged.txt")),
            &f.member_token,
            body,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["staged"], true, "{response}");
    assert_eq!(response["etag"], wabi_lore::etag_for_bytes(b"staged"));
    assert_eq!(f.cli_calls().matches("commit").count(), commits_before);
    assert_eq!(
        std::fs::read(f.asset_tree.join("docs/staged.txt")).unwrap(),
        b"staged"
    );

    // Recordings: same streaming path into recordings/<filename>.
    let body = counted_body(b"webm-bytes".to_vec(), Arc::new(AtomicUsize::new(0)), false);
    let (status, response) = send(
        &f.app,
        upload_request(
            Method::POST,
            "/addons/lore/recordings?filename=call.webm",
            &f.member_token,
            body,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["path"], "recordings/call.webm");
    assert_eq!(response["etag"], wabi_lore::etag_for_bytes(b"webm-bytes"));
    assert_eq!(response["wdbRecorded"], true, "{response}");
    assert_eq!(
        std::fs::read(f.recordings_tree.join("recordings/call.webm")).unwrap(),
        b"webm-bytes"
    );

    assert_eq!(
        temporary_files(),
        before,
        "completed uploads must not leave private temporaries behind"
    );
}

/// Guard for the streaming fix: while a slow body is still arriving, the
/// server-wide membership and credential gates must stay free, so a member
/// removal or credential revocation (and every mutation queued behind it)
/// is not held hostage by one upload.
#[tokio::test]
async fn slow_upload_body_does_not_hold_membership_or_credential_gates() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;

    for (label, method, uri) in [
        ("file", Method::PUT, file_uri(f.asset_channel, "slow.bin")),
        (
            "recording",
            Method::POST,
            "/addons/lore/recordings?filename=slow.webm".to_string(),
        ),
    ] {
        let pulled = Arc::new(AtomicUsize::new(0));
        let body = counted_body(vec![5u8; 1024], pulled.clone(), true);
        let in_flight = tokio::spawn(
            f.app
                .clone()
                .oneshot(upload_request(method, &uri, &f.member_token, body)),
        );
        // Wait until the server is reading the body.
        tokio::time::timeout(Duration::from_secs(10), async {
            while pulled.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("server never started reading the body");

        drop(
            tokio::time::timeout(Duration::from_secs(2), f.state.membership_gate.write())
                .await
                .unwrap_or_else(|_| panic!("{label}: body transfer holds the membership gate")),
        );
        drop(
            tokio::time::timeout(Duration::from_secs(2), f.state.revocations.write())
                .await
                .unwrap_or_else(|_| panic!("{label}: body transfer holds the credential gate")),
        );
        in_flight.abort();
        let _ = in_flight.await;
    }
}

/// Test 5: a streamed body that trips the transport-wide limit
/// (`max_body_size`, below the blob cap here) is still a 413 size rejection,
/// as it was with the buffered extractor, not a 400 malformed request.
#[tokio::test]
async fn transport_body_limit_during_streaming_is_still_413() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture_with_max_body(Some(256 * 1024)).await;
    let before = temporary_files();

    for (label, method, uri, tree_path) in [
        (
            "file",
            Method::PUT,
            file_uri(f.asset_channel, "limited.bin"),
            f.asset_tree.join("limited.bin"),
        ),
        (
            "recording",
            Method::POST,
            "/addons/lore/recordings?filename=limited.webm".to_string(),
            f.recordings_tree.join("recordings/limited.webm"),
        ),
    ] {
        // Under the 1 MiB blob cap, over the 256 KiB transport limit.
        let pulled = Arc::new(AtomicUsize::new(0));
        let body = counted_body(vec![9u8; 512 * 1024], pulled.clone(), false);
        let (status, response) =
            send(&f.app, upload_request(method, &uri, &f.member_token, body)).await;
        assert_eq!(
            status,
            StatusCode::PAYLOAD_TOO_LARGE,
            "{label}: transport-limited body must be 413, not 400: {response}"
        );
        assert!(
            !tree_path.exists(),
            "{label}: rejected upload must not reach the working tree"
        );
    }
    assert_eq!(
        temporary_files(),
        before,
        "rejected uploads must remove their private temporary file"
    );
}

/// A view-only member of the Recordings channel (no `lore.stage`) is refused
/// with 403 before any body byte is read, under both admissions.
#[tokio::test]
async fn view_only_member_recording_upload_is_403_before_any_body_byte_is_read() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;

    let pulled = Arc::new(AtomicUsize::new(0));
    let body = counted_body(b"viewer-bytes".to_vec(), pulled.clone(), false);
    let (status, response) = send(
        &f.app,
        upload_request(
            Method::POST,
            "/addons/lore/recordings?filename=viewer.webm",
            &f.viewer_token,
            body,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{response}");
    assert_eq!(
        pulled.load(Ordering::SeqCst),
        0,
        "the body must not be read before the asset-write check"
    );
    assert!(!f.recordings_tree.join("recordings/viewer.webm").exists());
    let calls = f.cli_calls();
    assert!(
        !calls.contains("stage") && !calls.contains("commit"),
        "refused uploads must not stage or commit: {calls}"
    );
}

/// The filename is a single path component: separators are refused with 400
/// and nothing is written, so a caller cannot choose subdirectories (or
/// escape) under recordings/.
#[tokio::test]
async fn recording_filename_with_a_separator_is_rejected_and_writes_nothing() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;
    let before = temporary_files();

    for filename in ["sub%2Fdir.webm", "sub%5Cdir.webm", "..%2Fescape.webm", "a%2F..%2Fb.webm"] {
        let body = counted_body(b"bytes".to_vec(), Arc::new(AtomicUsize::new(0)), false);
        let (status, response) = send(
            &f.app,
            upload_request(
                Method::POST,
                &format!("/addons/lore/recordings?filename={filename}"),
                &f.member_token,
                body,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{filename}: {response}");
    }
    assert!(!f.recordings_tree.join("recordings/sub").exists());
    assert!(!f.recordings_tree.join("recordings/sub\\dir.webm").exists());
    assert!(!f.recordings_tree.join("escape.webm").exists());
    let calls = f.cli_calls();
    assert!(
        !calls.contains("stage") && !calls.contains("commit"),
        "rejected filenames must not stage or commit: {calls}"
    );
    assert_eq!(temporary_files(), before, "no private temporary may remain");
}

/// A filename that names no file ("" or ".") would resolve to the
/// `recordings` directory path itself. It is refused with 400 and nothing is
/// written: creating a file called `recordings` would block every later
/// recording.
#[tokio::test]
async fn recording_filename_that_names_no_file_is_rejected_and_writes_nothing() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;
    let before = temporary_files();

    for filename in ["", ".", "..", "%20"] {
        let body = counted_body(b"bytes".to_vec(), Arc::new(AtomicUsize::new(0)), false);
        let (status, response) = send(
            &f.app,
            upload_request(
                Method::POST,
                &format!("/addons/lore/recordings?filename={filename}"),
                &f.member_token,
                body,
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{filename:?}: {response}");
    }
    assert!(
        !f.recordings_tree.join("recordings").is_file(),
        "no file may be created at the recordings directory path"
    );
    let calls = f.cli_calls();
    assert!(
        !calls.contains("stage") && !calls.contains("commit"),
        "rejected filenames must not stage or commit: {calls}"
    );
    assert_eq!(temporary_files(), before, "no private temporary may remain");
}

/// Regression test (already passes on main; the cap came from PR 286): a
/// recording body over the blob cap is 413 and writes nothing.
#[tokio::test]
async fn recording_over_the_blob_cap_is_413_regression() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;

    let body = counted_body(vec![7u8; CAP + 1], Arc::new(AtomicUsize::new(0)), true);
    let (status, response) = send(
        &f.app,
        upload_request(
            Method::POST,
            "/addons/lore/recordings?filename=cap.webm",
            &f.member_token,
            body,
        ),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{response}");
    assert!(!f.recordings_tree.join("recordings/cap.webm").exists());
}

/// An HLS playlist is refused on both Lore upload routes (raw files are
/// served with nosniff, which does not stop native HLS playback), whatever
/// name it carries; nothing reaches the tree and no private temporary stays.
#[tokio::test]
async fn hls_playlists_are_refused_on_lore_file_and_recording_uploads() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;
    let before = temporary_files();
    let mut padded = vec![b'\n'; 5000];
    padded.extend_from_slice(b"#EXTM3U\nhttps://media.example.invalid/seg0.ts\n");
    for (i, playlist) in [b"#EXTM3U\nhttps://media.example.invalid/seg0.ts\n".to_vec(), padded].into_iter().enumerate() {
        let body = counted_body(playlist.clone(), Arc::new(AtomicUsize::new(0)), false);
        let uri = file_uri(f.asset_channel, &format!("docs/clip{i}.mp4"));
        let (status, response) = send(&f.app, upload_request(Method::PUT, &uri, &f.member_token, body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
        assert!(response.to_string().contains("#EXTM3U"), "{response}");
        assert!(!f.asset_tree.join(format!("docs/clip{i}.mp4")).exists());

        let body = counted_body(playlist, Arc::new(AtomicUsize::new(0)), false);
        let (status, response) = send(
            &f.app,
            upload_request(Method::POST, &format!("/addons/lore/recordings?filename=call{i}.webm"), &f.member_token, body),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
        assert!(!f.recordings_tree.join(format!("recordings/call{i}.webm")).exists());
    }
    // A text note that merely starts with a longer tag is not a playlist.
    let body = counted_body(b"#EXTM3U8 notes".to_vec(), Arc::new(AtomicUsize::new(0)), false);
    let (status, response) =
        send(&f.app, upload_request(Method::PUT, &file_uri(f.asset_channel, "docs/notes.txt"), &f.member_token, body)).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(temporary_files(), before, "refused uploads left private temporaries behind");
}
