//! Bounded, account-authorized previews for the multi-server client's follows.
//! Follows are client preferences; this endpoint does not synchronize servers.
use std::sync::Arc;

use axum::{extract::State, Json, Router};
use serde::{Deserialize, Serialize};
use wabidb::{
    domain::{ChannelKind, Message},
    engine::wabi_store::WabiStore,
};

use crate::{
    auth_extractor::AuthUser,
    error::{AppError, Result},
    state::AppState,
};

const MAX_CHANNELS: usize = 24;
const MAX_DELTA: usize = 6;
const HISTORY_WINDOW: u64 = 100;

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/poll", axum::routing::post(poll))
        .with_state(state)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PollRequest {
    channels: Vec<ChannelRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChannelRequest {
    channel_id: String,
    after_message_id: Option<String>,
    limit: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PollResponse {
    success: bool,
    server_time: i64,
    channels: Vec<ChannelResult>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChannelResult {
    channel_id: String,
    channel_name: String,
    channel_type: &'static str,
    cursor_reset: bool,
    messages: Vec<serde_json::Value>,
}

fn channel_type(kind: ChannelKind) -> &'static str {
    match kind {
        ChannelKind::Text => "text",
        ChannelKind::Voice => "voice",
        ChannelKind::Dm => "dm",
        ChannelKind::GroupDm => "group",
        ChannelKind::Announcement => "announcement",
        ChannelKind::Whiteboard => "whiteboard",
        ChannelKind::Wiki => "wiki",
        ChannelKind::Forum => "forum",
        ChannelKind::Incident => "incident",
        ChannelKind::Gallery => "gallery",
        ChannelKind::Category => "category",
        ChannelKind::Lore => "lore",
        ChannelKind::Planning => "planning",
        ChannelKind::Reception => "reception",
    }
}

fn select_delta(
    messages: Vec<Message>,
    cursor: Option<&str>,
    limit: usize,
) -> (bool, Vec<Message>) {
    let take = limit.clamp(1, MAX_DELTA);
    let Some(cursor) = cursor.filter(|cursor| !cursor.is_empty()) else {
        return (
            true,
            messages
                .into_iter()
                .rev()
                .take(1)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect(),
        );
    };
    match messages
        .iter()
        .position(|message| message.message_id == cursor)
    {
        Some(position) => (
            false,
            messages.into_iter().skip(position + 1).take(take).collect(),
        ),
        None => (
            true,
            messages
                .into_iter()
                .rev()
                .take(1)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect(),
        ),
    }
}

async fn poll(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(request): Json<PollRequest>,
) -> Result<Json<PollResponse>> {
    if request.channels.len() > MAX_CHANNELS {
        return Err(AppError::BadRequest(
            "Too many followed channels in one poll".into(),
        ));
    }
    let mut channels = Vec::new();
    for requested in request.channels {
        if requested.channel_id.is_empty() || requested.channel_id.len() > 160 {
            continue;
        }
        // Recheck membership on every read. A revoked channel yields no data.
        let Ok(channel) =
            crate::channel_access::require_access(&state, auth.user_id, &requested.channel_id)
                .await
        else {
            continue;
        };
        let history = state
            .wdb
            .list_messages_typed(&requested.channel_id, HISTORY_WINDOW)
            .await?;
        let (cursor_reset, selected) = select_delta(
            history,
            requested.after_message_id.as_deref(),
            requested.limit.unwrap_or(1),
        );
        let mut messages = Vec::with_capacity(selected.len());
        for message in selected {
            let author = state
                .wdb
                .get_user(message.author_user_id)
                .await
                .ok()
                .flatten();
            let username = author
                .as_ref()
                .map(|user| user.username.clone())
                .unwrap_or_else(|| "Member".into());
            let text = if message.is_spoiler {
                "Spoiler message".to_string()
            } else if crate::api::e2ee::is_ciphertext(&message.content) {
                "Encrypted message".to_string()
            } else {
                message.content
            };
            messages.push(serde_json::json!({
                "id": message.message_id, "user": username,
                "userId": format!("user-{}", message.author_user_id),
                "text": text, "timestamp": message.created_at_micros / 1000,
                "type": message.message_type,
            }));
        }
        channels.push(ChannelResult {
            channel_id: requested.channel_id,
            channel_name: channel.name,
            channel_type: channel_type(channel.channel_kind),
            cursor_reset,
            messages,
        });
    }
    let server_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    Ok(Json(PollResponse {
        success: true,
        server_time,
        channels,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str) -> Message {
        Message {
            message_id: id.into(),
            channel_id: "channel".into(),
            author_user_id: 1,
            author_username: None,
            author_display_name: None,
            author_device_id: String::new(),
            content: id.into(),
            message_type: "text".into(),
            created_at_micros: 1,
            edited_at_micros: None,
            commit_seq: 1,
            is_deleted: false,
            is_spoiler: false,
            files: Vec::new(),
        }
    }

    #[test]
    fn cursor_returns_only_new_rows_and_unknown_cursor_bootstraps() {
        let rows = vec![message("a"), message("b"), message("c")];
        let (reset, selected) = select_delta(rows.clone(), Some("a"), 6);
        assert!(!reset);
        assert_eq!(
            selected
                .iter()
                .map(|row| row.message_id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "c"]
        );
        let (reset, selected) = select_delta(rows, Some("expired"), 6);
        assert!(reset);
        assert_eq!(selected[0].message_id, "c");
    }
}
