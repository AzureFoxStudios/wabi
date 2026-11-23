//! Bot account endpoints.
//!
//! Implements the generic bot platform primitive (no Hermes-specific code):
//! - POST /api/bot/create — owner-only, mints a bot account + opaque token
//! - POST /api/bot/rotate  — owner-only, rotates an existing bot's token
//! - POST /api/bot/disable — owner-only, revokes a bot token
//! - POST /api/bot/channel-access — owner-only, grants or removes one channel
//! - GET  /api/bot/channel-access?botUserId= — owner-only, lists a bot's channels
//! - POST /api/bot/unprompted — owner-only, allows untriggered posts in one channel
//! - GET  /api/bot/audit?botUserId= — owner-only, the bot's audit log
//!
//! Bot chat posts must reply (`replyTo`) to a recent message from a person in
//! the same channel that @-mentions the bot; see `crate::bot_policy`.
//!
//! A bot token is one credential per bot, but it reaches only the channels the
//! owner granted: bots cannot join channels themselves and never count as
//! admins (see `AppState::is_admin`).
//!
//! Bots authenticate with `Authorization: Bot <token>` (see auth_extractor).
//! The token is high-entropy and stored only as a hash in the bot registry.

use axum::{extract::State, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

use crate::auth_extractor::AuthUser;
use crate::bot_policy::AuditEvent;
use crate::error::{AppError, Result};
use crate::state::AppState;
use wabidb::engine::wabi_store::WabiStore;

/// The canonical username for the Hermes service bot.
/// Auto-registered on startup so cron / deliveries can emit as this bot.
pub const HERMES_BOT_USERNAME: &str = "hermes-bot";

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/create", axum::routing::post(handle_create))
        .route("/rotate", axum::routing::post(handle_rotate))
        .route("/disable", axum::routing::post(handle_disable))
        .route(
            "/project-access",
            axum::routing::post(handle_project_access),
        )
        .route(
            "/channel-access",
            axum::routing::get(handle_list_channel_access).post(handle_channel_access),
        )
        .route("/unprompted", axum::routing::post(handle_unprompted))
        .route("/audit", axum::routing::get(handle_audit))
        .route("/send-message", axum::routing::post(handle_send_message))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct BotCreateRequest {
    username: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BotCreateResponse {
    bot_user_id: u64,
    bot_token: String,
    username: String,
}

#[derive(Debug, Deserialize)]
struct BotUserRequest {
    #[serde(rename = "botUserId")]
    bot_user_id: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BotRotateResponse {
    bot_user_id: u64,
    bot_token: String,
}

/// Require that the authenticated user is the server owner.
async fn require_owner(state: &AppState, auth: &AuthUser) -> Result<()> {
    if auth.is_bot || !state.is_owner(auth.user_id).await {
        return Err(AppError::Forbidden(
            "Only the server owner can manage bots".into(),
        ));
    }
    Ok(())
}

/// POST /api/bot/create — create a bot account and mint its first token.
async fn handle_create(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<BotCreateRequest>,
) -> Result<Json<BotCreateResponse>> {
    require_owner(&state, &auth).await?;

    let username = req.username.trim().to_string();
    if username.is_empty() {
        return Err(AppError::BadRequest("Bot username cannot be empty".into()));
    }
    if state.wdb.get_user_by_username(&username).await?.is_some() {
        return Err(AppError::BadRequest("Username already taken".into()));
    }

    // Bots have no password: store a random bcrypt hash so password login
    // always fails and the account can never be used as a human login.
    let dummy_password = bcrypt::hash(&uuid::Uuid::new_v4().to_string(), bcrypt::DEFAULT_COST)?;
    state
        .owner_bot_operation(auth, move |state| async move {
            let user_id = state
                .wdb
                .create_user(&username, Some(&username.to_lowercase()), &dummy_password)
                .await?;
            let (bot_token, _record) = state.bot_registry.create(user_id).await?;
            Ok(Json(BotCreateResponse {
                bot_user_id: user_id,
                bot_token,
                username,
            }))
        })
        .await
}

/// POST /api/bot/rotate — invalidate a bot's current token and mint a new one.
async fn handle_rotate(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<BotUserRequest>,
) -> Result<Json<BotRotateResponse>> {
    require_owner(&state, &auth).await?;
    let actor = auth.user_id;
    let bot_user_id = req.bot_user_id;

    let result = state
        .owner_bot_operation(auth, move |state| async move {
            let bot_token = state
                .bot_registry
                .rotate(req.bot_user_id)
                .await?
                .ok_or_else(|| AppError::NotFound(format!("Bot {} not found", req.bot_user_id)))?;
            Ok(Json(BotRotateResponse {
                bot_user_id: req.bot_user_id,
                bot_token,
            }))
        })
        .await;
    if result.is_ok() {
        state.bot_policy.record(AuditEvent::new(bot_user_id, "token_rotated").actor(actor)).await;
    }
    result
}

/// POST /api/bot/disable — revoke a bot's token and disable the account.
async fn handle_disable(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<BotUserRequest>,
) -> Result<Json<serde_json::Value>> {
    require_owner(&state, &auth).await?;
    let actor = auth.user_id;
    let bot_user_id = req.bot_user_id;

    let result = state
        .owner_bot_operation(auth, move |state| async move {
            if !state.bot_registry.disable(req.bot_user_id).await? {
                return Err(AppError::NotFound(format!(
                    "Bot {} not found",
                    req.bot_user_id
                )));
            }
            Ok(Json(
                json!({ "success": true, "botUserId": req.bot_user_id }),
            ))
        })
        .await;
    if result.is_ok() {
        state.bot_policy.record(AuditEvent::new(bot_user_id, "disabled").actor(actor)).await;
    }
    result
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotProjectAccessRequest {
    bot_user_id: u64,
    channel_id: String,
    allow: bool,
}

/// POST /api/bot/project-access — owner-controlled admission to one Project.
async fn handle_project_access(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<BotProjectAccessRequest>,
) -> Result<Json<serde_json::Value>> {
    set_bot_channel_access(state, auth, req, true).await
}

/// POST /api/bot/channel-access — owner-controlled admission to any ordinary
/// channel. Bots cannot join channels themselves, so this is the only way a
/// bot gains a channel. DMs and groups are refused: their membership belongs
/// to the people in them, not to the server owner.
async fn handle_channel_access(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<BotProjectAccessRequest>,
) -> Result<Json<serde_json::Value>> {
    set_bot_channel_access(state, auth, req, false).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotChannelListQuery {
    bot_user_id: u64,
}

/// GET /api/bot/channel-access?botUserId= — every channel a bot is a member
/// of, so an owner can review (and revoke) a bot's reach, including channels
/// it joined itself before bots needed a grant.
async fn handle_list_channel_access(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    axum::extract::Query(query): axum::extract::Query<BotChannelListQuery>,
) -> Result<Json<serde_json::Value>> {
    require_owner(&state, &auth).await?;
    if !state.bot_registry.is_bot(query.bot_user_id).await {
        return Err(AppError::NotFound("Bot not found".into()));
    }
    let unprompted = state.bot_policy.unprompted_channels(query.bot_user_id).await;
    let channels: Vec<serde_json::Value> = state
        .wdb
        .list_channels(Some(query.bot_user_id))
        .await?
        .into_iter()
        .map(|channel| json!({
            "unprompted": unprompted.contains(&channel.channel_id),
            "channelId": channel.channel_id,
            "name": channel.name,
            "kind": channel.channel_kind,
        }))
        .collect();
    Ok(Json(json!({ "botUserId": query.bot_user_id, "channels": channels })))
}

async fn set_bot_channel_access(
    state: Arc<AppState>,
    auth: AuthUser,
    req: BotProjectAccessRequest,
    projects_only: bool,
) -> Result<Json<serde_json::Value>> {
    require_owner(&state, &auth).await?;
    let actor = auth.user_id;
    let (bot_user_id, channel_id, allow) = (req.bot_user_id, req.channel_id.clone(), req.allow);
    // Serialize admission changes with in-flight channel, Project and wiki
    // writes, so a removed bot cannot commit after revocation completes.
    let membership = state.membership_gate.clone().write_owned().await;
    let result = state.owner_bot_operation(auth, move |state| async move {
    let _membership = membership;
    if !state.bot_registry.is_bot(req.bot_user_id).await {
        return Err(AppError::NotFound("Bot not found".into()));
    }
    let channel = state.wdb.get_channel(&req.channel_id).await?
        .ok_or_else(|| AppError::NotFound(if projects_only { "Project channel not found" } else { "Channel not found" }.into()))?;
    if projects_only && !matches!(channel.channel_kind, wabidb::domain::ChannelKind::Planning | wabidb::domain::ChannelKind::Lore) {
        return Err(AppError::BadRequest("Bot project access requires a Planning or Project channel".into()));
    }
    if crate::channel_access::is_conversation(channel.channel_kind) {
        return Err(AppError::BadRequest("Bots cannot be granted DMs or groups; their members decide who joins".into()));
    }
    let member = crate::channel_access::is_member(&state, req.bot_user_id as i64, &req.channel_id).await?;
    if req.allow && !member {
        state.wdb.add_channel_member(&req.channel_id, req.bot_user_id, wabidb::domain::MemberRole::Member).await?;
    } else if !req.allow && member {
        state.wdb.remove_channel_member(&req.channel_id, req.bot_user_id).await?;
    }
    if !req.allow {
        // A later re-grant starts trigger-only again.
        state.bot_policy.set_unprompted(req.bot_user_id, &req.channel_id, false).await
            .map_err(|error| AppError::Internal(format!("bot post policy: {error}")))?;
    }
    Ok(Json(json!({ "botUserId": req.bot_user_id, "channelId": req.channel_id, "allowed": req.allow })))
    }).await;
    if result.is_ok() {
        let event = if allow { "channel_granted" } else { "channel_revoked" };
        state.bot_policy.record(AuditEvent::new(bot_user_id, event).channel(&channel_id).actor(actor)).await;
    }
    result
}

/// POST /api/bot/unprompted — owner allows (or stops allowing) one bot to post
/// in one granted channel without a trigger, e.g. for scheduled summaries.
async fn handle_unprompted(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<BotProjectAccessRequest>,
) -> Result<Json<serde_json::Value>> {
    require_owner(&state, &auth).await?;
    let actor = auth.user_id;
    if !state.bot_registry.is_bot(req.bot_user_id).await {
        return Err(AppError::NotFound("Bot not found".into()));
    }
    if req.allow && !crate::channel_access::is_member(&state, req.bot_user_id as i64, &req.channel_id).await? {
        return Err(AppError::BadRequest("Grant the bot this channel before allowing unprompted posts".into()));
    }
    state
        .bot_policy
        .set_unprompted(req.bot_user_id, &req.channel_id, req.allow)
        .await
        .map_err(|error| AppError::Internal(format!("bot post policy: {error}")))?;
    let event = if req.allow { "unprompted_allowed" } else { "unprompted_removed" };
    state
        .bot_policy
        .record(AuditEvent::new(req.bot_user_id, event).channel(&req.channel_id).actor(actor))
        .await;
    Ok(Json(json!({ "botUserId": req.bot_user_id, "channelId": req.channel_id, "unprompted": req.allow })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BotAuditQuery {
    bot_user_id: u64,
    #[serde(default)]
    limit: Option<usize>,
}

/// GET /api/bot/audit?botUserId=&limit= — owner-only: the newest audit
/// entries for one bot (default 100, at most 1000), oldest first.
async fn handle_audit(
    State(state): State<Arc<AppState>>,
    auth: AuthUser,
    axum::extract::Query(query): axum::extract::Query<BotAuditQuery>,
) -> Result<Json<serde_json::Value>> {
    require_owner(&state, &auth).await?;
    if !state.bot_registry.is_bot(query.bot_user_id).await {
        return Err(AppError::NotFound("Bot not found".into()));
    }
    let entries = state
        .bot_policy
        .read_audit(query.bot_user_id, query.limit.unwrap_or(100))
        .await
        .map_err(|error| AppError::Internal(format!("bot audit: {error}")))?;
    Ok(Json(json!({ "botUserId": query.bot_user_id, "entries": entries })))
}

/// POST /api/bot/send-message — send a message as the authenticated bot.
///
/// Accepts `Bot <token>` auth (resolved by AuthUser's extractor). Writes the
/// message to WDB via the same path as REST /api/messages, then broadcasts it
/// over the live Socket.IO layer so connected clients receive it in real
/// time, and fires webhook delivery (H1b).
async fn handle_send_message(
    state: State<Arc<AppState>>,
    auth: AuthUser,
    Json(req): Json<BotSendMessageRequest>,
) -> Result<Json<BotSendMessageResponse>> {
    if !auth.is_bot {
        return Err(AppError::Forbidden(
            "Only bot accounts can use /api/bot/send-message".into(),
        ));
    }
    let sender_id = auth.user_id as u64;
    let sender_username = auth.username.clone();

    // Reuse the same WDB write path as REST /api/messages.
    let retention_guard = state.retention_policy_lock.lock().await;
    if let Err(error) = authorize_bot_post(&state, &auth, &req).await {
        drop(retention_guard);
        state
            .bot_policy
            .record(
                AuditEvent::new(sender_id, "post_refused")
                    .channel(&req.channel_id)
                    .reply_to(req.reply_to.as_deref())
                    .reason(&error.to_string()),
            )
            .await;
        return Err(error);
    }
    let created_at_micros = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0);

    let channel_force_spoiler = state
        .wdb
        .get_channel(&req.channel_id)
        .await
        .ok()
        .flatten()
        .map(|c| c.force_spoiler)
        .unwrap_or(false);
    let is_spoiler = req.is_spoiler || channel_force_spoiler;

    let message_id = state
        .wdb
        .send_message(&req.channel_id, sender_id, &req.content, is_spoiler, &[])
        .await?;
    drop(retention_guard);
    state
        .bot_policy
        .record(
            AuditEvent::new(sender_id, "post")
                .channel(&req.channel_id)
                .message(&message_id)
                .reply_to(req.reply_to.as_deref()),
        )
        .await;

    let message_view = json!({
        "id": message_id.clone(),
        "user": sender_username,
        "userId": format!("user-{}", sender_id),
        "senderStableId": format!("user-{}", sender_id),
        "text": req.content,
        "timestamp": created_at_micros / 1000,
        "bornAt": created_at_micros / 1000,
        "type": req.message_type.clone().unwrap_or_else(|| "text".into()),
        "isBot": true,
    });

    // Broadcast to all connected socket clients in the channel.
    let msg_payload = json!({
        "channelId": &req.channel_id,
        "message": message_view,
    });
    if let Some(io) = state.socket_io() {
        let ch = req.channel_id.clone();
        let payload = msg_payload.clone();
        tokio::spawn(async move {
            let _ = io.to(ch).emit("message", &payload).await;
        });
    }

    // H1b: fire webhook delivery for this message.
    crate::bot_delivery::spawn_message_created_delivery(
        state.wdb.clone(),
        req.channel_id.clone(),
        crate::bot_delivery::MessageCreatedPayload {
            channel_id: req.channel_id.clone(),
            message_id: message_id.clone(),
            content: req.content.clone(),
            author: sender_username.clone(),
            timestamp: created_at_micros / 1000,
        },
    );

    Ok(Json(BotSendMessageResponse {
        message_id,
        channel_id: req.channel_id,
        content: req.content,
        username: sender_username,
        is_bot: true,
    }))
}

/// Ensure the Hermes service bot exists and return its token.
/// Called once on startup; idempotent if the bot already exists.
pub async fn ensure_hermes_bot(state: &AppState) -> Result<String> {
    // Check if a bot with username "hermes-bot" already exists.
    if let Ok(Some(user)) = state.wdb.get_user_by_username(HERMES_BOT_USERNAME).await {
        // Verify it's registered as a bot in the registry; if not, re-create
        // the token record.
        if state.bot_registry.is_bot(user.user_id).await {
            // Token is one-shot at creation; store in memory for internal use.
            // The token is never exposed via API — only the server process uses it.
            tracing::info!(
                "[bot:hermes] bot account already exists (id={})",
                user.user_id
            );
            return Ok(format!("user-{}", user.user_id));
        }
    }
    // No existing bot — create one via the registry.
    let dummy_password = bcrypt::hash(&uuid::Uuid::new_v4().to_string(), bcrypt::DEFAULT_COST)
        .map_err(|e| AppError::Internal(format!("bcrypt error: {e}")))?;
    let user_id = state
        .wdb
        .create_user(
            HERMES_BOT_USERNAME,
            Some(&HERMES_BOT_USERNAME.to_lowercase()),
            &dummy_password,
        )
        .await
        .map_err(|e| AppError::Internal(format!("create_user failed: {e}")))?;
    let (_token, _) = state.bot_registry.create(user_id).await?;
    tracing::info!(
        "[bot:hermes] registered hermes-bot account (id={})",
        user_id
    );
    Ok(format!("user-{}", user_id))
}

/// Every check a bot post must pass before it is stored: channel access,
/// moderation, encryption, retention mode, and the trigger rule.
async fn authorize_bot_post(state: &AppState, auth: &AuthUser, req: &BotSendMessageRequest) -> Result<()> {
    crate::channel_access::require_participation(state, auth.user_id, &req.channel_id).await?;
    let blacklist = state
        .get_blacklist()
        .await
        .ok_or_else(|| AppError::Internal("Channel restriction enforcement unavailable".into()))?;
    if blacklist
        .is_channel_timed_out(&req.channel_id, auth.user_id)
        .await
        .is_some()
    {
        return Err(AppError::Forbidden(
            "Bot is timed out in this channel".into(),
        ));
    }
    crate::api::e2ee::require_bot_post_allowed(state, &req.channel_id).await?;
    if state
        .channel_auto_delete_label
        .read()
        .await
        .get(&req.channel_id)
        .is_some_and(|label| label == "live")
    {
        return Err(AppError::BadRequest(
            "Bot sends are unavailable in Live rooms because this endpoint stores messages".into(),
        ));
    }
    require_trigger(state, auth.user_id as u64, &req.channel_id, req.reply_to.as_deref()).await
}

/// A bot may post only in reply to a recent message from a person, in the
/// same channel, that @-mentions the bot, unless the owner allowed
/// unprompted posts for this bot in this channel. Text the bot read in one
/// channel therefore cannot make it post anywhere a person did not call it.
async fn require_trigger(state: &AppState, bot_user_id: u64, channel_id: &str, reply_to: Option<&str>) -> Result<()> {
    if state.bot_policy.allows_unprompted(bot_user_id, channel_id).await {
        return Ok(());
    }
    let refuse = |reason: &str| Err(AppError::Forbidden(reason.into()));
    let Some(reply_to) = reply_to.filter(|id| !id.is_empty()) else {
        return refuse("Bot posts must reply (replyTo) to a recent message that @-mentions the bot");
    };
    // Missing and other-channel triggers get the same answer, so a bot cannot
    // probe which message IDs exist elsewhere.
    let Some(trigger) = state
        .wdb
        .get_message_typed(reply_to)
        .await?
        .filter(|message| !message.is_deleted && message.channel_id == channel_id)
    else {
        return refuse("The trigger message is not in this channel");
    };
    if trigger.author_user_id == bot_user_id || state.bot_registry.is_bot(trigger.author_user_id).await {
        return refuse("Only a person's message can trigger a bot post");
    }
    let age = crate::bot_policy::now_micros() - trigger.created_at_micros;
    if age > crate::bot_policy::TRIGGER_MAX_AGE_MICROS {
        return refuse("The trigger message is too old (15 minute limit)");
    }
    let bot = state
        .wdb
        .get_user(bot_user_id)
        .await?
        .ok_or_else(|| AppError::Forbidden("Bot account is unavailable".into()))?;
    let mentioned = crate::bot_policy::mentions(&trigger.content, &bot.username)
        || bot
            .handle
            .as_deref()
            .is_some_and(|handle| crate::bot_policy::mentions(&trigger.content, handle));
    if !mentioned {
        return refuse("The trigger message does not @-mention this bot");
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct BotSendMessageRequest {
    channel_id: String,
    content: String,
    message_type: Option<String>,
    #[serde(default)]
    is_spoiler: bool,
    /// The message this post answers: a recent message from a person in the
    /// same channel that @-mentions the bot.
    #[serde(default, alias = "replyTo")]
    reply_to: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BotSendMessageResponse {
    message_id: String,
    channel_id: String,
    content: String,
    username: String,
    is_bot: bool,
}
