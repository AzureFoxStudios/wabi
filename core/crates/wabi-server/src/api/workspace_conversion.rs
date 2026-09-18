//! Optional compatibility gateway. The ordinary Wabi binary does not contain
//! LibreOffice. Only a fixed administrator-configured sidecar receives an
//! explicitly approved original; output is a bounded static PDF, never HTML.
use axum::{extract::State, routing::get, Json, Router};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::{BTreeMap, BTreeSet}, io::{Cursor, Read}, sync::{Arc, LazyLock, Mutex}, time::{Duration, Instant}};
use tokio::sync::Semaphore;
use crate::{auth_extractor::AuthUser, error::AppError};
use super::{WorkspaceState, admit, bad, require_cap};

type Result<T> = std::result::Result<T, AppError>;
const ORIGINAL_LIMIT: usize = 12 * 1024 * 1024;
const EXPANDED_LIMIT: u64 = 64 * 1024 * 1024;
static SLOT: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(1)));
static BUDGET: LazyLock<Mutex<BTreeMap<i64, (Instant, u32)>>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));

fn endpoint(value: &str) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(value).map_err(|_| bad("Invalid Office converter configuration"))?;
    if !["http", "https"].contains(&url.scheme()) || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() || url.path() != "/" {
        return Err(bad("Office converter must use an HTTP(S) origin without credentials or a path"));
    }
    url.set_path("/forms/libreoffice/convert");
    Ok(url)
}
fn configured_endpoint() -> Option<reqwest::Url> {
    if std::env::var("WABI_OFFICE_CONVERTER_ENABLED").ok().as_deref() != Some("1") { return None; }
    endpoint(&std::env::var("WABI_OFFICE_CONVERTER_URL").ok()?).ok()
}
pub(super) fn configured() -> bool { configured_endpoint().is_some() }
pub(super) fn routes() -> Router<WorkspaceState> { Router::new().route("/conversion", get(status).post(convert)) }
async fn status(State(state): State<WorkspaceState>, auth: AuthUser) -> Result<Json<Value>> {
    admit(&state, &auth).await?;
    let enabled = require_cap(&state, "present").is_ok() && configured();
    Ok(Json(json!({"configured":enabled,"formats":["pptx","odp"],"maxBytes":ORIGINAL_LIMIT,"output":"static-pdf","uploadsOriginal":true})))
}
fn spend(user: i64) -> Result<()> {
    let mut budget = BUDGET.lock().map_err(|_| AppError::Internal("Office conversion is unavailable".into()))?;
    budget.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(60));
    if budget.len() >= 4096 && !budget.contains_key(&user) { return Err(AppError::TooManyRequests("Office conversion is busy".into())); }
    let entry = budget.entry(user).or_insert((Instant::now(), 0));
    if entry.1 >= 4 { return Err(AppError::TooManyRequests("Limit: four Office conversions per minute".into())); }
    entry.1 += 1;
    Ok(())
}

/// Inspect actual decompressed bytes and CRCs, not only attacker-supplied sizes.
/// Never extract member paths onto the filesystem.
fn validate_archive(raw: &[u8], extension: &str) -> Result<()> {
    if raw.len() > ORIGINAL_LIMIT || !["pptx", "odp"].contains(&extension) || !raw.starts_with(b"PK\x03\x04") { return Err(bad("Choose a PPTX or ODP file under 12 MB")); }
    let mut archive = zip::ZipArchive::new(Cursor::new(raw)).map_err(|_| bad("Invalid Office archive"))?;
    if archive.is_empty() || archive.len() > 4096 { return Err(bad("Office archive entry limit exceeded")); }
    let mut names = BTreeSet::new();
    let mut expanded = 0u64;
    let mut odf_type = false;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| bad("Encrypted or damaged Office archives are not supported"))?;
        let name = entry.name().to_owned();
        let lower = name.to_ascii_lowercase();
        let directory = entry.is_dir();
        if name.is_empty() || name.contains(['\\', '\0']) || name.starts_with('/') || name.split('/').any(|part| part == "..") || !names.insert(name.clone()) || entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            return Err(bad("Unsafe or duplicate Office archive entry"));
        }
        // Ordinary PowerPoint writers include empty embeddings/ directories.
        // A directory descriptor is not a program, but files below it remain
        // forbidden and directory entries must be proven empty below.
        if !directory && (lower.contains("vbaproject") || lower.contains("vbasignature") || lower.starts_with("basic/") || lower.starts_with("scripts/") || lower.contains("/activex/") || lower.contains("/embeddings/")) {
            return Err(bad("Macros, ActiveX, and embedded programs are not supported by Office conversion"));
        }
        if entry.size() > 24 * 1024 * 1024 || entry.size() > entry.compressed_size().max(1).saturating_mul(250) { return Err(bad("Office archive expansion limit exceeded")); }
        let mut bytes = Vec::new();
        let limit = (24 * 1024 * 1024u64).min(EXPANDED_LIMIT.saturating_sub(expanded));
        (&mut entry).take(limit + 1).read_to_end(&mut bytes).map_err(|_| bad("Damaged Office archive content"))?;
        if bytes.len() as u64 > limit || bytes.len() as u64 != entry.size() { return Err(bad("Office archive expansion limit exceeded")); }
        if directory && !bytes.is_empty() { return Err(bad("Office directory entries cannot contain a payload")); }
        expanded += bytes.len() as u64;
        if name == "mimetype" { odf_type = bytes == b"application/vnd.oasis.opendocument.presentation"; }
    }
    let valid = match extension {
        "pptx" => names.contains("[Content_Types].xml") && names.contains("ppt/presentation.xml"),
        "odp" => odf_type && names.contains("content.xml") && names.contains("META-INF/manifest.xml"),
        _ => false,
    };
    if !valid { return Err(bad("The archive does not match the selected presentation format")); }
    Ok(())
}

fn multipart(raw: &[u8], extension: &str, boundary: &str) -> Vec<u8> {
    let mut body = Vec::with_capacity(raw.len() + 4096);
    // These fields are fixed here. Clients cannot enable URL fetches, notes,
    // hidden slides, original-document attachments, passwords, or callbacks.
    for (name, value) in [
        ("exportHiddenSlides", "false"), ("exportNotes", "false"),
        ("exportNotesPages", "false"), ("exportOnlyNotesPages", "false"),
        ("exportNotesInMargin", "false"), ("addOriginalDocumentAsStream", "false"),
        ("exportFormFields", "false"), ("exportBookmarks", "false"),
        ("updateIndexes", "false"), ("reduceImageResolution", "true"),
        ("maxImageResolution", "150"), ("quality", "80"),
    ] {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"source.{extension}\"\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
    body.extend_from_slice(raw);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input { extension: String, data: String, consent: bool }
async fn convert(State(state): State<WorkspaceState>, auth: AuthUser, Json(input): Json<Input>) -> Result<Json<Value>> {
    admit(&state, &auth).await?;
    require_cap(&state, "present")?;
    if !input.consent { return Err(bad("Explicit consent is required before uploading an original presentation")); }
    if !["pptx", "odp"].contains(&input.extension.as_str()) || input.data.len() > ORIGINAL_LIMIT.div_ceil(3) * 4 { return Err(bad("Choose a PPTX or ODP file under 12 MB")); }
    let endpoint = configured_endpoint().ok_or_else(|| AppError::Forbidden("The server operator has not installed Office conversion. The private original is unchanged; import a PDF instead.".into()))?;
    spend(auth.user_id)?;
    let permit = SLOT.clone().try_acquire_owned().map_err(|_| AppError::TooManyRequests("An Office conversion is already running. Retry after it completes.".into()))?;
    let extension = input.extension;
    let raw = STANDARD.decode(input.data).map_err(|_| bad("Invalid Office file encoding"))?;
    let checked_extension = extension.clone();
    // The permit stays with validation if a disconnected request drops its join
    // handle. Blocking decompression cannot multiply into unbounded workers.
    let (raw, _permit) = tokio::task::spawn_blocking(move || {
        validate_archive(&raw, &checked_extension)?;
        Ok::<_, AppError>((raw, permit))
    }).await.map_err(|_| bad("Office archive validation failed"))??;
    let boundary = format!("wabi-{}", uuid::Uuid::new_v4());
    let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3)).timeout(Duration::from_secs(30)).build()
        .map_err(|_| AppError::Internal("Office converter client is unavailable".into()))?;
    let mut upstream = client.post(endpoint)
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .header("Accept", "application/pdf").body(multipart(&raw, &extension, &boundary));
    if let (Ok(username), Ok(password)) = (std::env::var("WABI_OFFICE_CONVERTER_USERNAME"), std::env::var("WABI_OFFICE_CONVERTER_PASSWORD")) {
        upstream = upstream.basic_auth(username, Some(password));
    }
    let mut response = upstream.send().await.map_err(|_| AppError::Internal("Office converter did not respond within its time limit. The original file is retained on your device.".into()))?;
    if !response.status().is_success() { return Err(bad("Office conversion failed. Password-protected, malformed, or unsupported presentations cannot be imported; the original remains available.")); }
    if !response.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|v| v.split(';').next() == Some("application/pdf")) || response.content_length().is_some_and(|size| size > ORIGINAL_LIMIT as u64) {
        return Err(bad("Office converter returned an invalid or oversized PDF"));
    }
    let mut pdf = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| bad("Office PDF transfer was interrupted"))? {
        if pdf.len() + chunk.len() > ORIGINAL_LIMIT { return Err(bad("Converted presentation exceeds the 12 MB PDF limit")); }
        pdf.extend_from_slice(&chunk);
    }
    if !pdf.starts_with(b"%PDF-") { return Err(bad("Office converter did not return a PDF")); }
    // Conversion never holds the collaboration or channel-membership gate.
    // Revalidate permission after the potentially long external operation.
    admit(&state, &auth).await?;
    require_cap(&state, "present")?;
    Ok(Json(json!({"pdf":STANDARD.encode(pdf),"warnings":[
        "PPTX/ODP was converted into static PDF pages. Native source objects, animations, audio, video, and interactive links are not imported.",
        "Hidden slides and speaker-note pages are excluded by the converter. Review every visible slide before creating or presenting the private copy.",
        "Fonts and layout may differ. The original remains on your device and is not replaced by this conversion."
    ]})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in entries {
            writer.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }
    #[test] fn workspace_conversion_requires_fixed_origin_configuration() {
        assert!(endpoint("http://office-converter:3000").unwrap().as_str().ends_with("/forms/libreoffice/convert"));
        for value in ["file:///etc/passwd", "http://name:secret@host", "https://host/?url=secret", "https://host/path", "https://host/#fragment"] { assert!(endpoint(value).is_err()); }
    }
    #[test] fn workspace_conversion_validates_format_and_preserves_source() {
        let raw = archive(&[("[Content_Types].xml", b"types"), ("ppt/presentation.xml", b"slides")]);
        let before = raw.clone(); assert!(validate_archive(&raw, "pptx").is_ok()); assert_eq!(raw, before);
        assert!(validate_archive(&raw, "odp").is_err()); assert!(validate_archive(b"broken", "pptx").is_err());
        let odp = archive(&[("mimetype", b"application/vnd.oasis.opendocument.presentation"), ("content.xml", b"slides"), ("META-INF/manifest.xml", b"manifest")]);
        assert!(validate_archive(&odp, "odp").is_ok());
    }
    #[test] fn workspace_conversion_allows_empty_directories_not_disguised_payloads() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer.start_file("[Content_Types].xml", zip::write::SimpleFileOptions::default()).unwrap();
        writer.write_all(b"types").unwrap();
        writer.start_file("ppt/presentation.xml", zip::write::SimpleFileOptions::default()).unwrap();
        writer.write_all(b"slides").unwrap();
        for directory in ["ppt/embeddings/", "ppt/activeX/", "Basic/", "Scripts/"] {
            writer.add_directory(directory, zip::write::SimpleFileOptions::default()).unwrap();
        }
        let raw = writer.finish().unwrap().into_inner();
        assert!(validate_archive(&raw, "pptx").is_ok());
        for directory in ["ppt/embeddings/", "ppt/activeX/", "Basic/", "Scripts/"] {
            let disguised = archive(&[("[Content_Types].xml", b"types"), ("ppt/presentation.xml", b"slides"), (directory, b"payload")]);
            assert!(validate_archive(&disguised, "pptx").is_err(), "{directory}");
        }
    }
    #[test] fn workspace_conversion_rejects_programs_and_expansion_bombs() {
        for name in ["../escape", "ppt/vbaProject.bin", "Basic/module.xml", "Scripts/code.py", "ppt/embeddings/program.bin", "ppt/activeX/control.xml"] {
            let raw = archive(&[("[Content_Types].xml", b"types"), ("ppt/presentation.xml", b"slides"), (name, b"payload")]);
            assert!(validate_archive(&raw, "pptx").is_err(), "{name}");
        }
        let large = vec![0; 25 * 1024 * 1024];
        assert!(validate_archive(&archive(&[("large", &large)]), "pptx").is_err());
    }
    #[test] fn workspace_conversion_multipart_never_enables_private_or_external_features() {
        let body = String::from_utf8(multipart(b"ORIGINAL", "pptx", "boundary")).unwrap();
        for name in ["exportHiddenSlides", "exportNotes", "exportNotesPages", "exportOnlyNotesPages", "addOriginalDocumentAsStream"] {
            assert!(body.contains(&format!("name=\"{name}\"\r\n\r\nfalse\r\n")));
        }
        assert!(!body.contains("downloadFrom")); assert!(!body.contains("Webhook")); assert!(body.contains("filename=\"source.pptx\""));
    }
}
