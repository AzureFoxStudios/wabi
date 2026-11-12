//! Range downloads must read the requested bytes from the confined handle:
//! no private copy of the whole file per request, and the full SHA-256 ETag
//! computed once per revision rather than per request. Real API router and
//! real WabiDB; the Lore CLI is a shell stand-in (not the real `lore` binary).
#![cfg(all(feature = "wabi-lore", unix))]

use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    body::{to_bytes, Body},
    http::{Request, Response, StatusCode},
};
use sha2::Digest;
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

const MIB: usize = 1024 * 1024;

/// One private TMPDIR for this binary so a per-request private copy (a
/// `NamedTempFile`) is visible as a file in it. Tests are serialized.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static TMPDIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn private_tmpdir() -> &'static Path {
    TMPDIR.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("wabi-lore-range-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("TMPDIR", &dir);
        dir
    })
}

/// (file count, total bytes) of plain files directly in the private TMPDIR.
fn temp_usage() -> (usize, u64) {
    std::fs::read_dir(private_tmpdir())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .fold((0, 0), |(n, b), m| (n + 1, b + m.len()))
}

fn jwt(state: &AppState, uid: u64) -> String {
    let now = chrono::Utc::now().timestamp();
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &JwtClaims {
            sub: uid.to_string(),
            username: "artist".into(),
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

struct Fixture {
    _dir: tempfile::TempDir,
    app: axum::Router,
    lore: Arc<wabi_lore::LoreService>,
    tree: PathBuf,
    channel: i64,
    token: String,
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path();
    let config = ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        data_dir: path.to_string_lossy().into_owned(),
        uploads_dir: path.join("uploads").to_string_lossy().into_owned(),
        jwt_secret: "lore-range-download-test-only".into(),
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
    };
    let state = Arc::new(AppState::new(config).await.unwrap());
    let owner = state.wdb.create_user("owner", None, "h").await.unwrap();
    state.wdb.claim_owner(owner).await.unwrap();
    *state.owner_user_id.write().await = Some(owner as i64);
    let artist = state.wdb.create_user("artist", None, "h").await.unwrap();
    state
        .wdb
        .ingest_event(
            "rbac",
            "assign_role",
            &serde_json::json!({"userId": artist, "workspaceId": "default-workspace",
                "role": "Artist", "assignedBy": owner}),
        )
        .await
        .unwrap();
    let assets = state
        .wdb
        .create_channel("assets", ChannelKind::Lore, owner, false)
        .await
        .unwrap();
    for uid in [owner, artist] {
        state.wdb.add_channel_member(&assets, uid, MemberRole::Member).await.unwrap();
    }
    // Shell stand-in for the lore binary: every commit gets a fresh signature.
    let counter = path.join("commit-counter");
    let binary = path.join("lore-fixture");
    std::fs::write(
        &binary,
        format!(
            "#!/bin/sh\n\
             if [ \"$1\" = \"--offline\" ] && [ \"$2\" = \"--local\" ]; then shift 2; fi\n\
             case \"$1\" in\n\
               commit) n=$(( $(cat '{c}' 2>/dev/null || echo 0) + 1 )); echo $n > '{c}'\n\
                 printf 'Revision  : %s\\nSignature : %032d\\nBranch    : main\\nDate      : Mon, 07 Sep 2026 00:00:00 +0000\\n    fixture\\nCommit succeeded\\n' $n $n ;;\n\
               branch) [ \"$2\" = list ] && echo '* main' ; exit 0 ;;\n\
               *) exit 0 ;;\n\
             esac\n",
            c = counter.display(),
        ),
    )
    .unwrap();
    std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
    let lore = Arc::new(wabi_lore::LoreService::new(wabi_lore::LoreConfig {
        enabled: true,
        lore_binary_path: binary,
        lore_data_dir: path.join("lore"),
        default_blob_max_size_mb: 1,
        ..Default::default()
    }));
    let channel = i64::from_str_radix(assets.strip_prefix("ch_").unwrap(), 16).unwrap();
    lore.create_repo(channel, owner as i64, "assets").await.unwrap();
    let tree = lore.repo_working_tree(channel).await.unwrap();
    state.set_lore_service(lore.clone()).await;
    let app = create_api_router(state.clone()).with_state(state.clone());
    Fixture { token: jwt(&state, artist), _dir: dir, app, lore, tree, channel }
}

async fn get(f: &Fixture, query: &str, range: Option<&str>, inm: Option<&str>) -> Response<Body> {
    let mut req = Request::builder()
        .uri(format!("/addons/lore/repos/{}/files/big.bin{query}", f.channel))
        .header("authorization", format!("Bearer {}", f.token));
    if let Some(range) = range {
        req = req.header("range", range);
    }
    if let Some(inm) = inm {
        req = req.header("if-none-match", inm);
    }
    f.app.clone().oneshot(req.body(Body::empty()).unwrap()).await.unwrap()
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(sha2::Sha256::digest(bytes))
}

/// `len` bytes of a repeating pattern; `shift` makes two patterns differ.
/// Plain test content, nothing cryptographic.
fn pattern(len: usize, shift: u8) -> Vec<u8> {
    (0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(shift)).collect()
}

/// A Range request for 1 KiB of a 50 MiB file answers 206 with exactly those
/// bytes and the full SHA-256 ETag, while no private copy exists. The response
/// body is held unread: a snapshot copy lives until its body is dropped.
#[tokio::test]
async fn range_request_for_1kib_of_a_50mib_file_makes_no_temp_copy() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;
    let content = pattern(50 * MIB, 7);
    std::fs::write(f.tree.join("big.bin"), &content).unwrap();
    let before = temp_usage();

    let start = 20 * MIB;
    let response = get(&f, "", Some(&format!("bytes={start}-{}", start + 1023)), None).await;
    let after = temp_usage();

    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        response.headers()["content-range"],
        format!("bytes {start}-{}/{}", start + 1023, 50 * MIB)
    );
    assert_eq!(response.headers()["content-length"], "1024");
    assert_eq!(response.headers()["etag"], format!("\"{}\"", sha256(&content)));
    assert_eq!(after, before, "a Range request must not create a temp copy of the file");
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    assert_eq!(body.as_ref(), &content[start..start + 1024]);
    assert_eq!(temp_usage(), before);
}

/// The ETag of one revision is identical across requests and is hashed once.
#[tokio::test]
async fn download_etag_is_stable_and_not_recomputed_for_the_same_content() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;
    let content = pattern(6 * MIB, 3);
    std::fs::write(f.tree.join("big.bin"), &content).unwrap();
    let expected = format!("\"{}\"", sha256(&content));

    let before = f.lore.download_etag_hash_count();
    for i in 0..3 {
        let range = format!("bytes={}-{}", i * 100, i * 100 + 9);
        let response = get(&f, "", Some(&range), None).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()["etag"], expected);
    }
    assert_eq!(f.lore.download_etag_hash_count() - before, 1, "hashed more than once");

    // A matching If-None-Match is a 304 without another hash.
    let response = get(&f, "", Some("bytes=0-9"), Some(&expected)).await;
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(f.lore.download_etag_hash_count() - before, 1);

    // Replacing the file changes the ETag; the stale cached value is not served.
    let replaced = pattern(6 * MIB, 4);
    std::fs::write(f.tree.join("big.bin.new"), &replaced).unwrap();
    std::fs::rename(f.tree.join("big.bin.new"), f.tree.join("big.bin")).unwrap();
    let response = get(&f, "", Some("bytes=0-9"), None).await;
    assert_eq!(response.headers()["etag"], format!("\"{}\"", sha256(&replaced)));
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    let body = to_bytes(response.into_body(), 64).await.unwrap();
    assert_eq!(body.as_ref(), &replaced[..10]);
}

/// Range semantics that existed before still hold: open-ended ranges, an
/// unsatisfiable range falls back to the whole file (200) like before.
#[tokio::test]
async fn range_forms_keep_their_previous_answers() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;
    let content = pattern(5000, 9);
    std::fs::write(f.tree.join("big.bin"), &content).unwrap();

    let response = get(&f, "", Some("bytes=4990-"), None).await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()["content-range"], "bytes 4990-4999/5000");
    assert_eq!(to_bytes(response.into_body(), 64).await.unwrap().as_ref(), &content[4990..]);

    let response = get(&f, "", Some("bytes=999999-"), None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(to_bytes(response.into_body(), 8192).await.unwrap().as_ref(), &content[..]);

    let response = get(&f, "", None, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["etag"], format!("\"{}\"", sha256(&content)));
}

/// A Range read pinned with `?revision=` comes from the revision cache, makes
/// no copy, and carries the ETag of that revision (not of the head).
#[tokio::test]
async fn pinned_revision_range_reads_the_cached_revision_without_a_copy() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;
    let src = f._dir.path().join("src.bin");
    let v1 = pattern(300_000, 1);
    let v2 = pattern(300_000, 2);
    std::fs::write(&src, &v1).unwrap();
    let rev1 = f.lore.upload_file(f.channel, src.to_str().unwrap(), "big.bin", "v1", 1).await.unwrap();
    std::fs::write(&src, &v2).unwrap();
    f.lore.upload_file(f.channel, src.to_str().unwrap(), "big.bin", "v2", 1).await.unwrap();
    let before = temp_usage();

    let uri = format!("?revision={}", rev1.revision.hash);
    let response = get(&f, &uri, Some("bytes=1000-1999"), None).await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.headers()["etag"], format!("\"{}\"", sha256(&v1)));
    assert_eq!(temp_usage(), before);
    assert_eq!(to_bytes(response.into_body(), 4096).await.unwrap().as_ref(), &v1[1000..2000]);

    let head = get(&f, "", Some("bytes=0-9"), None).await;
    assert_eq!(head.headers()["etag"], format!("\"{}\"", sha256(&v2)));
}

use futures::StreamExt;

/// Mtime bumped well past what the open handle was stamped with, so the test
/// does not depend on clock granularity.
fn bump_mtime(path: &Path) {
    let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
}

/// A writer that edits the file IN PLACE (same inode, same length, new mtime)
/// while a Range response is being read must not get its new bytes mixed into
/// that response: the body ends in an error instead. The unverified `lore`
/// program may behave like this; Wabi's own writers do not.
#[tokio::test]
async fn in_place_rewrite_mid_response_ends_the_body_in_an_error() {
    use std::io::{Seek, Write};
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;
    let old = pattern(2 * MIB, 11);
    std::fs::write(f.tree.join("big.bin"), &old).unwrap();

    let response = get(&f, "", Some(&format!("bytes=0-{}", MIB - 1)), None).await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    let mut body = response.into_body().into_data_stream();
    let first = body.next().await.expect("first chunk").expect("first chunk is intact");
    assert_eq!(first.as_ref(), &old[..first.len()]);
    let mut seen = first.len();

    // Overwrite the whole file in place: same inode, same length.
    let new = pattern(2 * MIB, 99);
    let mut handle = std::fs::OpenOptions::new().write(true).open(f.tree.join("big.bin")).unwrap();
    handle.seek(std::io::SeekFrom::Start(0)).unwrap();
    handle.write_all(&new).unwrap();
    handle.sync_all().unwrap();
    drop(handle);
    bump_mtime(&f.tree.join("big.bin"));

    let mut failed = false;
    while let Some(chunk) = body.next().await {
        match chunk {
            Ok(bytes) => {
                assert_eq!(
                    bytes.as_ref(),
                    &old[seen..seen + bytes.len()],
                    "bytes from the new content reached the client after the change"
                );
                seen += bytes.len();
            }
            Err(_) => {
                failed = true;
                break;
            }
        }
    }
    assert!(failed, "the body must end in an error, not complete");
    assert!(seen < MIB, "the response must not have completed");
}

/// A file REPLACED by rename mid-response leaves the old inode untouched, so
/// the response completes with the old bytes.
#[tokio::test]
async fn rename_replacement_mid_response_completes_with_the_old_bytes() {
    let _serial = SERIAL.lock().await;
    private_tmpdir();
    let f = fixture().await;
    let old = pattern(2 * MIB, 21);
    std::fs::write(f.tree.join("big.bin"), &old).unwrap();

    let response = get(&f, "", Some(&format!("bytes=0-{}", MIB - 1)), None).await;
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    let mut body = response.into_body().into_data_stream();
    let first = body.next().await.unwrap().unwrap();

    std::fs::write(f.tree.join("big.bin.new"), pattern(2 * MIB, 77)).unwrap();
    std::fs::rename(f.tree.join("big.bin.new"), f.tree.join("big.bin")).unwrap();

    let mut got = first.to_vec();
    while let Some(chunk) = body.next().await {
        got.extend_from_slice(&chunk.expect("a rename must not break the response"));
    }
    assert_eq!(got, &old[..MIB]);
}
