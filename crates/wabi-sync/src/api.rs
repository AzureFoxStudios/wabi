//! Thin REST client for the Wabi lore sync endpoints.

use anyhow::{anyhow, Context};
use serde::Deserialize;

pub struct WabiClient {
    base: String,
    token: String,
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
pub struct ManifestFile {
    pub path: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub etag: Option<String>,
}

/// `GET /repos/{id}/manifest`. The server spells its keys in camelCase
/// (`channelId`, `headRevision`, `readOnly`) and has never sent another
/// spelling.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub channel_id: i64,
    pub files: Vec<ManifestFile>,
    #[serde(default)]
    pub head_revision: String,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Debug, Deserialize)]
pub struct ChangeEntry {
    pub seq: u64,
    pub path: String,
    pub action: String,
    #[serde(default)]
    pub etag: Option<String>,
}

/// `GET /repos/{id}/changes`: `latestSeq` is the seq of the last entry on
/// this page, or the `since` that was asked for when the page is empty.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub latest_seq: u64,
    pub changes: Vec<ChangeEntry>,
}

/// A PUT rejected by the server's If-Match check — carries the current
/// server etag so the caller can produce a conflict copy.
#[derive(Debug)]
pub struct Conflict {
    pub current_etag: Option<String>,
}

/// A PUT the server turned down for a reason that concerns this one file (or
/// this one user's right to write), not the whole round.
#[derive(Debug)]
pub struct Refusal {
    pub status: u16,
    /// The `error` text of the server's answer; may be empty.
    pub reason: String,
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let what = match self.status {
            403 if self.reason.contains("connect token is read-only") => {
                "this connect token is read-only; mint one with write scope in the channel's connect panel"
            }
            403 => "you do not have permission",
            400 => "the server does not accept this file",
            413 => "the file is too large for this server",
            _ => "the server could not store this file",
        };
        write!(f, "{what} ({}", self.status)?;
        // The server's own words, unless the line above already says them.
        if !self.reason.is_empty() && !what.contains(&self.reason) {
            write!(f, ": {}", self.reason)?;
        }
        write!(f, ")")
    }
}

#[derive(Debug)]
pub enum UploadOutcome {
    Ok { etag: String, revision: String, pending_review: bool },
    Conflict(Conflict),
    Refused(Refusal),
}

#[derive(Debug, PartialEq, Eq)]
pub enum DeleteOutcome {
    Deleted,
    /// 409: the file changed on the server after the caller's baseline.
    Conflict,
    /// 403: the caller may not delete on the mainline.
    Forbidden,
}

/// Minimal percent-encoding for query components (keep unreserved chars).
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

impl WabiClient {
    pub fn new(server_url: &str, token: &str) -> Self {
        let base = server_url.trim_end_matches('/').to_string();
        Self {
            base,
            token: token.to_string(),
            http: reqwest::Client::new(),
        }
    }

    /// The server this client talks to, without a trailing slash.
    pub fn server_url(&self) -> &str {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    async fn check_status(&self, resp: reqwest::Response) -> anyhow::Result<reqwest::Response> {
        let status = resp.status();
        if status.is_success() {
            Ok(resp)
        } else if status == reqwest::StatusCode::UNAUTHORIZED {
            Err(anyhow!("authentication failed (401) — token revoked or invalid; re-run `wabi-sync login`"))
        } else if status == reqwest::StatusCode::FORBIDDEN {
            // The server's 403 body is `{"error": <reason>, "type": "Forbidden"}`
            // for every refusal; only the reason tells a read-only token from
            // a missing role or membership.
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let reason = body["error"].as_str().unwrap_or_default();
            if reason.contains("connect token is read-only") {
                Err(anyhow!("this connect token is read-only — mint one with write scope in the channel's connect panel"))
            } else if reason.is_empty() {
                Err(anyhow!("forbidden (403) — check channel membership and role"))
            } else {
                Err(anyhow!("forbidden (403): {reason} — check channel membership and role"))
            }
        } else {
            let body = resp.text().await.unwrap_or_default();
            Err(anyhow!("request failed ({status}): {body}"))
        }
    }

    pub async fn manifest(&self, channel_id: i64) -> anyhow::Result<Manifest> {
        let resp = self
            .http
            .get(self.url(&format!(
                "/api/addons/lore/repos/{channel_id}/manifest"
            )))
            .bearer_auth(&self.token)
            .send()
            .await?;
        self.check_status(resp).await?.json().await.context("manifest")
    }

    pub async fn changes(&self, channel_id: i64, since: u64) -> anyhow::Result<Changes> {
        let resp = self
            .http
            .get(self.url(&format!(
                "/api/addons/lore/repos/{channel_id}/changes?since={since}"
            )))
            .bearer_auth(&self.token)
            .send()
            .await?;
        self.check_status(resp).await?.json().await.context("changes")
    }

    /// Where the change feed ends, starting from the stored cursor `since`.
    /// The server sends at most 1000 entries per page and `latestSeq` is the
    /// end of that page, so this asks again from each page's end until a page
    /// comes back empty.
    pub async fn feed_end(&self, channel_id: i64, since: u64) -> anyhow::Result<u64> {
        let mut cursor = since;
        loop {
            let page = self.changes(channel_id, cursor).await?;
            if page.changes.is_empty() || page.latest_seq <= cursor {
                return Ok(cursor);
            }
            cursor = page.latest_seq;
        }
    }

    /// Has anything been recorded in the change feed after `cursor`? One
    /// page answers that, however long the feed is.
    pub async fn remote_moved(&self, channel_id: i64, cursor: u64) -> anyhow::Result<bool> {
        Ok(!self.changes(channel_id, cursor).await?.changes.is_empty())
    }

    /// Download a file. `if_none_match` enables a cheap 304 round-trip.
    pub async fn download(
        &self,
        channel_id: i64,
        path: &str,
        if_none_match: Option<&str>,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let mut req = self
            .http
            .get(self.url(&format!(
                "/api/addons/lore/repos/{channel_id}/files/{}",
                enc(path)
            )))
            .bearer_auth(&self.token);
        if let Some(etag) = if_none_match {
            req = req.header(reqwest::header::IF_NONE_MATCH, format!("\"{etag}\""));
        }
        let resp = req.send().await?;
        let resp = self.check_status(resp).await?;
        if resp.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(None);
        }
        Ok(Some(resp.bytes().await.context("download body")?.to_vec()))
    }

    /// Upload with optimistic concurrency. `if_match`:
    /// - `None` → last-write-wins
    /// - `Some("")` → create-only (must not exist)
    /// - `Some(etag)` → must match the current head
    pub async fn upload(
        &self,
        channel_id: i64,
        path: &str,
        body: Vec<u8>,
        message: &str,
        if_match: Option<&str>,
    ) -> anyhow::Result<UploadOutcome> {
        let mut req = self
            .http
            .put(self.url(&format!(
                "/api/addons/lore/repos/{channel_id}/files/{}?message={}",
                enc(path),
                enc(message)
            )))
            .bearer_auth(&self.token)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(body);
        if let Some(etag) = if_match {
            req = req.header(
                reqwest::header::IF_MATCH,
                if etag.is_empty() { "\"\"".to_string() } else { format!("\"{etag}\"") },
            );
        }
        let resp = req.send().await?;
        if resp.status() == reqwest::StatusCode::CONFLICT {
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            return Ok(UploadOutcome::Conflict(Conflict {
                current_etag: body["currentEtag"].as_str().map(str::to_string),
            }));
        }
        // Answers that leave the rest of the round possible: 403 is a member
        // or a token that may read and not write, 400 a name the server does
        // not accept, 413 a file over its size limit, and 500 is what it
        // answers for a path its own `.wabiignore` excludes (it gives no
        // reason in the body). Everything else (401, 404, 501, a gateway
        // error) means the round cannot work and is an error. Someone with
        // no access at all gets their 403 from the manifest, and that one
        // still ends the round.
        if matches!(resp.status().as_u16(), 400 | 403 | 413 | 500) {
            let status = resp.status().as_u16();
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let reason = body["error"].as_str().unwrap_or_default().to_string();
            return Ok(UploadOutcome::Refused(Refusal { status, reason }));
        }
        let resp = self.check_status(resp).await?;
        let body: serde_json::Value = resp.json().await.context("upload body")?;
        // `file.etag` is the etag of the server's stored copy, the value the
        // manifest lists and If-Match is checked against. The top-level
        // `etag` is the SHA-256 of the uploaded body; the two differ for a
        // file over the full-hash limit, whose stored etag is sampled (`q-`).
        let etag = body["file"]["etag"].as_str().or_else(|| body["etag"].as_str());
        Ok(UploadOutcome::Ok {
            etag: etag.unwrap_or_default().to_string(),
            revision: body["revision"]["hash"].as_str().unwrap_or_default().to_string(),
            pending_review: body["pendingReview"].as_bool().unwrap_or(false),
        })
    }

    pub async fn delete(&self, channel_id: i64, path: &str, if_match: Option<&str>) -> anyhow::Result<DeleteOutcome> {
        let mut req = self
            .http
            .delete(self.url(&format!(
                "/api/addons/lore/repos/{channel_id}/files/{}",
                enc(path)
            )))
            .bearer_auth(&self.token)
            .json(&serde_json::json!({ "message": "Deleted via wabi-sync" }));
        if let Some(etag) = if_match {
            req = req.header(reqwest::header::IF_MATCH, format!("\"{etag}\""));
        }
        let resp = req.send().await?;
        if resp.status() == reqwest::StatusCode::CONFLICT {
            return Ok(DeleteOutcome::Conflict);
        }
        if resp.status() == reqwest::StatusCode::FORBIDDEN {
            return Ok(DeleteOutcome::Forbidden);
        }
        self.check_status(resp).await?;
        Ok(DeleteOutcome::Deleted)
    }

    pub async fn set_lock(&self, channel_id: i64, path: &str, lock: bool) -> anyhow::Result<()> {
        let (method, url) = if lock {
            ("POST", format!("/api/addons/lore/repos/{channel_id}/lock/{}", enc(path)))
        } else {
            ("DELETE", format!("/api/addons/lore/repos/{channel_id}/lock/{}", enc(path)))
        };
        let resp = self
            .http
            .request(reqwest::Method::from_bytes(method.as_bytes())?, self.url(&url))
            .bearer_auth(&self.token)
            .send()
            .await?;
        self.check_status(resp).await?;
        Ok(())
    }

    /// Best-effort reachability probe for `wabi-sync status`.
    pub async fn ping(&self) -> anyhow::Result<()> {
        let resp = self
            .http
            .get(self.url("/api/addons/lore/health"))
            .bearer_auth(&self.token)
            .send()
            .await?;
        self.check_status(resp).await?;
        Ok(())
    }
}
