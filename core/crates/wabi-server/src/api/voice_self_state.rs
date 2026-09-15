//! Volatile, per-socket self voice state.
//!
//! Durable moderation lives in WabiDB and durable channel defaults live in the
//! voice-policy registry. Self mute/deafen is device/session state, so it must
//! not be persisted. Keeping it separate lets server moderation change without
//! accidentally erasing a member's own mute/deafen choice.

use std::{collections::HashMap, sync::{OnceLock, RwLock}};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SelfVoiceState {
    pub muted: bool,
    pub deafened: bool,
}

type StateMap = HashMap<(String, String), SelfVoiceState>;

fn states() -> &'static RwLock<StateMap> {
    static STATES: OnceLock<RwLock<StateMap>> = OnceLock::new();
    STATES.get_or_init(|| RwLock::new(HashMap::new()))
}

pub fn set(channel_id: &str, socket_id: &str, state: SelfVoiceState) -> SelfVoiceState {
    states()
        .write()
        .expect("voice self-state lock")
        .insert((channel_id.to_string(), socket_id.to_string()), state);
    state
}

pub fn update(
    channel_id: &str,
    socket_id: &str,
    muted: Option<bool>,
    deafened: Option<bool>,
) -> SelfVoiceState {
    let mut guard = states().write().expect("voice self-state lock");
    let state = guard
        .entry((channel_id.to_string(), socket_id.to_string()))
        .or_default();
    if let Some(value) = muted {
        state.muted = value;
    }
    if let Some(value) = deafened {
        state.deafened = value;
    }
    *state
}

pub fn get(channel_id: &str, socket_id: &str) -> SelfVoiceState {
    states()
        .read()
        .expect("voice self-state lock")
        .get(&(channel_id.to_string(), socket_id.to_string()))
        .copied()
        .unwrap_or_default()
}

pub fn remove(channel_id: &str, socket_id: &str) {
    states()
        .write()
        .expect("voice self-state lock")
        .remove(&(channel_id.to_string(), socket_id.to_string()));
}

pub fn remove_socket(socket_id: &str) {
    states()
        .write()
        .expect("voice self-state lock")
        .retain(|(_, socket), _| socket != socket_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_state_is_scoped_to_channel_and_socket() {
        set("voice-a", "socket-a", SelfVoiceState { muted: true, deafened: false });
        set("voice-a", "socket-b", SelfVoiceState { muted: false, deafened: true });
        assert!(get("voice-a", "socket-a").muted);
        assert!(!get("voice-a", "socket-a").deafened);
        assert!(!get("voice-a", "socket-b").muted);
        assert!(get("voice-a", "socket-b").deafened);
        remove_socket("socket-a");
        assert_eq!(get("voice-a", "socket-a"), SelfVoiceState::default());
        remove("voice-a", "socket-b");
    }
}
