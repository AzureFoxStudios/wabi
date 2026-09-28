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
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use uuid::Uuid;

use wabidb::engine::wabi_store::WabiStore;

use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::upload_registry::UploadKind;

const MAX_EMOJI_BYTES: usize = 2 * 1024 * 1024;
// Serialize this route's existence check with its durable create. A second
// concurrent upload must not silently replace the first one's server asset.
static EMOTE_UPLOAD_GATE: Mutex<()> = Mutex::const_new(());

/// POST /api/emoji/upload
/// Multipart fields: `file`, `name`, `displayName`, `artist`, `category`, `type`.
/// Returns `{ emoji: { id, name, displayName, artist, url, category, isCustom, type, source } }`.
pub async fn upload_emoji(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<Value>> {
    if auth.is_guest {
        return Err(AppError::Forbidden("Guests cannot upload emojis".into()));
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
        .map_err(|e| AppError::BadRequest(format!("Invalid emoji upload: {e}")))?
    {
        match field.name().unwrap_or("") {
            "file" => {
                filename = field.file_name().unwrap_or("emoji.png").to_string();
                file_data = field
                    .bytes()
                    .await
                    .map_err(|e| AppError::BadRequest(format!("Invalid emoji file: {e}")))?
                    .to_vec();
            }
            "name" => {
                name = field
                    .text()
                    .await
                    .map_err(|e| AppError::BadRequest(e.to_string()))?
            }
            "displayName" => {
                display_name = field
                    .text()
                    .await
                    .map_err(|e| AppError::BadRequest(e.to_string()))?
            }
            "artist" => {
                artist = field
                    .text()
                    .await
                    .map_err(|e| AppError::BadRequest(e.to_string()))?
            }
            "category" => {
                category = field
                    .text()
                    .await
                    .map_err(|e| AppError::BadRequest(e.to_string()))?
            }
            "type" => {
                kind = field
                    .text()
                    .await
                    .map_err(|e| AppError::BadRequest(e.to_string()))?
            }
            _ => {}
        }
    }

    if file_data.is_empty() {
        return Err(AppError::BadRequest("No file data provided".into()));
    }
    if file_data.len() > MAX_EMOJI_BYTES {
        return Err(AppError::BadRequest("Emoji file exceeds 2MB limit".into()));
    }
    name = name.trim().to_string();
    display_name = display_name.trim().to_string();
    artist = artist.trim().to_string();
    category = category.trim().to_string();
    kind = kind.trim().to_string();
    validate_metadata(&name, &display_name, &artist, &category, &kind)?;

    // Use the sniffed format for the stored extension, not the supplied filename.
    let ext = image_extension(&file_data)
        .ok_or_else(|| AppError::BadRequest("Uploaded file is not a supported image".into()))?;

    // Keep the guarded publication owned by the server once it starts. If a
    // client disconnects after the durable command is queued, another upload
    // must still wait until that shortcode's committed state is visible.
    let create = tokio::spawn(async move {
        let _create_guard = EMOTE_UPLOAD_GATE.lock().await;
        if state
            .wdb
            .get_emotes()
            .await?
            .iter()
            .any(|emote| emote.name == name)
        {
            return Err(AppError::Conflict(format!(
                "Emoji shortcode :{name}: already exists. Choose another shortcode."
            )));
        }

        let uploads_dir = PathBuf::from(&state.config.uploads_dir);
        tokio::fs::create_dir_all(&uploads_dir).await?;

        let final_name = format!("{}{}", Uuid::new_v4(), ext);
        let final_path = uploads_dir.join(&final_name);

        let mut file = File::create(&final_path).await?;
        file.write_all(&file_data).await?;
        file.flush().await?;
        drop(file);

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
        let emotes = state.wdb.get_emotes().await?;
        if let Some(io) = state.socket_io() {
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
    });
    create
        .await
        .map_err(|error| AppError::Internal(format!("Emoji publication task failed: {error}")))?
}

fn validate_metadata(
    name: &str,
    display_name: &str,
    artist: &str,
    category: &str,
    kind: &str,
) -> Result<()> {
    if name.is_empty()
        || name.len() > 30
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(AppError::BadRequest(
            "Emoji shortcode must be 1–30 ASCII letters, numbers or underscores".into(),
        ));
    }
    for (label, value, limit) in [
        ("Display name", display_name, 60),
        ("Artist", artist, 60),
        ("Folder", category, 48),
    ] {
        if value.chars().count() > limit || value.chars().any(char::is_control) {
            return Err(AppError::BadRequest(format!(
                "{label} must be at most {limit} characters without control characters"
            )));
        }
    }
    if !matches!(kind, "" | "emoji" | "sticker") {
        return Err(AppError::BadRequest(
            "Asset type must be emoji or sticker".into(),
        ));
    }
    Ok(())
}

/// Minimal format sniffing; this does not claim to fully decode image content.
fn image_extension(data: &[u8]) -> Option<&'static str> {
    if data.len() < 12 {
        return None;
    }
    match data {
        [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, ..] => Some(".png"),
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => Some(".gif"),
        [0xff, 0xd8, 0xff, ..] => Some(".jpg"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some(".webp"),
        _ => None,
    }
}

/// Route registration for `/api/emoji`.
pub fn routes(state: Arc<AppState>) -> axum::Router<Arc<AppState>> {
    axum::Router::new()
        .route("/upload", axum::routing::post(upload_emoji))
        // The general file-upload route may permit much larger bodies. Keep
        // emoji files and metadata bounded before buffering multipart fields.
        .layer(axum::extract::DefaultBodyLimit::max(
            MAX_EMOJI_BYTES + 16 * 1024,
        ))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_webp_form_type_at_offset_eight_not_at_the_file_tail() {
        assert_eq!(
            image_extension(b"RIFF\x10\x00\x00\x00WEBPVP8Lpayload"),
            Some(".webp")
        );
        assert_eq!(image_extension(b"RIFFnot-an-imageWEBP"), None);
        assert_eq!(image_extension(b"VP8not-a-riff-container"), None);
        assert_eq!(image_extension(b"RIFF\x00\x00\x00\x00WEB"), None);
        assert_eq!(image_extension(b"\x89PNG\r\n\x1a\n"), None);
    }

    #[test]
    fn metadata_is_bounded_and_shortcodes_remain_parseable() {
        assert!(
            validate_metadata("tabi_Wave1", "Big wave", "Artist", "Reactions", "sticker").is_ok()
        );
        assert!(validate_metadata("wave", "", "", "", "").is_ok());
        for name in ["", "has space", "has:colon", "../path", "wave-hello", "💫"] {
            assert!(
                matches!(
                    validate_metadata(name, "", "", "", "emoji"),
                    Err(AppError::BadRequest(_))
                ),
                "{name}"
            );
        }
        assert!(validate_metadata(&"x".repeat(31), "", "", "", "emoji").is_err());
        assert!(validate_metadata("wave", &"é".repeat(60), "", "", "emoji").is_ok());
        assert!(validate_metadata("wave", &"x".repeat(61), "", "", "emoji").is_err());
        assert!(validate_metadata("wave", "", &"x".repeat(61), "", "emoji").is_err());
        assert!(validate_metadata("wave", "", "", &"x".repeat(49), "emoji").is_err());
        assert!(validate_metadata("wave", "line\nbreak", "", "", "emoji").is_err());
        assert!(validate_metadata("wave", "", "", "", "animated").is_err());
    }
}
