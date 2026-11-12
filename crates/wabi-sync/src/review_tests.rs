//! End-to-end tests of the sync engine against a small in-process HTTP server
//! that answers the five routes the client calls. The server models the one
//! Lore behaviour these tests are about: an upload can be routed to a review
//! branch (`pendingReview: true`) and then is not on the mainline until
//! approved.
//!
//! The bodies below are written to match the real handlers in
//! `core/crates/wabi-server/src/api/lore.rs` key for key. This file is a
//! second copy of that format and cannot notice when the handlers change;
//! `core/crates/wabi-server/tests/wabi_sync_contract.rs` runs this client
//! against the real router and is the test that can.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::api::WabiClient;
use crate::config::{LinkConfig, SyncState};
use crate::etag::{etag_for_bytes, ETAG_FULL_HASH_MAX_BYTES};
use crate::sync::{SyncEngine, SyncReport};

#[derive(Default)]
pub(crate) struct Fake {
    pub(crate) mainline: BTreeMap<String, Vec<u8>>,
    pub(crate) review: BTreeMap<String, Vec<u8>>,
    pub(crate) route_to_review: bool,
    pub(crate) delete_forbidden: bool,
    pub(crate) puts: Vec<String>,
    pub(crate) deletes: Vec<String>,
    /// Stands in for the server-side mtime of each mainline file: bumped on
    /// every write, and part of the etag of a file over the full-hash limit.
    stamps: BTreeMap<String, u64>,
    clock: u64,
}

/// The etag the real server would report. Up to the full-hash limit it is the
/// content hash, the same value the client computes. Above it the real server
/// samples its own copy and mixes in that copy's mtime, so the value is never
/// one the client can compute; the fake returns an opaque `q-` string that
/// changes with every server-side write.
fn server_etag(bytes: &[u8], stamp: u64) -> String {
    if bytes.len() as u64 <= ETAG_FULL_HASH_MAX_BYTES {
        etag_for_bytes(bytes)
    } else {
        format!("q-server-{}-{stamp}", bytes.len())
    }
}

impl Fake {
    fn mainline_etag(&self, path: &str) -> Option<String> {
        let bytes = self.mainline.get(path)?;
        Some(server_etag(bytes, self.stamps.get(path).copied().unwrap_or(0)))
    }

    /// Write a mainline file the way another client's upload (or an approved
    /// review) would: new bytes and a new server-side mtime.
    pub(crate) fn set_mainline(&mut self, path: &str, bytes: Vec<u8>) {
        self.clock += 1;
        self.stamps.insert(path.to_string(), self.clock);
        self.mainline.insert(path.to_string(), bytes);
    }
}

type Shared = Arc<Mutex<Fake>>;

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// Same rules as the server's `check_if_match`, against the mainline.
fn precondition_ok(if_match: Option<&str>, current: Option<String>) -> bool {
    match if_match.map(|v| v.trim().trim_matches('"')) {
        None => true,
        Some("") => current.is_none(),
        Some(expected) => current.as_deref() == Some(expected),
    }
}

fn respond(fake: &Shared, method: &str, target: &str, if_match: Option<&str>, body: Vec<u8>) -> (u16, Vec<u8>) {
    let json = |status: u16, v: serde_json::Value| (status, v.to_string().into_bytes());
    let mut f = fake.lock().unwrap();
    let path_only = target.split('?').next().unwrap_or("");
    let rest = path_only.strip_prefix("/api/addons/lore/repos/1/").unwrap_or("");
    if method == "GET" && rest == "manifest" {
        // `repo_manifest`: camelCase keys; each file is a `LoreFileInfo`.
        let files: Vec<_> = f
            .mainline
            .iter()
            .map(|(p, b)| serde_json::json!({"path": p, "size": b.len(), "status": "clean", "etag": f.mainline_etag(p)}))
            .collect();
        return json(200, serde_json::json!({"channelId": 1, "files": files, "headRevision": "h", "readOnly": false}));
    }
    if method == "GET" && rest == "changes" {
        // `repo_changes` with an empty feed: `latestSeq` echoes `since`.
        return json(200, serde_json::json!({"channelId": 1, "since": 0, "latestSeq": 0, "changes": []}));
    }
    let Some(file) = rest.strip_prefix("files/").map(percent_decode) else {
        return json(404, serde_json::json!({"error": "no route", "type": "NotFound"}));
    };
    let current = f.mainline_etag(&file);
    // `conflict_response`.
    let stale = serde_json::json!({
        "error": "file changed on the server since your last read; re-fetch and reapply",
        "type": "StaleEtag",
        "currentEtag": current,
    });
    match method {
        "GET" => match f.mainline.get(&file) {
            Some(bytes) => (200, bytes.clone()),
            None => json(404, serde_json::json!({"error": "File not found", "type": "NotFound"})),
        },
        "PUT" => {
            if !precondition_ok(if_match, current.clone()) {
                return json(409, stale);
            }
            f.puts.push(file.clone());
            f.clock += 1;
            // `upload_file`: the top-level `etag` is the SHA-256 of the body,
            // whatever its size. `file` describes the stored copy (on the
            // review branch when the upload went there), and its etag is the
            // one the manifest lists and If-Match is checked against.
            let body_etag = etag_for_bytes(&body);
            let stored_etag = server_etag(&body, f.clock);
            let size = body.len();
            let pending = f.route_to_review;
            if pending {
                f.review.insert(file.clone(), body);
            } else {
                let stamp = f.clock;
                f.stamps.insert(file.clone(), stamp);
                f.mainline.insert(file.clone(), body);
            }
            json(200, serde_json::json!({
                "revision": {
                    "hash": "r",
                    "revision_number": 1,
                    "message": "fixture",
                    "author": null,
                    "timestamp": "",
                    "parent": null,
                },
                "file": {"path": file, "size": size, "status": "added", "etag": stored_etag},
                "etag": body_etag,
                "pendingReview": pending,
                "reviewBranch": if pending { Some("uploads/test") } else { None },
                "wdbRecorded": true,
                "cursor": 0,
            }))
        }
        "DELETE" => {
            if f.delete_forbidden {
                return json(403, serde_json::json!({
                    "error": "Lore asset deletion requires at least Artist role",
                    "type": "Forbidden",
                }));
            }
            if !precondition_ok(if_match, current) {
                return json(409, stale);
            }
            f.deletes.push(file.clone());
            f.mainline.remove(&file);
            json(200, serde_json::json!({"status": "ok", "cursor": 0}))
        }
        _ => json(405, serde_json::json!({"error": "method"})),
    }
}

async fn serve_one(mut sock: tokio::net::TcpStream, fake: Shared) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        let mut chunk = [0u8; 4096];
        let n = sock.read(&mut chunk).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or("").split(' ');
    let method = request_line.next().unwrap_or("").to_string();
    let target = request_line.next().unwrap_or("").to_string();
    let mut content_length = 0usize;
    let mut if_match = None;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            match name.to_ascii_lowercase().as_str() {
                "content-length" => content_length = value.trim().parse().unwrap_or(0),
                "if-match" => if_match = Some(value.trim().to_string()),
                _ => {}
            }
        }
    }
    let mut body = buf[head_end..].to_vec();
    while body.len() < content_length {
        let mut chunk = [0u8; 4096];
        let n = sock.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let (status, payload) = respond(&fake, &method, &target, if_match.as_deref(), body);
    let head = format!(
        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        payload.len()
    );
    sock.write_all(head.as_bytes()).await?;
    sock.write_all(&payload).await?;
    sock.shutdown().await
}

pub(crate) struct Harness {
    fake: Shared,
    pub(crate) client: WabiClient,
    pub(crate) link: LinkConfig,
    dir: tempfile::TempDir,
}

impl Harness {
    pub(crate) async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let fake: Shared = Arc::default();
        let accept_fake = fake.clone();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                tokio::spawn(serve_one(sock, accept_fake.clone()));
            }
        });
        Self {
            fake,
            client: WabiClient::new(&url, "test-token"),
            link: LinkConfig { server_url: url, channel_id: 1 },
            dir: tempfile::tempdir().unwrap(),
        }
    }

    pub(crate) fn folder(&self) -> &Path {
        self.dir.path()
    }

    /// One `wabi-sync sync` round: a fresh engine, so state goes through disk.
    pub(crate) async fn sync(&self) -> anyhow::Result<SyncReport> {
        SyncEngine::new(&self.client, self.folder(), &self.link).sync().await
    }

    pub(crate) fn server<R>(&self, f: impl FnOnce(&mut Fake) -> R) -> R {
        f(&mut self.fake.lock().unwrap())
    }

    fn write(&self, rel: &str, content: &str) {
        std::fs::write(self.folder().join(rel), content).unwrap();
    }

    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.folder().join(rel)).ok()
    }

    pub(crate) fn state(&self) -> SyncState {
        SyncState::load(self.folder()).unwrap()
    }

    pub(crate) fn conflict_copies(&self) -> Vec<String> {
        std::fs::read_dir(self.folder())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".wabi-conflict-"))
            .collect()
    }

    /// A linked folder holding `a.txt` = "old", in sync with the mainline.
    async fn with_synced_file() -> Self {
        let h = Self::start().await;
        h.server(|f| f.mainline.insert("a.txt".into(), b"old".to_vec()));
        h.sync().await.unwrap();
        assert_eq!(h.read("a.txt").as_deref(), Some("old"));
        h
    }
}

// -- Reproductions ---------------------------------------------------------

/// Case 2: a new file uploaded to a review branch is absent from the mainline
/// manifest; the pull half of the same sync must not delete it.
#[tokio::test]
async fn new_file_sent_to_review_is_not_deleted_locally() {
    let h = Harness::start().await;
    h.server(|f| f.route_to_review = true);
    h.write("new.txt", "my new work");

    let first = h.sync().await.unwrap();
    assert_eq!(h.read("new.txt").as_deref(), Some("my new work"));
    assert_eq!(first.uploaded, vec!["new.txt"]);
    assert_eq!(first.waiting_review, vec!["new.txt"]);
    assert!(first.deleted_local.is_empty());

    let second = h.sync().await.unwrap();
    assert_eq!(h.read("new.txt").as_deref(), Some("my new work"));
    assert_eq!(h.server(|f| f.puts.clone()), vec!["new.txt"], "uploaded once only");
    assert!(second.uploaded.is_empty());
    assert_eq!(second.waiting_review, vec!["new.txt"]);
}

/// Case 3: an edit uploaded to a review branch must not be overwritten with
/// the old mainline bytes.
#[tokio::test]
async fn edit_sent_to_review_is_not_overwritten_from_mainline() {
    let h = Harness::with_synced_file().await;
    h.server(|f| f.route_to_review = true);
    h.write("a.txt", "my edit");

    h.sync().await.unwrap();
    assert_eq!(h.read("a.txt").as_deref(), Some("my edit"));

    let second = h.sync().await.unwrap();
    assert_eq!(h.read("a.txt").as_deref(), Some("my edit"));
    assert_eq!(h.server(|f| f.puts.clone()), vec!["a.txt"], "uploaded once only");
    assert!(h.conflict_copies().is_empty());
    assert!(second.downloaded.is_empty());
    assert_eq!(second.waiting_review, vec!["a.txt"]);
    // The baseline is still the mainline's, and the pending etag is on disk.
    let state = h.state();
    assert_eq!(state.baselines.get("a.txt"), Some(&Some(etag_for_bytes(b"old"))));
    assert_eq!(state.pending_review.get("a.txt"), Some(&etag_for_bytes(b"my edit")));
}

/// Case 4: a DELETE answered 403 must not abort the round; the pull still runs.
#[tokio::test]
async fn forbidden_delete_does_not_abort_the_sync() {
    let h = Harness::with_synced_file().await;
    let baseline = h.state().baselines.get("a.txt").cloned();
    std::fs::remove_file(h.folder().join("a.txt")).unwrap();
    h.server(|f| {
        f.delete_forbidden = true;
        f.mainline.insert("b.txt".into(), b"from server".to_vec());
    });

    let result = h.sync().await;
    assert!(result.is_ok(), "sync aborted: {:?}", result.as_ref().err());
    let report = result.unwrap();
    assert_eq!(report.not_deleted, vec!["a.txt"]);
    assert!(report.deleted_remote.is_empty());
    assert!(!h.folder().join("a.txt").exists(), "the pull does not bring it back");
    assert_eq!(h.read("b.txt").as_deref(), Some("from server"), "pull still ran");
    assert_eq!(h.state().baselines.get("a.txt").cloned(), baseline, "baseline untouched");
    assert!(h.server(|f| f.mainline.contains_key("a.txt")));
}

/// 409 on DELETE keeps its existing meaning (a conflict, not a permission note).
#[tokio::test]
async fn stale_delete_is_still_reported_as_a_conflict() {
    let h = Harness::with_synced_file().await;
    std::fs::remove_file(h.folder().join("a.txt")).unwrap();
    h.server(|f| f.mainline.insert("a.txt".into(), b"changed on server".to_vec()));

    let mut engine = SyncEngine::new(&h.client, h.folder(), &h.link);
    let report = engine.push().await.unwrap();
    assert_eq!(report.conflicts.len(), 1);
    assert!(report.not_deleted.is_empty());
    assert!(h.server(|f| f.deletes.is_empty()));
}

// -- Behaviour of a pending path ---------------------------------------------

/// A linked folder whose edit of `a.txt` ("old" → "my edit") is waiting for review.
async fn with_pending_edit() -> Harness {
    let h = Harness::with_synced_file().await;
    h.server(|f| f.route_to_review = true);
    h.write("a.txt", "my edit");
    h.sync().await.unwrap();
    assert_eq!(h.state().pending_review.len(), 1);
    h
}

/// Approved later: the mainline gets the uploaded etag and the path is an
/// ordinary clean file again, without a second upload.
#[tokio::test]
async fn approved_upload_becomes_a_clean_file() {
    let h = with_pending_edit().await;
    h.server(|f| {
        let bytes = f.review.remove("a.txt").unwrap();
        f.mainline.insert("a.txt".into(), bytes);
    });

    let report = h.sync().await.unwrap();
    assert!(report.is_empty(), "nothing to report once approved");
    assert_eq!(h.read("a.txt").as_deref(), Some("my edit"));
    assert_eq!(h.server(|f| f.puts.len()), 1, "no re-upload");
    assert!(h.conflict_copies().is_empty());
    let state = h.state();
    assert!(state.pending_review.is_empty());
    assert_eq!(state.baselines.get("a.txt"), Some(&Some(etag_for_bytes(b"my edit"))));

    // Ordinary clean file: a later mainline change is simply downloaded.
    h.server(|f| f.mainline.insert("a.txt".into(), b"someone else".to_vec()));
    let report = h.sync().await.unwrap();
    assert_eq!(report.downloaded, vec!["a.txt"]);
    assert_eq!(h.read("a.txt").as_deref(), Some("someone else"));
    assert!(h.conflict_copies().is_empty());
}

/// A new file approved later is adopted the same way.
#[tokio::test]
async fn approved_new_file_becomes_a_clean_file() {
    let h = Harness::start().await;
    h.server(|f| f.route_to_review = true);
    h.write("new.txt", "my new work");
    h.sync().await.unwrap();
    h.server(|f| {
        let bytes = f.review.remove("new.txt").unwrap();
        f.mainline.insert("new.txt".into(), bytes);
    });

    let report = h.sync().await.unwrap();
    assert!(report.is_empty());
    assert_eq!(h.server(|f| f.puts.len()), 1);
    assert!(h.state().pending_review.is_empty());
    assert_eq!(h.state().baselines.get("new.txt"), Some(&Some(etag_for_bytes(b"my new work"))));
}

/// Edited again while pending: upload again, against the mainline baseline.
#[tokio::test]
async fn editing_a_pending_file_uploads_again() {
    let h = with_pending_edit().await;
    h.write("a.txt", "my second edit");

    let report = h.sync().await.unwrap();
    assert_eq!(report.uploaded, vec!["a.txt"]);
    assert_eq!(report.waiting_review, vec!["a.txt"]);
    assert!(report.conflicts.is_empty());
    assert_eq!(h.server(|f| f.puts.clone()), vec!["a.txt", "a.txt"]);
    assert_eq!(h.server(|f| f.review.get("a.txt").cloned()), Some(b"my second edit".to_vec()));
    assert_eq!(h.read("a.txt").as_deref(), Some("my second edit"));
    assert_eq!(h.state().pending_review.get("a.txt"), Some(&etag_for_bytes(b"my second edit")));
}

/// The mainline changed to something else while pending: a conflict, with the
/// local version kept as a conflict copy.
#[tokio::test]
async fn mainline_change_while_pending_is_a_conflict_copy() {
    let h = with_pending_edit().await;
    h.server(|f| f.mainline.insert("a.txt".into(), b"someone else".to_vec()));

    let report = h.sync().await.unwrap();
    assert_eq!(report.conflicts.len(), 1, "{:?}", report.conflicts);
    assert!(report.waiting_review.is_empty());
    assert_eq!(h.read("a.txt").as_deref(), Some("someone else"));
    let copies = h.conflict_copies();
    assert_eq!(copies.len(), 1);
    assert_eq!(h.read(&copies[0]).as_deref(), Some("my edit"), "local work survives");
    assert_eq!(h.server(|f| f.puts.len()), 1, "no silent re-upload over the mainline");
    assert!(h.state().pending_review.is_empty());
}

/// The mainline deleted the file while an edit was pending: also a conflict copy.
#[tokio::test]
async fn mainline_delete_while_pending_keeps_the_local_version() {
    let h = with_pending_edit().await;
    h.server(|f| f.mainline.remove("a.txt"));

    let report = h.sync().await.unwrap();
    assert_eq!(report.conflicts.len(), 1, "{:?}", report.conflicts);
    let copies = h.conflict_copies();
    assert_eq!(copies.len(), 1);
    assert_eq!(h.read(&copies[0]).as_deref(), Some("my edit"));
    assert!(h.state().pending_review.is_empty());
}

/// `wabi-sync status`: a file waiting for review is not "changed since last
/// sync" (it was sent), and status says that it is waiting.
#[tokio::test]
async fn status_says_a_file_is_waiting_for_review() {
    use crate::sync::{local_status, scan_local};
    let h = with_pending_edit().await;
    h.write("new.txt", "not sent yet");

    let status = local_status(&h.state(), &scan_local(h.folder()).unwrap());
    assert_eq!(status.waiting_review, vec!["a.txt"]);
    assert_eq!(status.changed, vec!["new.txt"]);

    // Edited again: what is waiting is no longer what is in the folder.
    h.write("a.txt", "my second edit");
    let status = local_status(&h.state(), &scan_local(h.folder()).unwrap());
    assert!(status.waiting_review.is_empty());
    assert_eq!(status.changed, vec!["a.txt", "new.txt"]);
}

/// A rejected review upload: nothing tells the client, so the file is
/// reported as waiting on every round until the user runs `resubmit`. The
/// next round then uploads the same bytes as a new review request.
#[tokio::test]
async fn resubmit_clears_the_waiting_mark_and_uploads_again() {
    let h = with_pending_edit().await;
    // The reviewer rejects: the review branch goes, the mainline is as it was.
    h.server(|f| f.review.clear());
    for _ in 0..2 {
        let report = h.sync().await.unwrap();
        assert_eq!(report.waiting_review, vec!["a.txt"]);
        assert!(report.uploaded.is_empty());
    }

    let mut state = h.state();
    assert!(!state.forget_review("never-sent.txt"));
    assert!(state.forget_review("a.txt"));
    assert!(!state.forget_review("a.txt"), "already forgotten");
    state.save(h.folder()).unwrap();

    let report = h.sync().await.unwrap();
    assert_eq!(report.uploaded, vec!["a.txt"]);
    assert_eq!(report.waiting_review, vec!["a.txt"], "it is a new review request");
    assert!(report.conflicts.is_empty());
    assert_eq!(h.server(|f| f.puts.clone()), vec!["a.txt", "a.txt"]);
    assert_eq!(h.server(|f| f.review.get("a.txt").cloned()), Some(b"my edit".to_vec()));
    assert_eq!(h.read("a.txt").as_deref(), Some("my edit"));
    assert!(h.conflict_copies().is_empty());
}
