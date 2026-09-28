//! Shared notes in private conversations. Personal notebook data never enters
//! this store. A note body is either readable JSON chosen by its sender or a
//! signed E2EE room envelope; the latter is opaque to the Authority.

use axum::{extract::{Path, State}, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{path::PathBuf, sync::{Arc, Mutex, OnceLock}};

use crate::{auth_extractor::AuthUser, error::{AppError, Result}, state::AppState};

const MAX_NOTES_PER_ROOM: usize = 100;
const MAX_CONTENT_BYTES: usize = 64 * 1024;
const UNAVAILABLE: &str = "Shared notes could not be read. Changes are paused until the note store is restored.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationNote {
    pub id: String,
    pub channel_id: String,
    pub author_user_id: i64,
    pub content: String,
    pub encrypted: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub revision: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteStore {
    #[serde(default)]
    notes: Vec<ConversationNote>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteList { notes: Vec<ConversationNote> }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteInput { content: String, revision: Option<u64> }

#[derive(Deserialize)]
struct ClearNote { revision: u64 }

#[derive(Deserialize)]
struct ReadableNote { title: String, text: String }

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/{channel_id}", get(list_notes).post(create_note))
        .route("/{channel_id}/{note_id}", axum::routing::put(update_note).delete(delete_note))
        .with_state(state)
}

fn disk_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn store_path(data_dir: &str) -> PathBuf { PathBuf::from(data_dir).join("conversation_notes.json") }

fn read_unlocked(data_dir: &str) -> Result<NoteStore> {
    match std::fs::read(store_path(data_dir)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| AppError::Internal(UNAVAILABLE.into())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(NoteStore::default()),
        Err(_) => Err(AppError::Internal(UNAVAILABLE.into())),
    }
}

fn write_unlocked(data_dir: &str, data: &NoteStore) -> Result<()> {
    use std::io::Write;
    let path = store_path(data_dir);
    let parent = path.parent().ok_or_else(|| AppError::Internal(UNAVAILABLE.into()))?;
    std::fs::create_dir_all(parent).map_err(|_| AppError::Internal(UNAVAILABLE.into()))?;
    let bytes = serde_json::to_vec(data).map_err(|_| AppError::Internal(UNAVAILABLE.into()))?;
    let temporary = parent.join(format!(".conversation-notes-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(&temporary).map_err(|_| AppError::Internal(UNAVAILABLE.into()))?;
    let result = (|| -> std::io::Result<()> {
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &path)?;
        #[cfg(unix)] std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result.map_err(|_| AppError::Internal(UNAVAILABLE.into()))
}

fn read_store(data_dir: &str) -> Result<NoteStore> {
    let _guard = disk_lock().lock().unwrap_or_else(|poison| poison.into_inner());
    read_unlocked(data_dir)
}

fn mutate_store<T>(data_dir: &str, action: impl FnOnce(&mut NoteStore) -> Result<T>) -> Result<T> {
    let _guard = disk_lock().lock().unwrap_or_else(|poison| poison.into_inner());
    let mut data = read_unlocked(data_dir)?;
    let result = action(&mut data)?;
    write_unlocked(data_dir, &data)?;
    Ok(result)
}

async fn require_conversation(state: &AppState, user_id: i64, channel_id: &str) -> Result<()> {
    let channel = crate::channel_access::require_access(state, user_id, channel_id).await?;
    if !crate::channel_access::is_conversation(channel.channel_kind) {
        return Err(AppError::BadRequest("Shared notes belong to a DM or group conversation".into()));
    }
    Ok(())
}

async fn validate_content(state: &AppState, user_id: i64, channel_id: &str, content: &str) -> Result<bool> {
    if content.is_empty() || content.len() > MAX_CONTENT_BYTES {
        return Err(AppError::BadRequest("Shared note is empty or too large".into()));
    }
    let encrypted = crate::api::e2ee::validate_outbound_message(state, channel_id, user_id, content)
        .await.map_err(AppError::Forbidden)?;
    if !encrypted {
        let payload: ReadableNote = serde_json::from_str(content)
            .map_err(|_| AppError::BadRequest("Invalid shared note".into()))?;
        if payload.title.trim().is_empty() || payload.title.chars().count() > 120 || payload.text.chars().count() > 20_000 {
            return Err(AppError::BadRequest("Shared note title or body is too long".into()));
        }
    }
    Ok(encrypted)
}

async fn announce(state: &AppState, channel_id: &str, note_id: &str, change: &str) {
    if let Some(io) = state.socket_io() {
        let _ = io.to(channel_id.to_string()).emit("conversation-note-updated", &json!({
            "channelId": channel_id, "noteId": note_id, "change": change,
        })).await;
    }
}

async fn list_notes(State(state): State<Arc<AppState>>, auth: AuthUser, Path(channel_id): Path<String>) -> Result<Json<NoteList>> {
    let _membership = state.membership_gate.read().await;
    require_conversation(&state, auth.user_id, &channel_id).await?;
    let mut notes: Vec<_> = read_store(&state.config.data_dir)?.notes.into_iter()
        .filter(|note| note.channel_id == channel_id).collect();
    notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then_with(|| b.id.cmp(&a.id)));
    Ok(Json(NoteList { notes }))
}

async fn create_note(State(state): State<Arc<AppState>>, auth: AuthUser, Path(channel_id): Path<String>, Json(input): Json<NoteInput>) -> Result<Json<ConversationNote>> {
    let _membership = state.membership_gate.read().await;
    require_conversation(&state, auth.user_id, &channel_id).await?;
    let _policy = state.retention_policy_lock.lock().await;
    let encrypted = validate_content(&state, auth.user_id, &channel_id, &input.content).await?;
    let now = chrono::Utc::now().timestamp_millis();
    let note = ConversationNote {
        id: format!("note-{}", uuid::Uuid::new_v4()), channel_id: channel_id.clone(),
        author_user_id: auth.user_id, content: input.content, encrypted,
        created_at: now, updated_at: now, revision: 1,
    };
    mutate_store(&state.config.data_dir, |data| {
        if data.notes.iter().filter(|item| item.channel_id == channel_id).count() >= MAX_NOTES_PER_ROOM {
            return Err(AppError::BadRequest("This conversation has reached its shared note limit".into()));
        }
        data.notes.push(note.clone());
        Ok(())
    })?;
    drop(_policy);
    announce(&state, &channel_id, &note.id, "created").await;
    Ok(Json(note))
}

async fn update_note(State(state): State<Arc<AppState>>, auth: AuthUser, Path((channel_id, note_id)): Path<(String, String)>, Json(input): Json<NoteInput>) -> Result<Json<ConversationNote>> {
    let _membership = state.membership_gate.read().await;
    require_conversation(&state, auth.user_id, &channel_id).await?;
    let expected_revision = input.revision.ok_or_else(|| AppError::BadRequest("A note revision is required".into()))?;
    let _policy = state.retention_policy_lock.lock().await;
    let encrypted = validate_content(&state, auth.user_id, &channel_id, &input.content).await?;
    let note = mutate_store(&state.config.data_dir, |data| {
        let note = data.notes.iter_mut().find(|item| item.channel_id == channel_id && item.id == note_id)
            .ok_or_else(|| AppError::NotFound("Shared note not found".into()))?;
        if note.author_user_id != auth.user_id { return Err(AppError::Forbidden("Only the author can edit this shared note".into())); }
        if note.revision != expected_revision { return Err(AppError::Conflict("This note changed on another device. Reload it before editing.".into())); }
        note.content = input.content;
        note.encrypted = encrypted;
        note.updated_at = chrono::Utc::now().timestamp_millis();
        note.revision += 1;
        Ok(note.clone())
    })?;
    drop(_policy);
    announce(&state, &channel_id, &note.id, "updated").await;
    Ok(Json(note))
}

async fn delete_note(State(state): State<Arc<AppState>>, auth: AuthUser, Path((channel_id, note_id)): Path<(String, String)>, Json(input): Json<ClearNote>) -> Result<Json<serde_json::Value>> {
    let _membership = state.membership_gate.read().await;
    require_conversation(&state, auth.user_id, &channel_id).await?;
    mutate_store(&state.config.data_dir, |data| {
        let index = data.notes.iter().position(|item| item.channel_id == channel_id && item.id == note_id)
            .ok_or_else(|| AppError::NotFound("Shared note not found".into()))?;
        let note = &data.notes[index];
        if note.author_user_id != auth.user_id { return Err(AppError::Forbidden("Only the author can remove this shared note".into())); }
        if note.revision != input.revision { return Err(AppError::Conflict("This note changed on another device. Reload it before removing.".into())); }
        data.notes.remove(index);
        Ok(())
    })?;
    announce(&state, &channel_id, &note_id, "deleted").await;
    Ok(Json(json!({ "ok": true })))
}

/// Called only after the WDB channel deletion commits. A failed cleanup leaves
/// inaccessible orphan data for operator repair instead of restoring access.
pub(crate) fn remove_channel_notes(data_dir: &str, channel_id: &str) -> Result<()> {
    mutate_store(data_dir, |data| {
        data.notes.retain(|note| note.channel_id != channel_id);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_store_replays_and_fails_closed_on_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        let note = ConversationNote { id: "n1".into(), channel_id: "dm-1".into(), author_user_id: 1,
            content: r#"{"title":"Hello","text":"Shared"}"#.into(), encrypted: false,
            created_at: 1, updated_at: 1, revision: 1 };
        mutate_store(path, |data| { data.notes.push(note.clone()); Ok(()) }).unwrap();
        assert_eq!(read_store(path).unwrap().notes[0].content, note.content);
        std::fs::write(store_path(path), b"damaged").unwrap();
        assert!(read_store(path).is_err());
        assert!(mutate_store(path, |_| Ok(())).is_err());
        assert_eq!(std::fs::read(store_path(path)).unwrap(), b"damaged");
    }
}
