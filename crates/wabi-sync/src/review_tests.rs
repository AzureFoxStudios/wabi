//! End-to-end tests of the sync engine against a small in-process HTTP server
//! that answers the five routes the client calls. The server models the one
//! Lore behaviour these tests are about: an upload can be routed to a review
//! branch (`pendingReview: true`) and then is not on the mainline until
//! approved.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::api::WabiClient;
use crate::config::{LinkConfig, SyncState};
use crate::etag::etag_for_bytes;
use crate::sync::{SyncEngine, SyncReport};

#[derive(Default)]
struct Fake {
    mainline: BTreeMap<String, Vec<u8>>,
    review: BTreeMap<String, Vec<u8>>,
    route_to_review: bool,
    delete_forbidden: bool,
    puts: Vec<String>,
    deletes: Vec<String>,
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
        let files: Vec<_> = f
            .mainline
            .iter()
            .map(|(p, b)| serde_json::json!({"path": p, "size": b.len(), "etag": etag_for_bytes(b)}))
            .collect();
        return json(200, serde_json::json!({"channel_id": 1, "files": files, "head_revision": "h", "read_only": false}));
    }
    if method == "GET" && rest == "changes" {
        return json(200, serde_json::json!({"latest_seq": 0, "changes": []}));
    }
    let Some(file) = rest.strip_prefix("files/").map(percent_decode) else {
        return json(404, serde_json::json!({"error": "no route"}));
    };
    let current = f.mainline.get(&file).map(|b| etag_for_bytes(b));
    let stale = serde_json::json!({"type": "StaleEtag", "currentEtag": current});
    match method {
        "GET" => match f.mainline.get(&file) {
            Some(bytes) => (200, bytes.clone()),
            None => json(404, serde_json::json!({"error": "not found"})),
        },
        "PUT" => {
            if !precondition_ok(if_match, current.clone()) {
                return json(409, stale);
            }
            f.puts.push(file.clone());
            let etag = etag_for_bytes(&body);
            let pending = f.route_to_review;
            if pending {
                f.review.insert(file, body);
            } else {
                f.mainline.insert(file, body);
            }
            json(200, serde_json::json!({
                "etag": etag,
                "revision": {"hash": "r"},
                "pendingReview": pending,
                "reviewBranch": if pending { Some("uploads/test") } else { None },
            }))
        }
        "DELETE" => {
            if f.delete_forbidden {
                return json(403, serde_json::json!({"error": "forbidden", "type": "Forbidden"}));
            }
            if !precondition_ok(if_match, current) {
                return json(409, stale);
            }
            f.deletes.push(file.clone());
            f.mainline.remove(&file);
            json(200, serde_json::json!({"ok": true}))
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

struct Harness {
    fake: Shared,
    client: WabiClient,
    link: LinkConfig,
    dir: tempfile::TempDir,
}

impl Harness {
    async fn start() -> Self {
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

    fn folder(&self) -> &Path {
        self.dir.path()
    }

    /// One `wabi-sync sync` round: a fresh engine, so state goes through disk.
    async fn sync(&self) -> anyhow::Result<SyncReport> {
        SyncEngine::new(&self.client, self.folder(), &self.link).sync().await
    }

    fn server<R>(&self, f: impl FnOnce(&mut Fake) -> R) -> R {
        f(&mut self.fake.lock().unwrap())
    }

    fn write(&self, rel: &str, content: &str) {
        std::fs::write(self.folder().join(rel), content).unwrap();
    }

    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.folder().join(rel)).ok()
    }

    fn state(&self) -> SyncState {
        SyncState::load(self.folder()).unwrap()
    }

    fn conflict_copies(&self) -> Vec<String> {
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

    h.sync().await.unwrap();
    assert_eq!(h.read("new.txt").as_deref(), Some("my new work"));

    h.sync().await.unwrap();
    assert_eq!(h.read("new.txt").as_deref(), Some("my new work"));
    assert_eq!(h.server(|f| f.puts.clone()), vec!["new.txt"], "uploaded once only");
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

    h.sync().await.unwrap();
    assert_eq!(h.read("a.txt").as_deref(), Some("my edit"));
    assert_eq!(h.server(|f| f.puts.clone()), vec!["a.txt"], "uploaded once only");
    assert!(h.conflict_copies().is_empty());
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
    assert!(result.is_ok(), "sync aborted: {:?}", result.err());
    assert_eq!(h.read("b.txt").as_deref(), Some("from server"), "pull still ran");
    assert_eq!(h.state().baselines.get("a.txt").cloned(), baseline, "baseline untouched");
    assert!(h.server(|f| f.mainline.contains_key("a.txt")));
}
