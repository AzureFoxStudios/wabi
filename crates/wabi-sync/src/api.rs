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

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
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

#[derive(Debug)]
pub enum UploadOutcome {
    Ok { etag: String, revision: String, pending_review: bool },
    Conflict(Conflict),
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
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            if body["type"] == "ReadOnlyToken" {
                Err(anyhow!("this connect token is read-only — mint one with write scope in the channel's connect panel"))
            } else {
                Err(anyhow!("forbidden (403) — check channel membership and role"))
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
        let resp = self.check_status(resp).await?;
        let body: serde_json::Value = resp.json().await.context("upload body")?;
        Ok(UploadOutcome::Ok {
            etag: body["etag"].as_str().unwrap_or_default().to_string(),
            revision: body["revision"]["hash"].as_str().unwrap_or_default().to_string(),
            pending_review: body["pendingReview"].as_bool().unwrap_or(false),
        })
    }

    pub async fn delete(&self, channel_id: i64, path: &str, if_match: Option<&str>) -> anyhow::Result<bool> {
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
            return Ok(false);
        }
        self.check_status(resp).await?;
        Ok(true)
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
