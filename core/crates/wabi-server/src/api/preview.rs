//! URL preview (OG metadata fetch with YouTube oEmbed) and image proxy routes
//!
//! Implements:
//! - GET /api/url-preview?url=... - Fetch OpenGraph metadata, with special YouTube oEmbed support
//! - GET /api/image-proxy?url=... - Proxy images to avoid hotlink protection

use axum::{
    extract::{Query, State},
    Json,
};
use reqwest::{ClientBuilder, Url};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::state::AppState;

// ─────────────────────────────────────────────────────────────────────────────
// SSRF validation (shared by url-preview and image-proxy)
// ─────────────────────────────────────────────────────────────────────────────

const PREVIEW_MAX_BYTES: usize = 2 * 1024 * 1024; // 2 MB
const IMAGE_PROXY_MAX_BYTES: usize = 10 * 1024 * 1024; // 10 MB

pub(crate) struct OutboundTarget {
    pub(crate) url: Url,
    pub(crate) address: SocketAddr,
}

/// Validate the actual fetch destination and retain its approved address for
/// the connection. A second DNS lookup must not undo this SSRF decision.
pub(crate) async fn validate_outbound_url(raw_url: &str) -> Result<OutboundTarget> {
    let url = Url::parse(raw_url).map_err(|_| AppError::BadRequest("invalid URL".into()))?;

    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(AppError::BadRequest("URL must be http or https".into()));
    }

    let host = url
        .host_str()
        .ok_or_else(|| AppError::BadRequest("URL has no host".into()))?;

    let port = url.port_or_known_default().unwrap_or(80);
    let literal = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>();
    let address = if let Ok(ip) = literal {
        let ip = normalize_ip(ip);
        if !is_public_ip(ip) {
            return Err(AppError::BadRequest("address not allowed".into()));
        }
        SocketAddr::new(ip, port)
    } else {
        tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| AppError::BadRequest("DNS resolution failed".into()))?
            .map(|address| SocketAddr::new(normalize_ip(address.ip()), address.port()))
            .find(|address| is_public_ip(address.ip()))
            .ok_or_else(|| AppError::BadRequest("address not allowed".into()))?
    };

    Ok(OutboundTarget { url, address })
}

fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(ip)),
        ip => ip,
    }
}

fn is_public_ip(ip: IpAddr) -> bool {
    match normalize_ip(ip) {
        IpAddr::V4(ip) => is_public_ipv4(&ip),
        IpAddr::V6(ip) => is_public_ipv6(&ip),
    }
}

pub(crate) fn pinned_client(target: &OutboundTarget, timeout_ms: u64) -> Result<ClientBuilder> {
    let host = target
        .url
        .host_str()
        .ok_or_else(|| AppError::BadRequest("URL has no host".into()))?;
    Ok(reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        // Keep the URL hostname for Host/TLS verification, but connect only to
        // the approved address. An environment proxy could resolve it again.
        .resolve(host, target.address)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none()))
}

/// Bound on redirect hops: enough for real-site chains (www → canonical,
/// http → https, twitter.com → x.com) without allowing a loop or a long
/// relay tunnel. The transport itself never follows redirects; this loop
/// re-validates every hop before it is fetched.
const MAX_FETCH_REDIRECTS: usize = 5;

/// A Location header resolves against the URL that produced it (absolute and
/// relative forms are both common).
fn redirect_target(current: &Url, location: &str) -> Result<Url> {
    current
        .join(location.trim())
        .map_err(|_| AppError::BadRequest("invalid redirect location".into()))
}

/// Site HTML often uses root-relative asset URLs; resolve them against the
/// URL that was actually fetched (after redirects).
fn resolve_against(base: &Url, raw: &str) -> String {
    base.join(raw)
        .map(|url| url.to_string())
        .unwrap_or_else(|_| raw.to_string())
}

type ValidateFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<OutboundTarget>> + Send>>;

/// Production hop validator: the exact same SSRF rules as the first request —
/// scheme check, fresh DNS resolution, public-address-only, connection pin.
fn validate_hop(raw: String) -> ValidateFuture {
    Box::pin(async move { validate_outbound_url(&raw).await })
}

/// GET `target`, following up to [`MAX_FETCH_REDIRECTS`] redirects. Because
/// the pinned transport never follows them itself, each Location goes through
/// the full SSRF validation again — a redirect can never reach a private host,
/// and the final request stays pinned to its approved address. Returns the
/// final URL with the final (non-redirect) response.
async fn get_following_redirects(
    mut target: OutboundTarget,
    timeout_ms: u64,
    accept: &str,
    validate: impl Fn(String) -> ValidateFuture,
) -> Result<(Url, reqwest::Response)> {
    for _ in 0..=MAX_FETCH_REDIRECTS {
        let client = pinned_client(&target, timeout_ms)?.build()?;
        let response = client
            .get(target.url.clone())
            .header(
                "User-Agent",
                "Mozilla/5.0 (compatible; WabiBot/1.0; +https://wabi.chat)",
            )
            .header("Accept", accept)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Failed to fetch URL: {}", e))?;
        let location = match response.status() {
            reqwest::StatusCode::MOVED_PERMANENTLY
            | reqwest::StatusCode::FOUND
            | reqwest::StatusCode::SEE_OTHER
            | reqwest::StatusCode::TEMPORARY_REDIRECT
            | reqwest::StatusCode::PERMANENT_REDIRECT => response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned),
            _ => None,
        };
        let Some(location) = location else {
            return Ok((target.url, response));
        };
        let next = redirect_target(&target.url, &location)?;
        target = validate(next.to_string()).await?;
    }
    Err(anyhow::anyhow!("URL redirects too many times").into())
}

async fn read_capped_body(mut response: reqwest::Response, max_bytes: usize) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(AppError::BadRequest(
            "remote response exceeds size limit".into(),
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if chunk.len() > max_bytes.saturating_sub(body.len()) {
            return Err(AppError::BadRequest(
                "remote response exceeds size limit".into(),
            ));
        }
        // Check each chunk before reserving or copying; no declared length is
        // trusted to bound a chunked or otherwise oversized response.
        body.try_reserve_exact(chunk.len())
            .map_err(|_| AppError::Internal("response allocation failed".into()))?;
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn read_capped_text(response: reqwest::Response, max_bytes: usize) -> Result<String> {
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .cloned();
    let body = read_capped_body(response, max_bytes).await?;
    // Preserve reqwest's charset/BOM decoding using an already bounded in-memory
    // body. Its text decoder cannot read any more bytes from the remote server.
    let mut response = axum::http::Response::builder();
    if let Some(content_type) = content_type {
        response = response.header(reqwest::header::CONTENT_TYPE, content_type);
    }
    let response: reqwest::Response = response
        .body(body)
        .map_err(|_| AppError::Internal("response decoding failed".into()))?
        .into();
    Ok(response.text().await?)
}

fn is_public_ipv4(ip: &std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    if octets[0] == 0 || octets[0] == 10 || octets[0] == 127 || octets[0] >= 224 {
        return false;
    }
    if octets[0] == 169 && octets[1] == 254 {
        return false;
    }
    if octets[0] == 172 && (octets[1] & 0xf0) == 16 {
        return false;
    }
    if octets[0] == 192 && octets[1] == 168 {
        return false;
    }
    if octets[0] == 198 && (octets[1] & 0xfe) == 18 {
        return false;
    }
    if octets[0] == 100 && (octets[1] & 0xc0) == 64 {
        return false;
    }
    if octets[0] == 192 && octets[1] == 0 && octets[2] == 0 {
        return false;
    }
    true
}

fn is_public_ipv6(ip: &std::net::Ipv6Addr) -> bool {
    let o = ip.segments();
    if ip.is_unspecified() || ip.is_loopback() {
        return false;
    }
    if (o[0] & 0xfe00) == 0xfc00 {
        return false;
    } // ULA
    if (o[0] & 0xffc0) == 0xfe80 {
        return false;
    } // link-local
    if (o[0] & 0xffc0) == 0xfec0 {
        return false;
    } // deprecated site-local
    if (o[0] & 0xff00) == 0xff00 {
        return false;
    } // multicast
    true
}

// ---------------------------------------------------------------------------
// Image proxy
// ---------------------------------------------------------------------------

const PREVIEW_FETCH_TIMEOUT_MS: u64 = 8000;
const OEMBED_FETCH_TIMEOUT_MS: u64 = 3000;
const IMAGE_PROXY_TIMEOUT_MS: u64 = 10000;

/// URL preview query parameters
#[derive(Debug, Deserialize)]
pub struct UrlPreviewQuery {
    url: String,
}

/// Video metadata sub-object
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewVideo {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<String>,
}

/// URL preview response
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UrlPreviewResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub youtube_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video: Option<PreviewVideo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub twitter_card: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub twitter_player: Option<String>,
    /// What the link points at, so the client can draw the right card:
    /// post | video | repo | article | audio | link.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Person or account behind the link (post author, repo owner, channel).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published: Option<String>,
}

/// YouTube oEmbed response
#[derive(Debug, Deserialize)]
struct OembedResponse {
    title: Option<String>,
    author_name: Option<String>,
    author_url: Option<String>,
    html: Option<String>,
    #[allow(dead_code)]
    thumbnail_url: Option<String>,
}

/// Parse a YouTube video ID from a URL, returning None if the URL is not a YouTube link.
fn parse_youtube_id(raw_url: &str) -> Option<String> {
    let Ok(parsed) = reqwest::Url::parse(raw_url) else {
        return None;
    };
    let host = parsed.host_str()?.to_lowercase();
    let mut candidate: Option<String> = None;

    if host.contains("youtube.com") {
        candidate = parsed
            .query_pairs()
            .find(|(k, _)| k == "v")
            .map(|(_, v)| v.to_string());
        if candidate.is_none() {
            let segments: Vec<_> = parsed.path_segments()?.filter(|s| !s.is_empty()).collect();
            if segments.len() >= 2 {
                let seg0 = segments[0];
                if seg0 == "embed" || seg0 == "shorts" || seg0 == "live" {
                    candidate = Some(segments[1].to_string());
                }
            }
        }
    } else if host.contains("youtu.be") {
        candidate = Some(parsed.path().trim_start_matches('/').to_string());
    }

    let normalized = candidate?.trim().to_string();
    if normalized.is_empty() || normalized.len() < 6 || normalized.len() > 20 {
        return None;
    }
    if !normalized
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some(normalized)
}

/// Decode basic HTML entities in OG meta tag content values
fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

/// Extract a meta tag content value using a simple regex approach (mirrors the TS logic)
fn get_meta(html: &str, property: &str) -> Option<String> {
    let pattern = format!(
        r#"<meta[^>]+(?:property|name)=["']{}["'][^>]+content=["']([^"']*)["']"#,
        regex::escape(property)
    );
    let re = regex::Regex::new(&pattern).ok()?;
    if let Some(m) = re.captures(html) {
        return Some(decode_html_entities(&m[1]));
    }
    // Try reversed attribute order
    let pattern2 = format!(
        r#"<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']{}["']"#,
        regex::escape(property)
    );
    let re2 = regex::Regex::new(&pattern2).ok()?;
    if let Some(m) = re2.captures(html) {
        return Some(decode_html_entities(&m[1]));
    }
    None
}

pub async fn url_preview(
    State(_state): State<Arc<AppState>>,
    _auth: AuthUser,
    Query(query): Query<UrlPreviewQuery>,
) -> Result<Json<UrlPreviewResponse>> {
    let target = validate_outbound_url(&query.url).await?;

    if parse_youtube_id(&query.url).is_some() {
        return fetch_youtube_preview(&query.url).await;
    }

    // General OG metadata fetch. Redirects (twitter.com → x.com, http →
    // https, www → canonical) are followed with a fresh SSRF validation on
    // every hop. The HTTP status is deliberately not a gate: X answers a
    // deleted post with a 404 page that still carries honest Open Graph
    // tags, so a card reading "Post Not Found" is more truthful than a
    // failed preview. Only a non-HTML body has nothing to extract, and
    // that is an empty preview (the client falls back to the bare link).
    let og = fetch_open_graph(target).await;

    // X often refuses server addresses or serves a JavaScript shell without
    // Open Graph tags. Its own oEmbed endpoint is the sanctioned fallback: no
    // key, and no third-party relay sees the link.
    if is_x_status_url(&query.url) {
        let usable = matches!(&og, Ok(p) if p.description.is_some());
        if !usable {
            if let Ok(post) = fetch_x_post(&query.url).await {
                return Ok(Json(post));
            }
        }
    }

    let mut preview = og?;
    classify_preview(&query.url, &mut preview);
    Ok(Json(preview))
}

async fn fetch_open_graph(target: OutboundTarget) -> Result<UrlPreviewResponse> {
    let (final_url, response) =
        get_following_redirects(target, PREVIEW_FETCH_TIMEOUT_MS, "text/html", validate_hop).await?;

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let html = if content_type.contains("text/html") {
        read_capped_text(response, PREVIEW_MAX_BYTES).await?
    } else {
        String::new()
    };

    Ok(preview_metadata(&final_url, &html))
}

fn is_x_status_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else { return false };
    let host = url.host_str().unwrap_or_default().trim_start_matches("www.");
    (host == "x.com" || host == "twitter.com") && url.path().contains("/status/")
}

/// Decide what kind of thing a link is, from the URL and the metadata found.
fn classify_preview(raw: &str, preview: &mut UrlPreviewResponse) {
    if preview.kind.is_some() {
        return;
    }
    let url = Url::parse(raw).ok();
    let host = url
        .as_ref()
        .and_then(|u| u.host_str())
        .unwrap_or_default()
        .trim_start_matches("www.")
        .to_string();
    let segments: Vec<&str> = url
        .as_ref()
        .map(|u| u.path().split('/').filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let og_type = preview.r#type.clone().unwrap_or_default();

    let kind = if is_x_status_url(raw) {
        // The Open Graph title is "Name (@handle) on X"; the description is the post text.
        if let Some(title) = preview.title.clone() {
            if let Some((name, rest)) = title.split_once(" (@") {
                if let Some((handle, _)) = rest.split_once(')') {
                    preview.author = Some(name.to_string());
                    preview.author_handle = Some(format!("@{handle}"));
                }
            }
        }
        "post"
    } else if host == "github.com" && segments.len() == 2 {
        preview.author = Some(segments[0].to_string());
        "repo"
    } else if preview.video.is_some() || og_type.starts_with("video") {
        "video"
    } else if og_type.starts_with("music")
        || host.ends_with("spotify.com")
        || host.ends_with("soundcloud.com")
        || host.ends_with("bandcamp.com")
    {
        "audio"
    } else if og_type == "article" {
        "article"
    } else {
        "link"
    };
    preview.kind = Some(kind.to_string());
}

/// Fetch a post through X's official oEmbed endpoint and pull out the text.
async fn fetch_x_post(raw_url: &str) -> Result<UrlPreviewResponse> {
    let endpoint = format!(
        "https://publish.x.com/oembed?omit_script=true&dnt=true&url={}",
        urlencoding::encode(raw_url)
    );
    let oembed = fetch_oembed(&endpoint).await?;
    let html = oembed.html.unwrap_or_default();
    let (text, published) = parse_x_oembed_html(&html);
    if text.is_none() {
        return Err(AppError::BadRequest("empty post".into()));
    }
    let author_handle = oembed
        .author_url
        .as_deref()
        .and_then(|u| u.trim_end_matches('/').rsplit('/').next())
        .map(|h| format!("@{h}"));
    Ok(UrlPreviewResponse {
        title: oembed.author_name.clone(),
        description: text,
        image: None,
        site_name: Some("X".to_string()),
        r#type: Some("article".to_string()),
        youtube_id: None,
        channel_name: None,
        video: None,
        twitter_card: None,
        twitter_player: None,
        kind: Some("post".to_string()),
        author: oembed.author_name,
        author_handle,
        published,
    })
}

/// The oEmbed `html` is a blockquote: the post text is the first `<p>`, the
/// date is the text of the trailing link.
fn parse_x_oembed_html(html: &str) -> (Option<String>, Option<String>) {
    let paragraph = regex::Regex::new(r"(?s)<p[^>]*>(.*?)</p>").ok();
    let text = paragraph
        .and_then(|re| re.captures(html).map(|c| c[1].to_string()))
        .map(|inner| {
            let with_breaks = inner.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n");
            let stripped = regex::Regex::new(r"<[^>]+>")
                .map(|re| re.replace_all(&with_breaks, "").to_string())
                .unwrap_or(with_breaks);
            decode_html_entities(stripped.trim())
        })
        .filter(|t| !t.is_empty());
    let published = regex::Regex::new(r"(?s)</p>.*?<a[^>]*>([^<]+)</a>\s*</blockquote>")
        .ok()
        .and_then(|re| re.captures(html).map(|c| decode_html_entities(c[1].trim())))
        .filter(|d| !d.is_empty());
    (text, published)
}

/// Extract Open Graph / Twitter card metadata from a fetched page. Asset
/// URLs are resolved against the URL that was actually fetched after
/// redirects, so root-relative og:image paths and moved hosts stay valid.
fn preview_metadata(final_url: &Url, html: &str) -> UrlPreviewResponse {
    let title = get_meta(html, "og:title")
        .or_else(|| get_meta(html, "twitter:title"))
        .or_else(|| {
            regex::Regex::new(r"<title[^>]*>([^<]*)</title>")
                .ok()?
                .captures(html)
                .map(|c| decode_html_entities(&c[1]))
        });

    let description = get_meta(html, "og:description")
        .or_else(|| get_meta(html, "twitter:description"))
        .or_else(|| get_meta(html, "description"));

    let site_name = get_meta(html, "og:site_name");
    let r#type = get_meta(html, "og:type");
    let image = get_meta(html, "og:image")
        .or_else(|| get_meta(html, "twitter:image"))
        .map(|raw| resolve_against(final_url, &raw));
    let video_url = get_meta(html, "og:video:secure_url")
        .or_else(|| get_meta(html, "og:video:url"))
        .or_else(|| get_meta(html, "og:video"))
        .map(|raw| resolve_against(final_url, &raw));
    let video_type = get_meta(html, "og:video:type");
    let video_width =
        get_meta(html, "og:video:width").or_else(|| get_meta(html, "twitter:player:width"));
    let video_height =
        get_meta(html, "og:video:height").or_else(|| get_meta(html, "twitter:player:height"));
    let twitter_card = get_meta(html, "twitter:card");
    let twitter_player = get_meta(html, "twitter:player");

    let video = video_url.map(|url| PreviewVideo {
        url,
        r#type: video_type,
        width: video_width,
        height: video_height,
    });

    UrlPreviewResponse {
        title,
        description,
        image,
        site_name,
        r#type,
        youtube_id: None,
        channel_name: None,
        video,
        twitter_card,
        twitter_player,
        kind: None,
        author: None,
        author_handle: None,
        published: None,
    }
}

async fn fetch_youtube_preview(raw_url: &str) -> Result<Json<UrlPreviewResponse>> {
    let youtube_id = parse_youtube_id(raw_url).unwrap_or_default();
    let image = format!("https://i.ytimg.com/vi/{}/maxresdefault.jpg", youtube_id);
    let yt_id_for_url = youtube_id.clone();

    let mut title: Option<String> = None;
    let mut channel_name: Option<String> = None;

    let oembed_url = format!(
        "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={}&format=json",
        yt_id_for_url
    );

    if let Ok(oembed) = fetch_oembed(&oembed_url).await {
        title = oembed
            .title
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        channel_name = oembed
            .author_name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
    }

    Ok(Json(UrlPreviewResponse {
        title: title.or(Some("YouTube".to_string())),
        description: None,
        image: Some(image),
        site_name: Some("YouTube".to_string()),
        r#type: Some("video.other".to_string()),
        youtube_id: Some(youtube_id.clone()),
        channel_name,
        video: Some(PreviewVideo {
            url: format!("https://www.youtube.com/embed/{}", youtube_id),
            r#type: Some("text/html".to_string()),
            width: Some("1280".to_string()),
            height: Some("720".to_string()),
        }),
        twitter_card: Some("player".to_string()),
        twitter_player: Some(format!("https://www.youtube.com/embed/{}", youtube_id)),
        kind: Some("video".to_string()),
        author: None,
        author_handle: None,
        published: None,
    }))
}

async fn fetch_oembed(raw_url: &str) -> Result<OembedResponse> {
    // The oEmbed endpoint is a different destination from a youtu.be link;
    // validate and pin the URL that is actually requested.
    let target = validate_outbound_url(raw_url).await?;
    let response = pinned_client(&target, OEMBED_FETCH_TIMEOUT_MS)?
        .build()?
        .get(target.url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (compatible; WabiBot/1.0; +https://wabi.chat)",
        )
        .header("Accept", "application/json")
        .send()
        .await?
        .error_for_status()?;
    let body = read_capped_body(response, PREVIEW_MAX_BYTES).await?;
    serde_json::from_slice(&body)
        .map_err(|_| AppError::BadRequest("invalid oEmbed response".into()))
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Proxy
// ─────────────────────────────────────────────────────────────────────────────

/// Image proxy query parameters
#[derive(Debug, Deserialize)]
pub struct ImageProxyQuery {
    url: String,
}

fn image_response_headers(upstream: &axum::http::HeaderMap) -> Result<axum::http::HeaderMap> {
    let content_type = upstream
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<mime_guess::Mime>().ok())
        .filter(|mime| {
            mime.type_() == "image" && !mime.subtype().as_str().is_empty() && mime.subtype() != "*"
        })
        .ok_or_else(|| AppError::BadRequest("not an image".into()))?;

    let mut headers = axum::http::HeaderMap::new();
    // Proxied images are remote-controlled content, just like uploads. SVGs
    // must remain safe even when opened as a document at the Authority origin.
    for (name, value) in super::upload::upload_response_headers() {
        headers.insert(name, value);
    }
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_str(&content_type.to_string())
            .map_err(|_| AppError::BadRequest("invalid image content type".into()))?,
    );
    headers.insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("public, max-age=86400"),
    );
    Ok(headers)
}

pub async fn image_proxy(
    State(_state): State<Arc<AppState>>,
    _auth: AuthUser,
    Query(query): Query<ImageProxyQuery>,
) -> Result<axum::response::Response> {
    let target = validate_outbound_url(&query.url).await?;
    // Hotlinked preview images often redirect (CDN canonicalisation); each
    // hop is re-validated exactly like the first request.
    let (_final_url, response) =
        get_following_redirects(target, IMAGE_PROXY_TIMEOUT_MS, "image/*", validate_hop).await?;

    if !response.status().is_success() {
        return Err(anyhow::anyhow!("Failed to fetch image").into());
    }

    let headers = image_response_headers(response.headers())?;
    let bytes = read_capped_body(response, IMAGE_PROXY_MAX_BYTES).await?;
    let mut response = axum::response::Response::new(axum::body::Body::from(bytes));
    *response.headers_mut() = headers;
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Bytes,
        http::{header, HeaderMap, StatusCode},
        routing::get,
        Router,
    };
    use reqwest::dns::{Name, Resolve, Resolving};
    use std::convert::Infallible;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::TcpListener;

    struct UnexpectedDns(Arc<AtomicUsize>);

    impl Resolve for UnexpectedDns {
        fn resolve(&self, _: Name) -> Resolving {
            self.0.fetch_add(1, Ordering::Relaxed);
            Box::pin(async {
                Err(std::io::Error::other("fixture DNS fallback must not run").into())
            })
        }
    }

    async fn fixture(app: Router) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (address, task)
    }

    // This test-only target bypasses address classification to exercise the
    // exact production transport builder against a hermetic loopback fixture.
    fn fixture_target(address: SocketAddr, path: &str) -> OutboundTarget {
        OutboundTarget {
            url: Url::parse(&format!(
                "http://preview-fixture.invalid:{}{path}",
                address.port()
            ))
            .unwrap(),
            address,
        }
    }

    #[tokio::test]
    async fn literal_urls_reject_internal_and_mapped_addresses_before_any_lookup() {
        for url in [
            "file:///etc/passwd",
            "ftp://8.8.8.8/file",
            "http://127.0.0.1/",
            "http://2130706433/",
            "http://10.1.2.3/",
            "http://169.254.169.254/",
            "http://[::1]/",
            "http://[fc00::1]/",
            "http://[fe80::1]/",
            "http://[fec0::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:192.168.1.1]/",
            "http://[::ffff:169.254.169.254]/",
        ] {
            assert!(
                matches!(
                    validate_outbound_url(url).await,
                    Err(AppError::BadRequest(_))
                ),
                "{url}"
            );
        }
        let target = validate_outbound_url("https://[::ffff:8.8.8.8]:8443/path")
            .await
            .unwrap();
        assert_eq!(target.address, "8.8.8.8:8443".parse().unwrap());
        assert_eq!(target.url.scheme(), "https");
    }

    #[test]
    fn dns_mapped_ipv6_uses_the_same_ipv4_classification() {
        for address in [
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:172.16.0.1",
            "::ffff:192.168.0.1",
            "::ffff:169.254.169.254",
            "::ffff:100.64.0.1",
            "::ffff:198.18.0.1",
            "::ffff:0.0.0.0",
            "::ffff:224.0.0.1",
            "::",
            "ff02::1",
            "fc00::1",
            "fe80::1",
            "fec0::1",
            "feff::1",
        ] {
            assert!(!is_public_ip(address.parse().unwrap()), "{address}");
        }
        for address in ["8.8.8.8", "::ffff:8.8.8.8", "2606:4700:4700::1111"] {
            assert!(is_public_ip(address.parse().unwrap()), "{address}");
        }
    }

    #[test]
    fn proxied_images_reuse_upload_sandbox_and_accept_valid_mime_parameters() {
        for content_type in [
            "image/svg+xml; charset=utf-8",
            "image/png",
            "image/jpeg; quality=80",
        ] {
            let mut upstream = HeaderMap::new();
            upstream.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
            let headers = image_response_headers(&upstream).unwrap();
            assert_eq!(headers[header::CONTENT_TYPE], content_type);
            assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=86400");
            for (name, value) in super::super::upload::upload_response_headers() {
                assert_eq!(headers[name], value);
            }
            let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
            assert!(csp
                .split(';')
                .any(|directive| directive.trim() == "sandbox"));
            assert!(!csp.contains("allow-scripts"));
            assert!(!csp.contains("allow-same-origin"));
            // Keep normal inline image rendering; sandbox applies when an SVG
            // is opened as a standalone document, without forcing downloads.
            assert!(!headers.contains_key(header::CONTENT_DISPOSITION));
        }
    }

    #[test]
    fn proxied_images_reject_missing_malformed_and_wildcard_mime_types() {
        assert!(matches!(
            image_response_headers(&HeaderMap::new()),
            Err(AppError::BadRequest(_))
        ));
        for content_type in [
            "text/html",
            "image/",
            "image/png bogus",
            "image/*",
            "image/*+xml",
        ] {
            let mut upstream = HeaderMap::new();
            upstream.insert(header::CONTENT_TYPE, content_type.parse().unwrap());
            assert!(
                matches!(
                    image_response_headers(&upstream),
                    Err(AppError::BadRequest(_))
                ),
                "{content_type}"
            );
        }
    }

    #[tokio::test]
    async fn pinned_transport_preserves_hostname_and_never_resolves_again_or_follows_redirects() {
        let redirected = Arc::new(AtomicUsize::new(0));
        let calls = redirected.clone();
        let app = Router::new()
            .route(
                "/echo",
                get(|headers: HeaderMap| async move {
                    headers[header::HOST].to_str().unwrap().to_owned()
                }),
            )
            .route(
                "/redirect",
                get(|| async {
                    (
                        StatusCode::TEMPORARY_REDIRECT,
                        [(header::LOCATION, "/private")],
                    )
                }),
            )
            .route(
                "/private",
                get(move || {
                    let calls = calls.clone();
                    async move {
                        calls.fetch_add(1, Ordering::Relaxed);
                        "private"
                    }
                }),
            );
        let (address, task) = fixture(app).await;
        let target = fixture_target(address, "/echo");
        let dns_calls = Arc::new(AtomicUsize::new(0));
        let client = pinned_client(&target, 1000)
            .unwrap()
            .dns_resolver(UnexpectedDns(dns_calls.clone()))
            .build()
            .unwrap();
        let response = client.get(target.url.clone()).send().await.unwrap();
        assert_eq!(
            read_capped_text(response, 1024).await.unwrap(),
            format!("preview-fixture.invalid:{}", address.port())
        );
        let response = client
            .get(fixture_target(address, "/redirect").url)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TEMPORARY_REDIRECT);
        assert_eq!(redirected.load(Ordering::Relaxed), 0);
        assert_eq!(dns_calls.load(Ordering::Relaxed), 0);
        task.abort();
    }

    #[test]
    fn redirect_locations_resolve_against_the_current_url() {
        let base = Url::parse("https://x.com/gnu/status/123").unwrap();
        assert_eq!(
            redirect_target(&base, "https://x.com/gnu").unwrap().as_str(),
            "https://x.com/gnu"
        );
        assert_eq!(
            redirect_target(&base, "/gnu/status/9").unwrap().as_str(),
            "https://x.com/gnu/status/9"
        );
        // Location headers sometimes carry stray whitespace.
        assert_eq!(
            redirect_target(&base, " media ").unwrap().as_str(),
            "https://x.com/gnu/status/media"
        );
    }

    #[test]
    fn a_not_found_page_still_produces_preview_metadata() {
        // X answers a deleted post with a 404 body that still carries
        // Open Graph tags; rejecting non-2xx would turn that honest card
        // into a failed preview.
        let html = r#"<html><head>
            <meta property="og:title" content="Post Not Found - X | 404 Error">
            <meta property="og:description" content="The post may have been deleted.">
            <meta property="og:image" content="/ssr/default/v2/og/image.png">
            <meta property="og:site_name" content="X (formerly Twitter)">
            <meta property="og:type" content="article">
        </head><body>gone</body></html>"#;
        let metadata =
            preview_metadata(&Url::parse("https://x.com/gnu/status/1?s=20").unwrap(), html);
        assert_eq!(
            metadata.title.as_deref(),
            Some("Post Not Found - X | 404 Error")
        );
        assert_eq!(
            metadata.description.as_deref(),
            Some("The post may have been deleted.")
        );
        assert_eq!(
            metadata.image.as_deref(),
            Some("https://x.com/ssr/default/v2/og/image.png")
        );
        assert_eq!(metadata.site_name.as_deref(), Some("X (formerly Twitter)"));
        assert_eq!(metadata.r#type.as_deref(), Some("article"));
    }

    #[test]
    fn a_non_html_body_produces_an_empty_preview() {
        let metadata =
            preview_metadata(&Url::parse("https://example.invalid/data.json").unwrap(), "");
        assert!(metadata.title.is_none());
        assert!(metadata.image.is_none());
        assert!(metadata.video.is_none());
        assert!(metadata.twitter_card.is_none());
    }

    #[tokio::test]
    async fn redirects_are_followed_after_revalidating_every_hop() {
        let app = Router::new()
            .route(
                "/start",
                get(|| async {
                    (
                        StatusCode::TEMPORARY_REDIRECT,
                        [(header::LOCATION, "/landed")],
                    )
                }),
            )
            .route(
                "/landed",
                get(|| async { "<html><meta property=\"og:title\" content=\"landed\"></html>" }),
            );
        let (address, task) = fixture(app).await;
        let target = fixture_target(address, "/start");
        // Stand-in for validate_outbound_url: the fixture addresses the
        // loopback server through the pinned Host, never via DNS.
        let (final_url, response) = get_following_redirects(target, 1000, "text/html", move |raw| {
            let address = address;
            Box::pin(async move {
                let url = Url::parse(&raw).map_err(|_| AppError::BadRequest("invalid URL".into()))?;
                Ok(fixture_target(address, url.path()))
            })
        })
        .await
        .unwrap();
        assert_eq!(final_url.path(), "/landed");
        assert!(response.status().is_success());
        assert!(
            read_capped_text(response, 1024)
                .await
                .unwrap()
                .contains("landed")
        );
        task.abort();
    }

    #[tokio::test]
    async fn redirect_loops_are_bounded() {
        let app = Router::new().route(
            "/loop",
            get(|| async {
                (
                    StatusCode::TEMPORARY_REDIRECT,
                    [(header::LOCATION, "/loop")],
                )
            }),
        );
        let (address, task) = fixture(app).await;
        let target = fixture_target(address, "/loop");
        let result = get_following_redirects(target, 1000, "text/html", move |raw| {
            let address = address;
            Box::pin(async move {
                let url = Url::parse(&raw).map_err(|_| AppError::BadRequest("invalid URL".into()))?;
                Ok(fixture_target(address, url.path()))
            })
        })
        .await;
        assert!(result.is_err());
        task.abort();
    }

    #[tokio::test]
    async fn refused_pinned_connection_does_not_fall_back_to_dns() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let target = fixture_target(address, "/");
        let dns_calls = Arc::new(AtomicUsize::new(0));
        let client = pinned_client(&target, 1000)
            .unwrap()
            .dns_resolver(UnexpectedDns(dns_calls.clone()))
            .build()
            .unwrap();
        assert!(client.get(target.url).send().await.is_err());
        assert_eq!(dns_calls.load(Ordering::Relaxed), 0);
    }

    fn streamed_response(chunks: Vec<Bytes>, content_length: Option<usize>) -> reqwest::Response {
        let stream = futures::stream::iter(chunks.into_iter().map(Ok::<_, Infallible>));
        let mut response = axum::http::Response::builder();
        if let Some(length) = content_length {
            response = response.header(header::CONTENT_LENGTH, length);
        }
        response
            .body(reqwest::Body::wrap_stream(stream))
            .unwrap()
            .into()
    }

    #[tokio::test]
    async fn streamed_caps_reject_oversized_bodies_with_missing_or_misleading_lengths() {
        for declared in [None, Some(3)] {
            let response = streamed_response(
                vec![Bytes::from_static(b"abc"), Bytes::from_static(b"def")],
                declared,
            );
            assert!(matches!(
                read_capped_body(response, 5).await,
                Err(AppError::BadRequest(_))
            ));
        }
        let response = streamed_response(
            vec![Bytes::from_static(b"abc"), Bytes::from_static(b"de")],
            None,
        );
        assert_eq!(read_capped_body(response, 5).await.unwrap(), b"abcde");
        for limit in [PREVIEW_MAX_BYTES, IMAGE_PROXY_MAX_BYTES] {
            let response = streamed_response(
                vec![Bytes::from(vec![0; limit]), Bytes::from_static(b"x")],
                None,
            );
            assert!(matches!(
                read_capped_body(response, limit).await,
                Err(AppError::BadRequest(_))
            ));
        }
    }

    #[tokio::test]
    async fn capped_text_preserves_html_charset_decoding() {
        let response = axum::http::Response::builder()
            .header(header::CONTENT_TYPE, "text/html; charset=windows-1252")
            .body(b"<title>Caf\xe9</title>".to_vec())
            .unwrap()
            .into();
        let html = read_capped_text(response, PREVIEW_MAX_BYTES).await.unwrap();
        assert_eq!(html, "<title>Café</title>");
    }
}

#[cfg(test)]
mod link_kind_tests {
    use super::*;

    fn bare() -> UrlPreviewResponse {
        UrlPreviewResponse {
            title: None,
            description: None,
            image: None,
            site_name: None,
            r#type: None,
            youtube_id: None,
            channel_name: None,
            video: None,
            twitter_card: None,
            twitter_player: None,
            kind: None,
            author: None,
            author_handle: None,
            published: None,
        }
    }

    #[test]
    fn x_status_urls_are_recognised_on_both_hosts() {
        assert!(is_x_status_url("https://x.com/jack/status/20"));
        assert!(is_x_status_url("https://www.twitter.com/jack/status/20?s=1"));
        assert!(!is_x_status_url("https://x.com/jack"));
        assert!(!is_x_status_url("https://example.com/a/status/1"));
    }

    #[test]
    fn oembed_html_yields_text_and_date() {
        let html = r#"<blockquote class="twitter-tweet"><p lang="en" dir="ltr">just setting up my twttr<br>line two &amp; more</p>&mdash; jack (@jack) <a href="https://twitter.com/jack/status/20?ref_src=twsrc%5Etfw">March 21, 2006</a></blockquote>"#;
        let (text, published) = parse_x_oembed_html(html);
        assert_eq!(text.as_deref(), Some("just setting up my twttr\nline two & more"));
        assert_eq!(published.as_deref(), Some("March 21, 2006"));
    }

    #[test]
    fn open_graph_x_posts_become_post_cards_with_author_and_handle() {
        let mut post = bare();
        post.title = Some("jack (@jack) on X".into());
        post.description = Some("just setting up my twttr".into());
        classify_preview("https://x.com/jack/status/20", &mut post);
        assert_eq!(post.kind.as_deref(), Some("post"));
        assert_eq!(post.author.as_deref(), Some("jack"));
        assert_eq!(post.author_handle.as_deref(), Some("@jack"));
    }

    #[test]
    fn links_are_classified_by_what_they_point_at() {
        let mut repo = bare();
        classify_preview("https://github.com/rust-lang/rust", &mut repo);
        assert_eq!(repo.kind.as_deref(), Some("repo"));
        assert_eq!(repo.author.as_deref(), Some("rust-lang"));

        let mut article = bare();
        article.r#type = Some("article".into());
        classify_preview("https://example.com/a", &mut article);
        assert_eq!(article.kind.as_deref(), Some("article"));

        let mut audio = bare();
        classify_preview("https://open.spotify.com/track/1", &mut audio);
        assert_eq!(audio.kind.as_deref(), Some("audio"));

        let mut other = bare();
        classify_preview("https://example.com/", &mut other);
        assert_eq!(other.kind.as_deref(), Some("link"));
    }
}
