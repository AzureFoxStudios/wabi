//! Emoji / sticker upload routes.
//!
//! - POST /api/emoji/upload — multipart upload (file + metadata), persists the
//!   emote into WabiDB via `upsert_emote`, broadcasts the refreshed emote list
//!   to all sockets (`emojis-list`), and returns `{ emoji }`.

use axum::extract::Multipart;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::fs::File;
use uuid::Uuid;

use wabidb::engine::wabi_store::WabiStore;

use crate::auth_extractor::AuthUser;
use crate::error::Result;
use crate::state::AppState;
use crate::upload_registry::UploadKind;

const MAX_EMOJI_BYTES: usize = 2 * 1024 * 1024;

/// POST /api/emoji/upload
/// Multipart fields: `file`, `name`, `displayName`, `artist`, `category`, `type`.
/// Returns `{ emoji: { id, name, displayName, artist, url, category, isCustom, type, source } }`.
pub async fn upload_emoji(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    if auth.is_guest {
        return Err(anyhow::anyhow!("Guests cannot upload emojis").into());
    }

    let mut file_data: Vec<u8> = Vec::new();
    let mut filename = "emoji.png".to_string();
    let mut name = String::new();
    let mut display_name = String::new();
    let mut artist = String::new();
    let mut category = String::new();
    let mut kind = String::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| anyhow::anyhow!(e))?
    {
        match field.name().unwrap_or("") {
            "file" => {
                filename = field.file_name().unwrap_or("emoji.png").to_string();
                file_data = field
                    .bytes()
                    .await
                    .map_err(|e| anyhow::anyhow!(e))?
                    .to_vec();
            }
            "name" => name = field.text().await.map_err(|e| anyhow::anyhow!(e))?,
            "displayName" => {
                display_name = field.text().await.map_err(|e| anyhow::anyhow!(e))?
            }
            "artist" => artist = field.text().await.map_err(|e| anyhow::anyhow!(e))?,
            "category" => category = field.text().await.map_err(|e| anyhow::anyhow!(e))?,
            "type" => kind = field.text().await.map_err(|e| anyhow::anyhow!(e))?,
            _ => {}
        }
    }

    if file_data.is_empty() {
        return Err(anyhow::anyhow!("No file data provided").into());
    }
    if file_data.len() > MAX_EMOJI_BYTES {
        return Err(anyhow::anyhow!("Emoji file exceeds 2MB limit").into());
    }
    if name.is_empty() {
        return Err(anyhow::anyhow!("Emoji name is required").into());
    }

    // Basic image-type guard (extension + magic bytes for png/gif/jpg/webp).
    if !is_likely_image(&file_data) {
        return Err(anyhow::anyhow!("Uploaded file is not a supported image").into());
    }

    let ext = std::path::Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .unwrap_or_else(|| ".png".to_string());

    let uploads_dir = PathBuf::from(&state.config.uploads_dir);
    tokio::fs::create_dir_all(&uploads_dir).await?;

    let final_name = format!("{}{}", Uuid::new_v4(), ext);
    let final_path = uploads_dir.join(&final_name);

    let mut file = File::create(&final_path).await?;
    file.write_all(&file_data).await?;
    file.flush().await?;
    drop(file);

    let image_url = format!("/uploads/{}", final_name);
    tracing::info!(
        "Emoji uploaded by user {}: :{}: ({} bytes, kind={}) -> {:?}",
        auth.user_id,
        name,
        file_data.len(),
        kind,
        final_path
    );

    state
        .upload_registry
        .record(
            &final_name,
            &filename,
            None,
            Some(auth.user_id),
            UploadKind::Other,
            file_data.len() as u64,
        )
        .await;

    state
        .wdb
        .upsert_emote(
            &name,
            &image_url,
            &display_name,
            &artist,
            &category,
            &kind,
            auth.user_id as u64,
        )
        .await?;

    // Broadcast the refreshed emote list so every client (including the
    // uploader) can merge custom emotes into their picker store.
    let emotes = state.wdb.get_emotes().await.unwrap_or_default();
    if let Some(io) = state.sio.read().await.clone() {
        let _ = io.broadcast().emit("emojis-list", &json!(emotes)).await;
    }

    let emoji = json!({
        "id": format!("emo_{}", name),
        "name": name,
        "displayName": display_name,
        "artist": artist,
        "url": image_url,
        "category": if category.is_empty() { "custom".to_string() } else { category.clone() },
        "isCustom": true,
        "type": if kind.is_empty() { "emoji".to_string() } else { kind.clone() },
        "source": "custom",
    });

    Ok(Json(json!({ "emoji": emoji })))
}

/// Minimal magic-byte sniffing for png/gif/jpg/webp so text payloads or
/// scripts cannot be stored under an image extension.
fn is_likely_image(data: &[u8]) -> bool {
    if data.len() < 12 {
        return false;
    }
    match data {
        [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, ..] => true,            // PNG
        [b'G', b'I', b'F', b'8', ..] => true,                                  // GIF
        [0xff, 0xd8, 0xff, ..] => true,                                        // JPEG
        [b'R', b'I', b'F', b'F', .., b'W', b'E', b'B', b'P'] => true,          // WEBP
        [b'V', b'P', b'8', ..] => true,                                        // WebP simple
        _ => false,
    }
}

/// Route registration for `/api/emoji`.
pub fn routes(state: Arc<AppState>) -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        .route("/upload", axum::routing::post(upload_emoji))
        .with_state(state)
}
