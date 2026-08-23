//! Steam addon endpoints (opt-in).
//!
//! Implements the Steam integration from docs/steam-integration-proposal.md:
//! - GET /api/steam/status        — current user game status (GetPlayerSummaries)
//! - GET /api/steam/rich-presence — same lookup + any rich-presence context
//!
//! Privacy-first: the feature is entirely opt-in. Without a `STEAM_API_KEY`
//! configured on the server, both endpoints return 404 with a graceful,
//! machine-readable message instead of crashing. Results are cached
//! server-side for 60s to stay well within Steam's GetPlayerSummaries rate
//! limits (~100k calls/day per key).

use axum::{
    extract::{Query, State},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::auth_extractor::AuthUser;
use crate::error::{AppError, Result};
use crate::state::AppState;

/// GetPlayerSummaries endpoint.
const STEAM_API_URL: &str = "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/";

/// Server-side cache TTL for a single steam id.
const CACHE_TTL: Duration = Duration::from_secs(60);

/// HTTP client timeout for the upstream Steam API call.
const STEAM_FETCH_TIMEOUT: Duration = Duration::from_secs(8);

/// Shared reqwest client for upstream Steam fetches. Built once at AppState
/// construction; the per-request timeout is applied on each RequestBuilder so
/// cache misses reuse one connection pool instead of paying a fresh client
/// build + TLS handshake every time.
pub type SharedHttpClient = Arc<reqwest::Client>;

/// Build the shared Steam fetch client.
pub fn shared_http_client() -> SharedHttpClient {
    Arc::new(
        reqwest::Client::builder()
            .timeout(STEAM_FETCH_TIMEOUT)
            .build()
            .unwrap_or_default(),
    )
}

pub fn routes(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        .route("/status", axum::routing::get(handle_status))
        .route("/rich-presence", axum::routing::get(handle_rich_presence))
        .with_state(state)
}

/// Query parameters for both endpoints. The caller supplies the Steam id they
/// want the status for (`steamId`, or the plural `steamids` alias used by the
/// Steam API itself).
#[derive(Debug, Deserialize)]
pub struct SteamQuery {
    steam_id: Option<String>,
    #[serde(rename = "steamids")]
    steamids: Option<String>,
}

impl SteamQuery {
    fn steam_id(&self) -> Option<&str> {
        self.steam_id
            .as_deref()
            .or(self.steamids.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }
}

/// Per-steamid cache entry. `data` is None when the player is unknown/private.
#[derive(Clone)]
struct CacheEntry {
    fetched_at: Instant,
    data: Option<SteamStatus>,
}

/// In-memory cache shared across requests. Guarded by a Mutex so handlers take
/// `&AppState` and mutate interior state without ever needing `&mut`.
#[derive(Default)]
pub struct SteamCache {
    entries: HashMap<String, CacheEntry>,
}

impl SteamCache {
    /// Returns the cached status if it is fresh, without hitting the network.
    fn get_fresh(&self, steam_id: &str) -> Option<Option<SteamStatus>> {
        self.entries.get(steam_id).and_then(|entry| {
            if entry.fetched_at.elapsed() < CACHE_TTL {
                Some(entry.data.clone())
            } else {
                None
            }
        })
    }

    fn insert(&mut self, steam_id: String, data: Option<SteamStatus>) {
        self.entries.insert(
            steam_id,
            CacheEntry {
                fetched_at: Instant::now(),
                data,
            },
        );
    }
}

/// Player status derived from GetPlayerSummaries.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SteamStatus {
    /// 64-bit Steam account id.
    pub steam_id: String,
    /// Display name on Steam (persona name).
    pub persona_name: String,
    pub profile_url: String,
    pub avatar: String,
    /// True when the player is currently in a game and it is public.
    pub in_game: bool,
    /// AppId of the currently running game, if any.
    pub game_id: Option<String>,
    /// Human-readable game name, if any.
    pub game_name: Option<String>,
    /// Unix seconds of the last successful upstream refresh.
    pub updated_at: i64,
    /// Optional rich-presence context (only populated by /rich-presence).
    pub rich_presence: Option<String>,
}

/// Response for /api/steam/status.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusResponse {
    /// Whether the Steam addon is configured (STEAM_API_KEY present).
    enabled: bool,
    /// Null when the player is not in-game, unknown, or has a private profile.
    status: Option<SteamStatus>,
}

/// Response for /api/steam/rich-presence — the same shape as /status.
type RichPresenceResponse = StatusResponse;

/// Resolve the STEAM_API_KEY from the environment. No key => feature disabled.
fn steam_api_key() -> Option<String> {
    std::env::var("STEAM_API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// GET /api/steam/status
async fn handle_status(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    Query(query): Query<SteamQuery>,
) -> Result<Json<StatusResponse>> {
    let status = fetch_status(&state, query.steam_id(), false).await?;
    Ok(Json(StatusResponse {
        enabled: status.0,
        status: status.1,
    }))
}

/// GET /api/steam/rich-presence
async fn handle_rich_presence(
    State(state): State<Arc<AppState>>,
    _auth: AuthUser,
    Query(query): Query<SteamQuery>,
) -> Result<Json<RichPresenceResponse>> {
    let status = fetch_status(&state, query.steam_id(), true).await?;
    Ok(Json(StatusResponse {
        enabled: status.0,
        status: status.1,
    }))
}

/// Shared fetch path. Returns (enabled, status).
async fn fetch_status(
    state: &AppState,
    steam_id: Option<&str>,
    with_rich_presence: bool,
) -> Result<(bool, Option<SteamStatus>)> {
    let Some(key) = steam_api_key() else {
        // Feature is opt-in: no key configured, degrade gracefully to 404.
        return Err(AppError::NotFound(
            "Steam addon is not configured (STEAM_API_KEY unset)".into(),
        ));
    };

    let Some(steam_id) = steam_id else {
        return Err(AppError::BadRequest(
            "Missing steamId query parameter".into(),
        ));
    };

    // Fast path: fresh cache hit. The lock is only held for the HashMap
    // lookup, never across the upstream network call.
    {
        let cache = state.steam_cache.lock().await;
        if let Some(cached) = cache.get_fresh(steam_id) {
            return Ok((true, cached));
        }
    }

    let client = &state.steam_http;

    let response = client
        .get(STEAM_API_URL)
        .timeout(STEAM_FETCH_TIMEOUT)
        .query(&[("key", key.as_str()), ("steamids", steam_id)])
        .send()
        .await?;

    // Non-2xx from Steam is not a fatal server error — surface as a graceful
    // empty status so the frontend can show "unavailable" instead of crashing.
    if !response.status().is_success() {
        let mut cache = state.steam_cache.lock().await;
        cache.insert(steam_id.to_string(), None);
        return Ok((true, None));
    }

    let mut status = parse_players(&response.json::<serde_json::Value>().await?, steam_id)?;

    // The Web API exposes rich presence via the in-game `gameextrainfo` and,
    // when available, a top-level `richpresence` field on the player row.
    if with_rich_presence {
        status.rich_presence = status.rich_presence.take().filter(|s| !s.trim().is_empty());
    } else {
        status.rich_presence = None;
    }

    {
        let mut cache = state.steam_cache.lock().await;
        cache.insert(steam_id.to_string(), Some(status.clone()));
    }
    Ok((true, Some(status)))
}

/// Map the GetPlayerSummaries `response.players[0]` row onto `SteamStatus`.
/// Returns an empty (not in game) status when the id is unknown/private.
fn parse_players(body: &serde_json::Value, steam_id: &str) -> Result<SteamStatus> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let player = body
        .get("response")
        .and_then(|r| r.get("players"))
        .and_then(|p| p.as_array())
        .and_then(|players| players.first())
        .cloned();

    let Some(player) = player else {
        // Steam returns an empty players array for unknown ids. Treat as an
        // "online but not sharing anything" player.
        return Ok(SteamStatus {
            steam_id: steam_id.to_string(),
            persona_name: String::new(),
            profile_url: String::new(),
            avatar: String::new(),
            in_game: false,
            game_id: None,
            game_name: None,
            updated_at: now,
            rich_presence: None,
        });
    };

    let game_id = player
        .get("gameid")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let game_name = player
        .get("gameextrainfo")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let in_game = game_id.is_some();

    Ok(SteamStatus {
        steam_id: player
            .get("steamid")
            .and_then(|v| v.as_str())
            .unwrap_or(steam_id)
            .to_string(),
        persona_name: player
            .get("personaname")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        profile_url: player
            .get("profileurl")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        avatar: player
            .get("avatarfull")
            .or_else(|| player.get("avatar"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        in_game,
        game_id,
        game_name,
        updated_at: now,
        rich_presence: player
            .get("richpresence")
            .or_else(|| player.get("gameextrainfo"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_in_game_player() {
        let body = json!({
            "response": {
                "players": [{
                    "steamid": "76561198000000000",
                    "personaname": "Aldric",
                    "profileurl": "https://steamcommunity.com/id/aldric/",
                    "avatarfull": "https://avatars.steamstatic.com/x.jpg",
                    "gameid": "1086940",
                    "gameextrainfo": "Baldur's Gate 3"
                }]
            }
        });
        let status = parse_players(&body, "76561198000000000").unwrap();
        assert_eq!(status.steam_id, "76561198000000000");
        assert_eq!(status.persona_name, "Aldric");
        assert_eq!(status.game_id.as_deref(), Some("1086940"));
        assert_eq!(status.game_name.as_deref(), Some("Baldur's Gate 3"));
        assert!(status.in_game);
        assert!(status.rich_presence.is_some());
    }

    #[test]
    fn parses_player_not_in_game() {
        let body = json!({
            "response": {
                "players": [{
                    "steamid": "76561198000000000",
                    "personaname": "Aldric",
                    "avatar": "https://avatars.steamstatic.com/x.jpg"
                }]
            }
        });
        let status = parse_players(&body, "76561198000000000").unwrap();
        assert!(!status.in_game);
        assert!(status.game_id.is_none());
        assert!(status.game_name.is_none());
    }

    #[test]
    fn handles_unknown_player_empty_array() {
        let body = json!({ "response": { "players": [] } });
        let status = parse_players(&body, "76561198000000000").unwrap();
        assert!(!status.in_game);
        assert!(status.game_id.is_none());
        assert_eq!(status.steam_id, "76561198000000000");
    }

    #[test]
    fn query_resolves_steam_id_aliases() {
        let q = SteamQuery {
            steam_id: Some("123".into()),
            steamids: None,
        };
        assert_eq!(q.steam_id(), Some("123"));
        let q2 = SteamQuery {
            steam_id: None,
            steamids: Some("456".into()),
        };
        assert_eq!(q2.steam_id(), Some("456"));
        let q3 = SteamQuery {
            steam_id: None,
            steamids: None,
        };
        assert_eq!(q3.steam_id(), None);
    }
}
