use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use super::VoiceBitrateMode;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct VoiceChannelSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bitrate_mode: Option<VoiceBitrateMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force_solo: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct VoiceChannelParticipantView {
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_picture: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct VoiceStateEvent {
    pub voice_state: std::collections::BTreeMap<String, Vec<VoiceChannelParticipantView>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct VoiceChannelStateEvent {
    pub channel_id: String,
    pub members: Vec<VoiceChannelParticipantView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct VoiceChannelSubscriptionEvent {
    pub channel_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<VoiceChannelParticipantView>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct VoiceChannelUserJoinedEvent {
    pub channel_id: String,
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct VoiceChannelUserLeftEvent {
    pub channel_id: String,
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socket_id: Option<String>,
}
