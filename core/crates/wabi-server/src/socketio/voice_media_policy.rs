// Transport-neutral channel media gates used by relay/SFU policy enforcement.
// This file is include!d into socketio_impl's flat module, so sibling types
// such as VoiceParticipant and serde_json::Value are already in scope.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VoiceMediaSource {
    Microphone,
    Camera,
    ScreenAudio,
    ScreenVideo,
}

fn classify_voice_media_envelope(data: &Value) -> Option<VoiceMediaSource> {
    let kind = data.get("kind").and_then(Value::as_str).unwrap_or("audio");
    let source = data.get("source").and_then(Value::as_str);
    match (kind, source) {
        ("audio", Some("screen")) => Some(VoiceMediaSource::ScreenAudio),
        ("audio", _) => Some(VoiceMediaSource::Microphone),
        ("video", Some("screen")) => Some(VoiceMediaSource::ScreenVideo),
        ("video", _) => Some(VoiceMediaSource::Camera),
        _ => None,
    }
}

/// Server-authoritative publication rule for community voice relays.
///
/// - A policy/listener admission publishes nothing by default.
/// - TeamSpeak-style `all-listening` is a deliberate user action and may send
///   microphone audio to secondary listening channels, but never camera/screen.
/// - Mute applies to microphone only; sharing system audio while mic-muted is
///   valid and matches LiveKit's source-specific grant model.
fn voice_media_publish_allowed(participant: &VoiceParticipant, data: &Value) -> bool {
    let Some(source) = classify_voice_media_envelope(data) else { return false; };
    if participant.is_listening_only {
        return participant.transmit_mode == "all-listening"
            && source == VoiceMediaSource::Microphone
            && !participant.is_muted;
    }
    match source {
        VoiceMediaSource::Microphone => !participant.is_muted,
        VoiceMediaSource::Camera | VoiceMediaSource::ScreenAudio | VoiceMediaSource::ScreenVideo => true,
    }
}

/// Effective deafen is a receive-side AUDIO gate. Video may continue so a user
/// can deafen voice while watching a camera/screen. LiveKit currently has a
/// stronger all-subscriptions server-deafen grant; the relay deliberately keeps
/// this helper source-specific so the transport contract can converge later.
fn voice_media_receive_allowed(participant: &VoiceParticipant, data: &Value) -> bool {
    match classify_voice_media_envelope(data) {
        Some(VoiceMediaSource::Microphone | VoiceMediaSource::ScreenAudio) => !participant.is_deafened,
        Some(VoiceMediaSource::Camera | VoiceMediaSource::ScreenVideo) => true,
        None => false,
    }
}

#[cfg(test)]
mod voice_media_policy_tests {
    use super::*;

    fn member() -> VoiceParticipant {
        VoiceParticipant {
            socket_id: "sock-a".into(), stable_id: "user-1".into(), username: "u".into(),
            color: "#fff".into(), is_muted: false, is_deafened: false,
            transmit_mode: "primary".into(), is_listening_only: false, profile_picture: None,
        }
    }

    fn mic() -> Value { json!({"kind":"audio", "payload":"x"}) }
    fn screen_audio() -> Value { json!({"kind":"audio", "source":"screen", "payload":"x"}) }
    fn camera() -> Value { json!({"kind":"video", "source":"camera", "payload":"x"}) }
    fn screen_video() -> Value { json!({"kind":"video", "source":"screen", "payload":"x"}) }

    #[test]
    fn muted_member_cannot_publish_microphone_but_can_share() {
        let mut p = member();
        p.is_muted = true;
        assert!(!voice_media_publish_allowed(&p, &mic()));
        assert!(voice_media_publish_allowed(&p, &screen_audio()));
        assert!(voice_media_publish_allowed(&p, &camera()));
        assert!(voice_media_publish_allowed(&p, &screen_video()));
    }

    #[test]
    fn listen_only_is_receive_only_unless_all_listening_mic_was_explicitly_enabled() {
        let mut p = member();
        p.is_listening_only = true;
        p.transmit_mode = "listening".into();
        assert!(!voice_media_publish_allowed(&p, &mic()));
        assert!(!voice_media_publish_allowed(&p, &camera()));
        assert!(!voice_media_publish_allowed(&p, &screen_video()));
        p.transmit_mode = "all-listening".into();
        assert!(voice_media_publish_allowed(&p, &mic()));
        assert!(!voice_media_publish_allowed(&p, &screen_audio()));
        assert!(!voice_media_publish_allowed(&p, &camera()));
        assert!(!voice_media_publish_allowed(&p, &screen_video()));
        p.is_muted = true;
        assert!(!voice_media_publish_allowed(&p, &mic()));
    }

    #[test]
    fn deafen_blocks_relay_audio_without_hiding_video() {
        let mut p = member();
        p.is_deafened = true;
        assert!(!voice_media_receive_allowed(&p, &mic()));
        assert!(!voice_media_receive_allowed(&p, &screen_audio()));
        assert!(voice_media_receive_allowed(&p, &camera()));
        assert!(voice_media_receive_allowed(&p, &screen_video()));
    }

    #[test]
    fn unknown_envelopes_fail_closed() {
        let p = member();
        let unknown = json!({"kind":"data", "payload":"x"});
        assert!(!voice_media_publish_allowed(&p, &unknown));
        assert!(!voice_media_receive_allowed(&p, &unknown));
    }
}
