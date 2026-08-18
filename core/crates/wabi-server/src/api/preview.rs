//! URL preview (OG metadata fetch with YouTube oEmbed) and image proxy routes
//!
//! Implements:
//! - GET /api/url-preview?url=... - Fetch OpenGraph metadata, with special YouTube oEmbed support
//! - GET /api/image-proxy?url=... - Proxy images to avoid hotlink protection

use axum::{
    extract::{Query, State},
    Json,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::state::AppState;

// ─────────────────────────────────────────────────────────────────────────────
// SSRF validation (shared by url-preview and image-proxy)
// ─────────────────────────────────────────────────────────────────────────────

const PREVIEW_MAX_BYTES: usize = 2 * 1024 * 1024; // 2 MB
const IMAGE_PROXY_MAX_BYTES: usize = 10 * 1024 * 1024; // 10 MB

/// Validate a URL for outbound fetches: http/https only, resolve and reject
/// loopback / private / link-local / multicast / unspecified addresses.
/// Returns the resolved SocketAddr on success.
async fn validate_outbound_url(raw_url: &str) -> Result<std::net::SocketAddr> {
    let url = reqwest::Url::parse(raw_url)
        .map_err(|_| AppError::BadRequest("invalid URL".into()))?;

    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(AppError::BadRequest("URL must be http or https".into()));
    }

    let host = url.host_str()
        .ok_or_else(|| AppError::BadRequest("URL has no host".into()))?;

    // Reject bare IP literals that are obviously internal.
    if host.starts_with('[') && host.ends_with(']') {
        let inner = &host[1..host.len()-1];
        if let Ok(ip) = inner.parse::<std::net::Ipv6Addr>() {
            if !is_public_ipv6(&ip) {
                return Err(AppError::BadRequest("address not allowed".into()));
            }
        }
    } else if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        if !is_public_ipv4(&ip) {
            return Err(AppError::BadRequest("address not allowed".into()));
        }
    }

    let port = url.port_or_known_default().unwrap_or(80);
    let addrs: Vec<std::net::SocketAddr> = tokio::net::lookup_host(format!("{}:{}", host, port))
        .await
        .map_err(|_| AppError::BadRequest("DNS resolution failed".into()))?
        .collect();

    let addr = addrs.into_iter().find(|a| {
        match a.ip() {
            std::net::IpAddr::V4(ip) => is_public_ipv4(&ip),
            std::net::IpAddr::V6(ip) => is_public_ipv6(&ip),
        }
    }).ok_or_else(|| AppError::BadRequest("address not allowed".into()))?;

    Ok(addr)
}

fn is_public_ipv4(ip: &std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    if octets[0] == 0 || octets[0] == 10 || octets[0] == 127 || octets[0] >= 224 {
        return false;
    }
    if octets[0] == 169 && octets[1] == 254 { return false; }
    if octets[0] == 172 && (octets[1] & 0xf0) == 16 { return false; }
    if octets[0] == 192 && octets[1] == 168 { return false; }
    if octets[0] == 198 && (octets[1] & 0xfe) == 18 { return false; }
    if octets[0] == 100 && (octets[1] & 0xc0) == 64 { return false; }
    if octets[0] == 192 && octets[1] == 0 && octets[2] == 0 { return false; }
    true
}

fn is_public_ipv6(ip: &std::net::Ipv6Addr) -> bool {
    let o = ip.segments();
    if ip.is_unspecified() || ip.is_loopback() { return false; }
    if (o[0] & 0xfe00) == 0xfc00 { return false; } // ULA
    if (o[0] & 0xffc0) == 0xfe80 { return false; } // link-local
    if (o[0] & 0xff00) == 0xff00 { return false; } // multicast
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
}

/// YouTube oEmbed response
#[derive(Debug, Deserialize)]
struct OembedResponse {
    title: Option<String>,
    author_name: Option<String>,
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
    // SSRF: validate scheme + resolve + reject internal addresses.
    validate_outbound_url(&query.url).await?;

    let client = Client::builder()
        .timeout(std::time::Duration::from_millis(PREVIEW_FETCH_TIMEOUT_MS))
        // Never follow redirects — each hop would need re-validation.
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

    if parse_youtube_id(&query.url).is_some() {
        return fetch_youtube_preview(&client, &query.url).await;
    }

    // General OG metadata fetch
    let response = client
        .get(&query.url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (compatible; WabiBot/1.0; +https://wabi.chat)",
        )
        .header("Accept", "text/html")
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to fetch URL: {}", e))?;

    if !response.status().is_success() {
        return Err(anyhow::anyhow!("Failed to fetch URL").into());
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    if !content_type.contains("text/html") {
        return Err(anyhow::anyhow!("URL is not an HTML page").into());
    }

    let html = response
        .text()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to read response body: {}", e))?;

    let title = get_meta(&html, "og:title")
        .or_else(|| get_meta(&html, "twitter:title"))
        .or_else(|| {
            regex::Regex::new(r"<title[^>]*>([^<]*)</title>")
                .ok()?
                .captures(&html)
                .map(|c| decode_html_entities(&c[1]))
        });

    let description = get_meta(&html, "og:description")
        .or_else(|| get_meta(&html, "twitter:description"))
        .or_else(|| get_meta(&html, "description"));

    let site_name = get_meta(&html, "og:site_name");
    let r#type = get_meta(&html, "og:type");
    let image = get_meta(&html, "og:image").or_else(|| get_meta(&html, "twitter:image"));
    let video_url = get_meta(&html, "og:video:secure_url")
        .or_else(|| get_meta(&html, "og:video:url"))
        .or_else(|| get_meta(&html, "og:video"));
    let video_type = get_meta(&html, "og:video:type");
    let video_width =
        get_meta(&html, "og:video:width").or_else(|| get_meta(&html, "twitter:player:width"));
    let video_height =
        get_meta(&html, "og:video:height").or_else(|| get_meta(&html, "twitter:player:height"));
    let twitter_card = get_meta(&html, "twitter:card");
    let twitter_player = get_meta(&html, "twitter:player");

    let video = video_url.map(|url| PreviewVideo {
        url,
        r#type: video_type,
        width: video_width,
        height: video_height,
    });

    Ok(Json(UrlPreviewResponse {
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
    }))
}

async fn fetch_youtube_preview(client: &Client, raw_url: &str) -> Result<Json<UrlPreviewResponse>> {
    let youtube_id = parse_youtube_id(raw_url).unwrap_or_default();
    let image = format!("https://i.ytimg.com/vi/{}/maxresdefault.jpg", youtube_id);
    let yt_id_for_url = youtube_id.clone();

    let mut title: Option<String> = None;
    let mut channel_name: Option<String> = None;

    let oembed_url = format!(
        "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={}&format=json",
        yt_id_for_url
    );

    if let Ok(response) = client
        .get(&oembed_url)
        .timeout(std::time::Duration::from_millis(OEMBED_FETCH_TIMEOUT_MS))
        .header(
            "User-Agent",
            "Mozilla/5.0 (compatible; WabiBot/1.0; +https://wabi.chat)",
        )
        .header("Accept", "application/json")
        .send()
        .await
    {
        if response.status().is_success() {
            if let Ok(oembed) = response.json::<OembedResponse>().await {
                title = oembed
                    .title
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
                channel_name = oembed
                    .author_name
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty());
            }
        }
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
    }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Image Proxy
// ─────────────────────────────────────────────────────────────────────────────

/// Image proxy query parameters
#[derive(Debug, Deserialize)]
pub struct ImageProxyQuery {
    url: String,
}

pub async fn image_proxy(
    State(_state): State<Arc<AppState>>,
    _auth: AuthUser,
    Query(query): Query<ImageProxyQuery>,
) -> Result<axum::response::Response> {
    // SSRF: validate scheme + resolve + reject internal addresses.
    validate_outbound_url(&query.url).await?;

    let client = Client::builder()
        .timeout(std::time::Duration::from_millis(IMAGE_PROXY_TIMEOUT_MS))
        // Never follow redirects.
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

    let response = client
        .get(&query.url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (compatible; WabiBot/1.0; +https://wabi.chat)",
        )
        .header("Accept", "image/*")
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to fetch image: {}", e))?;

    if !response.status().is_success() {
        return Err(anyhow::anyhow!("Failed to fetch image").into());
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();

    // Require upstream content-type to start with image/.
    if !content_type.to_lowercase().starts_with("image/") {
        return Err(anyhow::anyhow!("not an image").into());
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to read image body: {}", e))?;

    Ok(axum::response::Response::builder()
        .status(200)
        .header(axum::http::header::CONTENT_TYPE, content_type)
        .header(axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(axum::http::header::CACHE_CONTROL, "public, max-age=86400")
        .body(axum::body::Body::from(bytes))
        .map_err(|e| anyhow::anyhow!("Failed to build response: {}", e))?)
}
