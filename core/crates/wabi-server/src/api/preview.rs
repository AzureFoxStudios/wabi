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

use crate::error::Result;
use crate::state::AppState;

// ─────────────────────────────────────────────────────────────────────────────
// Image proxy
// ─────────────────────────────────────────────────────────────────────────────

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
    Query(query): Query<UrlPreviewQuery>,
) -> Result<Json<UrlPreviewResponse>> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_millis(PREVIEW_FETCH_TIMEOUT_MS))
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
    Query(query): Query<ImageProxyQuery>,
) -> Result<axum::response::Response> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_millis(IMAGE_PROXY_TIMEOUT_MS))
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

    let bytes = response
        .bytes()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to read image body: {}", e))?;

    Ok(axum::response::Response::builder()
        .status(200)
        .header(axum::http::header::CONTENT_TYPE, content_type)
        .header(axum::http::header::CACHE_CONTROL, "public, max-age=86400")
        .body(axum::body::Body::from(bytes))
        .map_err(|e| anyhow::anyhow!("Failed to build response: {}", e))?)
}
