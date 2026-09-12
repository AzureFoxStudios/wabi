//! Versioned, private curated-game aggregate. Never part of the public roster.
use serde::{Deserialize, Serialize};
use crate::{engine::locks::ProjectionState, error::{Result, WabiError}, projections::handler::{DurableEvent, Projection}};

pub const INDEX: &str = "game_profiles";
pub const EVENT: &str = "game_profile_replaced_v1";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Visibility { Private, Server }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameSelection {
    pub key: String,
    pub title: String,
    pub platform: String,
    pub tags: Vec<String>,
    pub note: String,
    pub rotation: bool,
    pub favorite: bool,
    pub invitations: bool,
    pub visibility: Visibility,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameProfileRecord {
    pub schema: u8,
    pub user_id: u64,
    pub revision: String,
    pub entries: Vec<GameSelection>,
    pub steam_id: Option<String>,
    pub show_steam_link: bool,
}
impl GameProfileRecord {
    pub fn empty(user_id: u64) -> Self {
        Self { schema: 1, user_id, revision: "0".into(), entries: vec![], steam_id: None, show_steam_link: false }
    }
}
fn corrupt(message: &str) -> WabiError {
    WabiError::Corrupt { location: INDEX.into(), detail: message.into() }
}
pub fn decode(bytes: &[u8]) -> Result<GameProfileRecord> {
    if bytes.len() > 131072 { return Err(corrupt("oversized game profile")); }
    let row: GameProfileRecord = serde_json::from_slice(bytes).map_err(|_| corrupt("invalid game profile JSON"))?;
    if row.schema != 1 || row.user_id == 0 || row.revision.is_empty() || row.revision.len() > 64 || row.entries.len() > 64 {
        return Err(corrupt("unsupported game profile record"));
    }
    Ok(row)
}
pub struct GameProfilesProjection;
impl Projection for GameProfilesProjection {
    fn event_type(&self) -> &str { EVENT }
    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let row = decode(&event.payload)?;
        // A deletion may have committed between admission and this event. Do not
        // resurrect a deleted account or its private external association.
        if state.get("users", &row.user_id.to_be_bytes()).is_none() { return Ok(()); }
        state.insert(INDEX, row.user_id.to_be_bytes().to_vec(), event.payload.clone(), event.commit_seq);
        Ok(())
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn game_profile_roundtrip_and_version_gate() {
        let row = GameProfileRecord::empty(42);
        assert_eq!(decode(&serde_json::to_vec(&row).unwrap()).unwrap(), row);
        let mut bad = row; bad.schema = 2;
        assert!(decode(&serde_json::to_vec(&bad).unwrap()).is_err());
        assert!(decode(b"{}").is_err());
        assert!(decode(&vec![0; 131073]).is_err());
    }
    #[test] fn game_profile_does_not_resurrect_unknown_accounts() {
        let state = ProjectionState::new();
        let payload = serde_json::to_vec(&GameProfileRecord::empty(42)).unwrap();
        GameProfilesProjection.apply(&DurableEvent { commit_seq: 1, stream_id: "game-profile:42".into(), event_type: EVENT.into(), payload }, &state).unwrap();
        assert!(state.get(INDEX, &42u64.to_be_bytes()).is_none());
    }
}
