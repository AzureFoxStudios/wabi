//! Server-local friend requests and accepted relationships.
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use wabidb::{
    domain::User,
    engine::wabi_store::WabiStore,
    projections::friends::{FriendRelationship, FriendState},
};

use crate::{
    auth_extractor::AuthUser,
    error::{AppError, Result},
    state::AppState,
};

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/", axum::routing::get(list))
        .route("/requests", axum::routing::post(request))
        .route("/requests/{id}/accept", axum::routing::post(accept))
        .route("/requests/{id}", axum::routing::delete(cancel_or_decline))
        .route("/{user_id}", axum::routing::delete(remove))
        .layer(axum::middleware::from_fn(super::games::no_store))
        .with_state(state)
}

async fn account(state: &AppState, auth: &AuthUser) -> Result<u64> {
    if auth.user_id <= 0 || auth.is_guest || auth.is_bot {
        return Err(AppError::Forbidden(
            "A registered personal account is required".into(),
        ));
    }
    let user_id = auth.user_id as u64;
    match state.wdb.get_user(user_id).await? {
        Some(user) if user.is_active && !user.password_hash.is_empty() => {
            if state.is_bot_user(user_id).await {
                Err(AppError::Forbidden("A registered personal account is required".into()))
            } else {
                Ok(user_id)
            }
        }
        _ => Err(AppError::Unauthorized("Account unavailable".into())),
    }
}

fn visible_user(user: User) -> FriendUser {
    FriendUser {
        user_id: user.user_id,
        username: user.username,
        handle: user.handle,
        profile_picture: user.profile_picture,
        color: user.color,
        status: None,
    }
}

async fn active_target(state: &AppState, user_id: u64) -> Result<User> {
    if user_id == 0 {
        return Err(AppError::BadRequest("Choose a member".into()));
    }
    let user = state
        .wdb
        .get_user(user_id)
        .await?
        .filter(|user| user.is_active && !user.password_hash.is_empty())
        .ok_or_else(|| AppError::NotFound("Registered member not found".into()))?;
    if state.is_bot_user(user_id).await {
        return Err(AppError::NotFound("Registered member not found".into()));
    }
    Ok(user)
}

#[derive(Serialize)]
struct FriendUser {
    user_id: u64,
    username: String,
    handle: Option<String>,
    profile_picture: Option<String>,
    color: String,
    status: Option<String>,
}

#[derive(Serialize)]
struct FriendRequest {
    id: String,
    #[serde(flatten)]
    user: FriendUser,
    created_at: i64,
}

#[derive(Serialize)]
struct FriendList {
    friends: Vec<FriendUser>,
    incoming: Vec<FriendRequest>,
    outgoing: Vec<FriendRequest>,
}

async fn list(auth: AuthUser, State(state): State<Arc<AppState>>) -> Result<Json<FriendList>> {
    let user_id = account(&state, &auth).await?;
    let mut friends = Vec::new();
    let mut incoming = Vec::new();
    let mut outgoing = Vec::new();
    for row in state.wdb.list_friend_relationships(user_id).await? {
        let Some(other_id) = row.other(user_id) else {
            continue;
        };
        let user = match active_target(&state, other_id).await {
            Ok(user) => user,
            Err(AppError::NotFound(_)) => continue,
            Err(error) => return Err(error),
        };
        let person = visible_user(user);
        match row.state {
            FriendState::Friends => friends.push(person),
            FriendState::Pending => {
                let item = FriendRequest {
                    id: row.id(),
                    user: person,
                    created_at: row.created_at_micros / 1000,
                };
                if row.requested_by == user_id {
                    outgoing.push(item);
                } else {
                    incoming.push(item);
                }
            }
            FriendState::Removed => {}
        }
    }
    friends.sort_by(|a, b| {
        a.username
            .to_lowercase()
            .cmp(&b.username.to_lowercase())
            .then(a.user_id.cmp(&b.user_id))
    });
    incoming.sort_by_key(|r| r.created_at);
    outgoing.sort_by_key(|r| r.created_at);
    Ok(Json(FriendList {
        friends,
        incoming,
        outgoing,
    }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RequestBody {
    user_id: u64,
}

async fn notify(state: &AppState, a: u64, b: u64) {
    if let Some(io) = state.socket_io() {
        for user_id in [a, b] {
            if let Err(error) = io
                .to(format!("user-{user_id}"))
                .emit("friends-updated", &json!({"userId": user_id}))
                .await
            {
                tracing::warn!(%user_id, %error, "friend update notification failed");
            }
        }
    }
}

async fn request(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Json(body): Json<RequestBody>,
) -> Result<Json<serde_json::Value>> {
    let actor = account(&state, &auth).await?;
    if actor == body.user_id {
        return Err(AppError::BadRequest("You cannot add yourself".into()));
    }
    active_target(&state, body.user_id).await?;
    let _gate = state.membership_gate.clone().write_owned().await;
    match state
        .wdb
        .get_friend_relationship(actor, body.user_id)
        .await?
    {
        Some(row)
            if row.state == FriendState::Friends
                || (row.state == FriendState::Pending && row.requested_by == actor) =>
        {
            return Ok(Json(json!({"ok":true})));
        }
        Some(_) => {
            return Err(AppError::Conflict(
                "This member sent you a request. Accept it from your incoming requests.".into(),
            ))
        }
        None => {}
    }
    let row = FriendRelationship::new(
        actor,
        body.user_id,
        actor,
        FriendState::Pending,
        chrono::Utc::now().timestamp_micros(),
    );
    state.wdb.save_friend_relationship(actor, &row).await?;
    drop(_gate);
    notify(&state, actor, body.user_id).await;
    Ok(Json(json!({"ok":true})))
}

async fn find_request(state: &AppState, actor: u64, id: &str) -> Result<FriendRelationship> {
    state
        .wdb
        .list_friend_relationships(actor)
        .await?
        .into_iter()
        .find(|row| row.id() == id && row.state == FriendState::Pending)
        .ok_or_else(|| AppError::NotFound("Friend request not found".into()))
}

async fn accept(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let actor = account(&state, &auth).await?;
    let _gate = state.membership_gate.clone().write_owned().await;
    let mut row = find_request(&state, actor, &id).await?;
    if row.requested_by == actor {
        return Err(AppError::Forbidden(
            "Only the recipient can accept this request".into(),
        ));
    }
    let other = row.other(actor).unwrap();
    active_target(&state, other).await?;
    row.state = FriendState::Friends;
    state.wdb.save_friend_relationship(actor, &row).await?;
    drop(_gate);
    notify(&state, actor, other).await;
    Ok(Json(json!({"ok":true})))
}

async fn cancel_or_decline(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>> {
    let actor = account(&state, &auth).await?;
    let _gate = state.membership_gate.clone().write_owned().await;
    let mut row = find_request(&state, actor, &id).await?;
    let other = row.other(actor).unwrap();
    row.state = FriendState::Removed;
    state.wdb.save_friend_relationship(actor, &row).await?;
    drop(_gate);
    notify(&state, actor, other).await;
    Ok(Json(json!({"ok":true})))
}

async fn remove(
    auth: AuthUser,
    State(state): State<Arc<AppState>>,
    Path(other): Path<u64>,
) -> Result<Json<serde_json::Value>> {
    let actor = account(&state, &auth).await?;
    if actor == other || other == 0 {
        return Err(AppError::BadRequest("Choose a friend".into()));
    }
    let _gate = state.membership_gate.clone().write_owned().await;
    let mut row = state
        .wdb
        .get_friend_relationship(actor, other)
        .await?
        .filter(|row| row.state == FriendState::Friends)
        .ok_or_else(|| AppError::NotFound("Friendship not found".into()))?;
    row.state = FriendState::Removed;
    state.wdb.save_friend_relationship(actor, &row).await?;
    drop(_gate);
    notify(&state, actor, other).await;
    Ok(Json(json!({"ok":true})))
}
