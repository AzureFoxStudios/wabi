// Calling security layer — 2026-08-25 calling overhaul, Phase 1.
//
// SEC-1: `join-wabidb-call` room joins are authorized against server-side
// truth (voice roster / group session / DM key self-membership); guests are
// rejected from media rooms. `wabidb-media` envelopes carry a server-attested
// userId (the client field is never trusted) and are rate-limited per socket.
//
// SEC-3: WebRTC/SDP signaling between two sockets requires a call
// relationship — shared voice channel, shared group call session, or an
// active DM call link created by call-initiate/answer.

// NOTE: this file is include!d into the FLAT socketio_impl module together
// with shared.rs & friends — HashMap/HashSet/Value/etc. from their imports
// are already in scope here. The std sync/time primitives below are fully
// qualified because `RwLock` in that namespace is tokio's, and Instant /
// OnceLock may already be imported by sibling files.

// ---------------------------------------------------------------------------
// Media rate limiting (per socket)
// ---------------------------------------------------------------------------

/// Sustained + burst envelope budget for `wabidb-media` relays. Audio is
/// ~50 pps per relay; chunked video adds a few hundred envelopes more. A
/// client in five concurrent calls stays comfortably under the sustained
/// rate, while a flood is dropped within one burst window.
const MEDIA_MSG_REFILL_PER_SEC: f64 = 800.0;
const MEDIA_MSG_BURST: f64 = 1_600.0;
/// Byte budget: base64 opus (~4KB) and video chunks (~16-64KB) per envelope.
const MEDIA_BYTES_REFILL_PER_SEC: f64 = 16_000_000.0;
const MEDIA_BYTES_BURST: f64 = 32_000_000.0;

struct MediaBudget {
    msgs: f64,
    bytes: f64,
    last: std::time::Instant,
}

fn media_budgets() -> &'static std::sync::RwLock<HashMap<String, MediaBudget>> {
    static BUDGETS: std::sync::OnceLock<std::sync::RwLock<HashMap<String, MediaBudget>>> =
        std::sync::OnceLock::new();
    BUDGETS.get_or_init(|| std::sync::RwLock::new(HashMap::new()))
}

/// Token-bucket gate for one `wabidb-media` envelope. Returns false when the
/// sender is flooding and the envelope must be dropped.
pub fn media_rate_allow(socket_id: &str, payload_bytes: usize) -> bool {
    let now = std::time::Instant::now();
    let mut budgets = media_budgets().write().expect("media budget lock");
    let budget = budgets.entry(socket_id.to_string()).or_insert(MediaBudget {
        msgs: MEDIA_MSG_BURST,
        bytes: MEDIA_BYTES_BURST,
        last: now,
    });
    let elapsed = now.duration_since(budget.last).as_secs_f64().max(0.0);
    budget.last = now;
    budget.msgs = (budget.msgs + elapsed * MEDIA_MSG_REFILL_PER_SEC).min(MEDIA_MSG_BURST);
    budget.bytes = (budget.bytes + elapsed * MEDIA_BYTES_REFILL_PER_SEC).min(MEDIA_BYTES_BURST);

    budget.msgs -= 1.0;
    budget.bytes -= payload_bytes as f64;
    budget.msgs >= 0.0 && budget.bytes >= 0.0
}

/// Drop the per-socket budget on disconnect so the map does not grow without
/// bound. Called from the socket disconnect cleanup.
pub fn media_rate_forget(socket_id: &str) {
    media_budgets()
        .write()
        .expect("media budget lock")
        .remove(socket_id);
}

// ---------------------------------------------------------------------------
// WabiDB media header replay (2026-09-03 round 6 — late-joiner no-audio fix)
// ---------------------------------------------------------------------------

/// Audio envelopes with `seq <= 1` are the sender's Ogg Opus BOS header
/// pages (the client's `startCapture()` resets its seq counter for every
/// encoder stream). opus-recorder's decoder CANNOT initialize from
/// mid-stream pages — a socket that joins the media room after the sender
/// started (late join, or its own reconnect: socket.io rooms do not survive
/// reconnects) never sees them and stays deaf with a `decoderBuffer is
/// undefined` error per frame. Cache the first two audio envelopes per
/// (session, sender) and replay them on `join-wabidb-call`.
///
/// No skip-self on replay: envelopes carry the ORIGINAL sender's socket id,
/// and same-account multi-device sessions (2026-08-26 fix) legitimately need
/// their own account's headers from the other device. A stale own-stream
/// decoder that never receives live pages is harmless and short-lived.
const HEADER_CACHE_MAX_SESSIONS: usize = 128;
const HEADER_CACHE_PER_SENDER: usize = 2;
const HEADER_CACHE_MAX_STREAMS: usize = 512;

type HeaderCache = HashMap<String, HashMap<String, Vec<Value>>>;

fn wabidb_header_cache() -> &'static std::sync::RwLock<HeaderCache> {
    static CACHE: std::sync::OnceLock<std::sync::RwLock<HeaderCache>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::RwLock::new(HashMap::new()))
}

/// Cache one relayed audio envelope when it is a header envelope (seq <= 1).
/// A seq reset to 0 (encoder restart) replaces the sender's previous entry.
///
/// `sender` must be the STREAM-QUALIFIED key (`"{user_id}:mic"` or
/// `"{user_id}:screen"`): one sender can run two independent opus streams
/// (mic + screen-share audio, 2026-09-04), and a shared key would let the
/// second stream's seq-0/1 headers evict the first stream's — late joiners
/// would go deaf on the mic the moment a share with audio started.
pub fn wabidb_header_cache_remember(session_id: &str, sender: &str, seq: u64, envelope: &Value) {
    if seq > 1 {
        return;
    }
    let mut cache = wabidb_header_cache().write().expect("header cache lock");
    if cache.len() >= HEADER_CACHE_MAX_SESSIONS && !cache.contains_key(session_id) {
        // Safety valve only (128 sessions ≈ far beyond current scale): drop
        // an arbitrary session to keep the map bounded.
        if let Some(victim) = cache.keys().next().cloned() {
            cache.remove(&victim);
        }
    }
    let senders = cache.entry(session_id.to_string()).or_default();
    if senders.len() >= HEADER_CACHE_MAX_STREAMS && !senders.contains_key(sender) {
        if let Some(victim) = senders.keys().next().cloned() {
            senders.remove(&victim);
        }
    }
    let entry = senders.entry(sender.to_string()).or_default();
    if seq == 0 {
        entry.clear();
    }
    if entry.len() < HEADER_CACHE_PER_SENDER {
        entry.push(envelope.clone());
    }
}

/// Headers belong to a connection, not an account. A disconnected device's
/// headers must not create ghost decoders in every subsequent late joiner.
pub fn wabidb_header_cache_forget_socket(socket_id: &str) {
    let mut cache = wabidb_header_cache().write().expect("header cache lock");
    cache.retain(|_, senders| {
        senders.retain(|_, envelopes| {
            !envelopes.iter().any(|e| {
                e.get("senderSocket").and_then(Value::as_str) == Some(socket_id)
            })
        });
        !senders.is_empty()
    });
}

/// Snapshot every cached header envelope for a session, senders ordered by
/// first contribution (pure — unit-testable without sockets).
pub fn wabidb_header_cache_snapshot(session_id: &str) -> Vec<Value> {
    let cache = wabidb_header_cache().read().expect("header cache lock");
    let mut senders: Vec<(&String, &Vec<Value>)> = cache
        .get(session_id)
        .map(|m| m.iter().collect())
        .unwrap_or_default();
    senders.sort_by(|a, b| a.0.cmp(b.0));
    senders
        .into_iter()
        .flat_map(|(_, envelopes)| envelopes.iter())
        .cloned()
        .collect()
}

// ---------------------------------------------------------------------------
// Call recording presence (per socket)
// ---------------------------------------------------------------------------

/// One socket's active call recording, for transparency broadcasts. The
/// addressed channels are SERVER-derived (voice roster / group session) —
/// client-supplied channel claims are never trusted for addressing.
#[derive(Clone, Debug, PartialEq)]
pub struct RecordingPresenceEntry {
    pub stable_id: String,
    pub username: String,
    /// "direct" | "group" | "channel"
    pub scope: String,
    /// group: the session channel; channel: every occupied voice channel;
    /// direct: empty.
    pub channel_ids: Vec<String>,
}

fn recording_presence_map() -> &'static std::sync::RwLock<HashMap<String, RecordingPresenceEntry>> {
    static MAP: std::sync::OnceLock<std::sync::RwLock<HashMap<String, RecordingPresenceEntry>>> =
        std::sync::OnceLock::new();
    MAP.get_or_init(|| std::sync::RwLock::new(HashMap::new()))
}

/// Remember/replace a socket's active recording. Returns the previous entry
/// when one existed so the caller can broadcast its deactivation first.
pub fn recording_presence_upsert(
    socket_id: &str,
    entry: RecordingPresenceEntry,
) -> Option<RecordingPresenceEntry> {
    recording_presence_map()
        .write()
        .expect("recording presence lock")
        .insert(socket_id.to_string(), entry)
}

/// Forget a socket's recording (explicit stop or disconnect). Returns the
/// entry so the caller can broadcast the deactivation.
pub fn recording_presence_remove(socket_id: &str) -> Option<RecordingPresenceEntry> {
    recording_presence_map()
        .write()
        .expect("recording presence lock")
        .remove(socket_id)
}

/// Cheap recursive size estimate for a parsed JSON envelope — dominated by
/// the base64 payload strings, so string lengths carry the signal.
pub fn json_size_hint(value: &serde_json::Value) -> usize {
    use serde_json::Value;
    match value {
        Value::String(s) => s.len() + 16,
        Value::Array(items) => items.iter().map(json_size_hint).sum(),
        Value::Object(fields) => fields
            .iter()
            .map(|(k, v)| k.len() + 16 + json_size_hint(v))
            .sum(),
        Value::Number(_) | Value::Bool(_) => 16,
        Value::Null => 4,
    }
}

// ---------------------------------------------------------------------------
// DM call link registry (signaling consent for direct calls)
// ---------------------------------------------------------------------------

/// Sorted (stable_id, stable_id) pairs with an active DM call — created by
/// call-initiate, cleared by answer/leave flows and disconnect cleanup.
fn dm_call_links() -> &'static std::sync::RwLock<HashSet<(String, String)>> {
    static LINKS: std::sync::OnceLock<std::sync::RwLock<HashSet<(String, String)>>> =
        std::sync::OnceLock::new();
    LINKS.get_or_init(|| std::sync::RwLock::new(HashSet::new()))
}

fn dm_link_key(a: &str, b: &str) -> (String, String) {
    if a <= b {
        (a.to_string(), b.to_string())
    } else {
        (b.to_string(), a.to_string())
    }
}

pub fn dm_link_remember(a: &str, b: &str) {
    if a == b || a.is_empty() || b.is_empty() {
        return;
    }
    dm_call_links()
        .write()
        .expect("dm link lock")
        .insert(dm_link_key(a, b));
}

pub fn dm_link_forget(a: &str, b: &str) {
    dm_call_links()
        .write()
        .expect("dm link lock")
        .remove(&dm_link_key(a, b));
}

pub fn dm_link_exists(a: &str, b: &str) -> bool {
    dm_call_links()
        .read()
        .expect("dm link lock")
        .contains(&dm_link_key(a, b))
}

/// Remove every link mentioning `stable_id` (disconnect cleanup).
pub fn dm_link_clear_user(stable_id: &str) {
    dm_call_links()
        .write()
        .expect("dm link lock")
        .retain(|(a, b)| a != stable_id && b != stable_id);
}

// ---------------------------------------------------------------------------
// WabiDB media room authorization (pure — unit-testable without sockets)
// ---------------------------------------------------------------------------

/// Authorize joining the `wabidb-call-{session}` relay room.
///
/// Session ids are the deterministic client-side keys (`channel:{id}` /
/// `dm:{user-a}:{user-b}`, sorted, normalized to `user-{n}`):
/// - channel sessions must match the roster channel AND have the joining
///   socket as a voice member (primary or listen-only) or group-call
///   participant;
/// - dm sessions name both participants in the key itself — the joining user
///   must be one of them;
/// - anything else (including guest identities) is rejected.
pub fn authorize_wabidb_session_join(
    my_stable_id: &str,
    my_socket_id: &str,
    session_id: &str,
    channel_id: Option<&str>,
    voice_channels: &HashMap<String, Vec<VoiceParticipant>>,
    group_sessions: &HashMap<String, GroupCallSession>,
) -> Result<(), &'static str> {
    // Guests resolve to their socket id as stable id; a bare socket id is
    // never a valid participant identity for media rooms. Guests have no
    // attested user id to stamp on envelopes, so reject them outright.
    if !my_stable_id.starts_with("user-") {
        return Err("authentication required");
    }

    if let Some(dm_key) = session_id.strip_prefix("dm:") {
        let mut parts = dm_key.split(':');
        let peer_a = parts.next().unwrap_or("");
        let peer_b = parts.next().unwrap_or("");
        if parts.next().is_some() || peer_a.is_empty() || peer_b.is_empty() {
            return Err("malformed dm session key");
        }
        if peer_a == my_stable_id || peer_b == my_stable_id {
            Ok(())
        } else {
            Err("not a participant of this call")
        }
    } else if let Some(channel_id) = channel_id.filter(|c| !c.is_empty()) {
        if session_id != format!("channel:{}", channel_id) {
            return Err("session key does not match channel");
        }
        let voice_member = voice_channels
            .get(channel_id)
            .map(|members| {
                members
                    .iter()
                    .any(|p| p.socket_id == my_socket_id || p.stable_id == my_stable_id)
            })
            .unwrap_or(false);
        if voice_member {
            return Ok(());
        }
        let group_member = group_sessions
            .get(channel_id)
            .map(|s| s.connected_participants.contains(my_stable_id))
            .unwrap_or(false);
        if group_member {
            return Ok(());
        }
        Err("not a member of this channel")
    } else {
        Err("unsupported wabidb session")
    }
}

/// Consent gate for peer signaling (`webrtc-*`, `call-answer-sdp`,
/// `call-ice-candidate`, channel-less `call-offer`). The sender and target
/// must share a call relationship: a voice channel, a group call session, or
/// an active DM call link. `target_id` may be a socket id or a stable id —
/// sockets join a room named after their stable id, so both forms address.
pub fn signaling_consent_allowed(
    my_stable_id: &str,
    my_socket_id: &str,
    target_id: &str,
    voice_channels: &HashMap<String, Vec<VoiceParticipant>>,
    group_sessions: &HashMap<String, GroupCallSession>,
    target_stable_id: Option<&str>,
) -> bool {
    if target_id.is_empty() {
        return false;
    }
    // Shared voice channel (either id form for both sides).
    let sender_matches = |p: &VoiceParticipant| {
        p.socket_id == my_socket_id || p.stable_id == my_stable_id
    };
    let target_matches = |p: &VoiceParticipant| {
        p.socket_id == target_id
            || p.stable_id == target_id
            || target_stable_id.is_some_and(|t| p.stable_id == t)
    };
    if voice_channels
        .values()
        .any(|members| members.iter().any(sender_matches) && members.iter().any(target_matches))
    {
        return true;
    }
    // Shared group call session.
    let target_forms: Vec<&str> = match target_stable_id {
        Some(t) => vec![target_id, t],
        None => vec![target_id],
    };
    if group_sessions.values().any(|s| {
        s.connected_participants.contains(my_stable_id)
            && target_forms
                .iter()
                .any(|t| s.connected_participants.contains(*t))
    }) {
        return true;
    }
    // Active DM call link.
    target_forms
        .iter()
        .any(|t| *t != my_stable_id && dm_link_exists(my_stable_id, t))
}

#[cfg(test)]
mod call_security_tests {
    use super::*;

    fn participant(socket_id: &str, stable_id: &str) -> VoiceParticipant {
        VoiceParticipant {
            socket_id: socket_id.to_string(),
            stable_id: stable_id.to_string(),
            username: "u".to_string(),
            color: "#fff".to_string(),
            is_muted: false,
            is_deafened: false,
            transmit_mode: "primary".to_string(),
            is_listening_only: false,
            profile_picture: None,
        }
    }

    fn empty_group(channel_id: &str) -> GroupCallSession {
        GroupCallSession {
            channel_id: channel_id.to_string(),
            channel_name: String::new(),
            initiator_stable_id: String::new(),
            is_video_call: false,
            has_ever_established: false,
            last_invite_sender_id: String::new(),
            invited_participants: HashSet::new(),
            connected_participants: HashSet::new(),
        }
    }

    #[test]
    fn channel_join_requires_matching_key_and_roster_membership() {
        let mut voice = HashMap::new();
        voice.insert(
            "ch-1".to_string(),
            vec![participant("sock-a", "user-1"), participant("sock-b", "user-2")],
        );
        // Roster member with the correct deterministic key.
        assert!(authorize_wabidb_session_join(
            "user-1", "sock-a", "channel:ch-1", Some("ch-1"), &voice, &HashMap::new()
        )
        .is_ok());
        // Roster member but a session key for a DIFFERENT channel.
        assert_eq!(
            authorize_wabidb_session_join(
                "user-1", "sock-a", "channel:ch-2", Some("ch-1"), &voice, &HashMap::new()
            ),
            Err("session key does not match channel")
        );
        // Not on the roster at all.
        assert_eq!(
            authorize_wabidb_session_join(
                "user-3", "sock-c", "channel:ch-1", Some("ch-1"), &voice, &HashMap::new()
            ),
            Err("not a member of this channel")
        );
    }

    #[test]
    fn group_session_participant_may_join_channel_room() {
        let mut groups = HashMap::new();
        let mut session = empty_group("g-1");
        session.connected_participants.insert("user-7".to_string());
        groups.insert("g-1".to_string(), session);
        assert!(authorize_wabidb_session_join(
            "user-7", "sock-7", "channel:g-1", Some("g-1"), &HashMap::new(), &groups
        )
        .is_ok());
    }

    #[test]
    fn dm_join_requires_being_named_in_the_key() {
        // The key names both participants; only they may join.
        assert!(authorize_wabidb_session_join(
            "user-1", "sock-a", "dm:user-1:user-2", None, &HashMap::new(), &HashMap::new()
        )
        .is_ok());
        assert!(authorize_wabidb_session_join(
            "user-2", "sock-b", "dm:user-1:user-2", None, &HashMap::new(), &HashMap::new()
        )
        .is_ok());
        // Eavesdropper named in neither slot.
        assert_eq!(
            authorize_wabidb_session_join(
                "user-3", "sock-c", "dm:user-1:user-2", None, &HashMap::new(), &HashMap::new()
            ),
            Err("not a participant of this call")
        );
        // Malformed keys.
        assert_eq!(
            authorize_wabidb_session_join(
                "user-1", "sock-a", "dm:only-one", None, &HashMap::new(), &HashMap::new()
            ),
            Err("malformed dm session key")
        );
        assert_eq!(
            authorize_wabidb_session_join(
                "user-1", "sock-a", "dm:a:b:c", None, &HashMap::new(), &HashMap::new()
            ),
            Err("malformed dm session key")
        );
    }

    #[test]
    fn guests_and_unknown_sessions_rejected() {
        // Guests resolve to socket ids — no attested identity.
        assert_eq!(
            authorize_wabidb_session_join(
                "sock-a", "sock-a", "channel:ch-1", Some("ch-1"), &HashMap::new(), &HashMap::new()
            ),
            Err("authentication required")
        );
        // Arbitrary session shapes are refused.
        assert_eq!(
            authorize_wabidb_session_join(
                "user-1", "sock-a", "session-123", None, &HashMap::new(), &HashMap::new()
            ),
            Err("unsupported wabidb session")
        );
    }

    #[test]
    fn signaling_needs_shared_channel_group_or_dm_link() {
        let mut voice = HashMap::new();
        voice.insert(
            "vc-1".to_string(),
            vec![participant("sock-a", "user-1"), participant("sock-b", "user-2")],
        );
        // Shared voice channel — target by stable id and by socket id.
        assert!(signaling_consent_allowed(
            "user-1", "sock-a", "user-2", &voice, &HashMap::new(), None
        ));
        assert!(signaling_consent_allowed(
            "user-1", "sock-a", "sock-b", &voice, &HashMap::new(), Some("user-2")
        ));
        // No relationship.
        assert!(!signaling_consent_allowed(
            "user-9", "sock-z", "user-2", &voice, &HashMap::new(), None
        ));

        // DM link grants consent until forgotten.
        dm_link_remember("user-3", "user-4");
        assert!(signaling_consent_allowed(
            "user-3", "sock-c", "user-4", &HashMap::new(), &HashMap::new(), None
        ));
        dm_link_forget("user-3", "user-4");
        assert!(!signaling_consent_allowed(
            "user-3", "sock-c", "user-4", &HashMap::new(), &HashMap::new(), None
        ));

        // Group session consent.
        let mut groups = HashMap::new();
        let mut session = empty_group("g-1");
        session.connected_participants.insert("user-5".to_string());
        session.connected_participants.insert("user-6".to_string());
        groups.insert("g-1".to_string(), session);
        assert!(signaling_consent_allowed(
            "user-5", "sock-e", "user-6", &HashMap::new(), &groups, None
        ));
        assert!(!signaling_consent_allowed(
            "user-9", "sock-z", "user-6", &HashMap::new(), &groups, None
        ));

        // Never consent to signaling yourself an empty target.
        assert!(!signaling_consent_allowed(
            "user-1", "sock-a", "", &voice, &HashMap::new(), None
        ));
    }

    #[test]
    fn dm_link_clear_user_removes_only_that_user() {
        // Distinct ids from the other tests — the registry is global and
        // tests run in parallel.
        dm_link_remember("user-10", "user-11");
        dm_link_remember("user-12", "user-13");
        dm_link_clear_user("user-10");
        assert!(!dm_link_exists("user-10", "user-11"));
        assert!(dm_link_exists("user-12", "user-13"));
        dm_link_clear_user("user-13");
        assert!(!dm_link_exists("user-12", "user-13"));
    }

    #[test]
    fn media_rate_bucket_drops_floods_and_refills() {
        let socket = "rate-test-socket";
        // Well under burst: allowed.
        assert!(media_rate_allow(socket, 1_000));
        // Drain the message burst.
        let mut allowed = 0;
        for _ in 0..5_000 {
            if media_rate_allow(socket, 1) {
                allowed += 1;
            }
        }
        // ~burst-size messages pass, the rest drop, and it is finite.
        assert!(allowed > 100 && allowed <= 1_700, "allowed={allowed}");
        // Oversized envelopes are dropped immediately by the byte bucket.
        assert!(!media_rate_allow(socket, 100_000_000));
        media_rate_forget(socket);
    }

    #[test]
    fn dm_media_room_key_matches_client_derivation() {
        // Mirror of the client's wabidbDmSessionKey: digits normalize to
        // `user-{n}`, the pair sorts LEXICOGRAPHICALLY (user-10 < user-2 —
        // same as JS string sort), key = `dm:{first}:{second}`.
        assert_eq!(dm_media_room_key("user-2", "user-10"), "dm:user-10:user-2");
        assert_eq!(dm_media_room_key("user-10", "user-2"), "dm:user-10:user-2");
        // Raw numeric ids (envelope form) normalize identically.
        assert_eq!(dm_media_room_key("2", "user-10"), "dm:user-10:user-2");
        // Non-user ids (never valid participants) still derive deterministically.
        assert_eq!(dm_media_room_key("a", "b"), "dm:a:b");
    }

    #[test]
    fn header_cache_keeps_first_two_and_replaces_on_seq_reset() {
        let session = "hdr-c1";
        let envelope = |seq: u64| {
            json!({"sessionId": session, "userId": "2", "kind": "audio",
                   "seq": seq, "payload": format!("p{seq}")})
        };
        wabidb_header_cache_remember(session, "2:mic", 0, &envelope(0));
        wabidb_header_cache_remember(session, "2:mic", 1, &envelope(1));
        // seq 2+ is not a header envelope — never cached.
        wabidb_header_cache_remember(session, "2:mic", 2, &envelope(2));
        let snap = wabidb_header_cache_snapshot(session);
        assert_eq!(snap.len(), 2);
        assert_eq!(snap[0]["seq"], json!(0));
        assert_eq!(snap[1]["seq"], json!(1));
        // Encoder restart: seq resets to 0 and the old entry is REPLACED.
        wabidb_header_cache_remember(session, "2:mic", 0, &envelope(0));
        let snap = wabidb_header_cache_snapshot(session);
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0]["payload"], json!("p0"));
    }

    #[test]
    fn header_cache_keeps_streams_separate_per_sender() {
        // Mic + screen-share audio are two opus streams from ONE user: the
        // screen stream's headers must never evict the mic's (the key is
        // stream-qualified — see the caller in media_reactions_signaling).
        let session = "hdr-c3";
        for (stream, seq) in [("mic", 0u64), ("mic", 1), ("screen", 0), ("screen", 1)] {
            let envelope = json!({"sessionId": session, "userId": "2",
                                   "kind": "audio", "source": stream,
                                   "seq": seq, "payload": format!("{stream}-{seq}")});
            wabidb_header_cache_remember(session, &format!("2:{stream}"), seq, &envelope);
        }
        let snap = wabidb_header_cache_snapshot(session);
        assert_eq!(snap.len(), 4, "both streams keep their two headers");
        // A screen-stream restart does not touch the mic's headers.
        let restart = json!({"sessionId": session, "userId": "2",
                              "kind": "audio", "source": "screen", "seq": 0, "payload": "s-new"});
        wabidb_header_cache_remember(session, "2:screen", 0, &restart);
        let snap = wabidb_header_cache_snapshot(session);
        assert_eq!(snap.len(), 3);
        assert!(
            snap.iter().any(|e| e["payload"] == json!("mic-0") && e["seq"] == json!(0)),
            "mic headers survive the screen stream restart"
        );
    }

    #[test]
    fn header_cache_isolates_same_account_devices_and_forgets_only_departed_socket() {
        let session = "hdr-device-isolation";
        for device in ["device-a", "device-b"] {
            for source in ["mic", "screen"] {
                for seq in 0..2 {
                    let envelope = json!({ "sessionId": session, "userId": "2", "senderSocket": device, "source": source, "seq": seq, "payload": "header" });
                    wabidb_header_cache_remember(session, &format!("2:{device}:{source}"), seq, &envelope);
                }
            }
        }
        assert_eq!(wabidb_header_cache_snapshot(session).len(), 8);
        wabidb_header_cache_forget_socket("device-a");
        let remaining = wabidb_header_cache_snapshot(session);
        assert_eq!(remaining.len(), 4);
        assert!(remaining.iter().all(|e| e["senderSocket"] == "device-b"));
        wabidb_header_cache_forget_socket("device-b");
        assert!(wabidb_header_cache_snapshot(session).is_empty());
    }

    #[test]
    fn header_cache_snapshots_multiple_senders_deterministically() {
        let session = "hdr-c2";
        for (sender, seq) in [("3:mic", 0u64), ("3:mic", 1), ("9:mic", 0), ("9:mic", 1)] {
            let envelope = json!({"sessionId": session,
                                   "userId": sender.split(':').next().unwrap(),
                                   "kind": "audio", "seq": seq, "payload": "x"});
            wabidb_header_cache_remember(session, sender, seq, &envelope);
        }
        let snap = wabidb_header_cache_snapshot(session);
        assert_eq!(snap.len(), 4);
        // Senders ordered by id ("3" before "9"), headers in seq order.
        assert_eq!(snap[0]["userId"], json!("3"));
        assert_eq!(snap[2]["userId"], json!("9"));
        assert_eq!(snap[0]["seq"], json!(0));
        assert_eq!(snap[1]["seq"], json!(1));
        // Unknown sessions snapshot empty.
        assert!(wabidb_header_cache_snapshot("hdr-never").is_empty());
    }

    #[test]
    fn header_cache_is_bounded_by_session_cap() {
        for i in 0..(HEADER_CACHE_MAX_SESSIONS + 40) {
            let session = format!("hdr-cap-{i}");
            let envelope = json!({"sessionId": session, "userId": "2",
                                   "kind": "audio", "seq": 0, "payload": "x"});
            wabidb_header_cache_remember(&session, "2", 0, &envelope);
        }
        let cache = wabidb_header_cache().read().expect("header cache lock");
        assert!(
            cache.len() <= HEADER_CACHE_MAX_SESSIONS,
            "cache.len()={} cap={}",
            cache.len(),
            HEADER_CACHE_MAX_SESSIONS
        );
    }

    #[test]
    fn recording_presence_registry_round_trips() {
        let socket = "rec-pres-test-socket";
        assert!(recording_presence_remove(socket).is_none());
        let entry = RecordingPresenceEntry {
            stable_id: "user-42".to_string(),
            username: "recorder".to_string(),
            scope: "channel".to_string(),
            channel_ids: vec!["ch-1".to_string()],
        };
        assert!(recording_presence_upsert(socket, entry.clone()).is_none());
        // A scope switch returns the previous entry so its deactivation can
        // be broadcast before the new state lands.
        let next = RecordingPresenceEntry {
            stable_id: "user-42".to_string(),
            username: "recorder".to_string(),
            scope: "direct".to_string(),
            channel_ids: vec![],
        };
        assert_eq!(recording_presence_upsert(socket, next.clone()), Some(entry));
        assert_eq!(recording_presence_remove(socket), Some(next));
        assert!(recording_presence_remove(socket).is_none());
    }
}
