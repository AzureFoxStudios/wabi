use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::{ChannelType, MessageRetentionDuration};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct UsernameFont {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
}

#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum UserStatus {
    Active,
    Away,
    Busy,
    Offline,
}

#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum VoiceBitrateMode {
    Auto,
    Low,
    Standard,
    High,
}

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
pub struct UserView {
    pub id: String,
    pub username: String,
    pub color: String,
    pub status: UserStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_picture: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bio: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub joined_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_user_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roles: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highest_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username_font: Option<UsernameFont>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct ChannelView {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "type")]
    pub channel_type: Option<ChannelType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_queue_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_breakout: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub breakout_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_channel_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_archived: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_locked: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_auto_archive_minutes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_last_activity_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_delete_after: Option<MessageRetentionDuration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_temporary: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persist_messages: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_by: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_settings: Option<VoiceChannelSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct SessionView {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(transparent)]
#[cfg_attr(feature = "ts", ts(export))]
pub struct ChannelCreatedEvent(pub ChannelView);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct ChannelUpdatedEvent {
    pub channel_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_delete_after: Option<MessageRetentionDuration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persist_messages: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch_queue_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice_settings: Option<VoiceChannelSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct UserLeftEvent {
    pub id: String,
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_user_id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub joined_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct ConversationUserSummary {
    pub id: String,
    pub username: String,
    pub color: String,
    pub status: UserStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_picture: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_user_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct DirectMessageChannelEvent {
    pub channel_id: String,
    pub other_user: ConversationUserSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<ChannelView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct GroupCreatedEvent {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    #[serde(rename = "type")]
    pub channel_type: ChannelType,
    pub members: Vec<String>,
    pub member_users: Vec<ConversationUserSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_delete_after: Option<MessageRetentionDuration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persist_messages: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct GroupRemovedEvent {
    pub channel_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct GroupMemberRemovedEvent {
    pub channel_id: String,
    pub user_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct GroupMemberAddedEvent {
    pub channel_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<ConversationUserSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct GroupAvatarUpdatedEvent {
    pub channel_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UserStatusParseError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VoiceBitrateModeParseError;

impl UserStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Away => "away",
            Self::Busy => "busy",
            Self::Offline => "offline",
        }
    }
}

impl VoiceBitrateMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Low => "low",
            Self::Standard => "standard",
            Self::High => "high",
        }
    }
}

impl fmt::Display for UserStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl fmt::Display for VoiceBitrateMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for UserStatus {
    type Err = UserStatusParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "active" => Ok(Self::Active),
            "away" => Ok(Self::Away),
            "busy" => Ok(Self::Busy),
            "offline" => Ok(Self::Offline),
            _ => Err(UserStatusParseError),
        }
    }
}

impl FromStr for VoiceBitrateMode {
    type Err = VoiceBitrateModeParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "auto" => Ok(Self::Auto),
            "low" => Ok(Self::Low),
            "standard" => Ok(Self::Standard),
            "high" => Ok(Self::High),
            _ => Err(VoiceBitrateModeParseError),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ChannelType;

    #[test]
    fn user_status_strings_match_current_socket_contract() {
        assert_eq!(UserStatus::Active.as_str(), "active");
        assert_eq!(UserStatus::Away.as_str(), "away");
        assert_eq!(UserStatus::Busy.as_str(), "busy");
        assert_eq!(UserStatus::Offline.as_str(), "offline");
        assert_eq!("offline".parse::<UserStatus>(), Ok(UserStatus::Offline));
        assert!("invisible".parse::<UserStatus>().is_err());
    }

    #[test]
    fn voice_bitrate_mode_strings_match_current_socket_contract() {
        assert_eq!(VoiceBitrateMode::Auto.as_str(), "auto");
        assert_eq!(VoiceBitrateMode::Low.as_str(), "low");
        assert_eq!(VoiceBitrateMode::Standard.as_str(), "standard");
        assert_eq!(VoiceBitrateMode::High.as_str(), "high");
        assert_eq!(
            "standard".parse::<VoiceBitrateMode>(),
            Ok(VoiceBitrateMode::Standard)
        );
        assert!("lossless".parse::<VoiceBitrateMode>().is_err());
    }

    #[test]
    fn user_view_serializes_current_public_user_shape() {
        let user = UserView {
            id: "user-7".to_owned(),
            username: "Iyoku".to_owned(),
            color: "#abcdef".to_owned(),
            status: UserStatus::Offline,
            handle: Some("iyoku".to_owned()),
            profile_picture: Some("/profile.png".to_owned()),
            bio: None,
            joined_at: Some(123),
            db_user_id: Some(7),
            roles: Some(vec!["owner".to_owned()]),
            highest_role: Some("owner".to_owned()),
            role_color: Some("#ff00aa".to_owned()),
            username_font: Some(UsernameFont {
                family: Some("Atkinson".to_owned()),
                size: Some("16px".to_owned()),
                weight: Some("700".to_owned()),
                style: Some("italic".to_owned()),
            }),
        };

        let value = serde_json::to_value(user).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "id": "user-7",
                "username": "Iyoku",
                "color": "#abcdef",
                "status": "offline",
                "handle": "iyoku",
                "profilePicture": "/profile.png",
                "joinedAt": 123,
                "dbUserId": 7,
                "roles": ["owner"],
                "highestRole": "owner",
                "roleColor": "#ff00aa",
                "usernameFont": {
                    "family": "Atkinson",
                    "size": "16px",
                    "weight": "700",
                    "style": "italic"
                }
            })
        );
    }

    #[test]
    fn channel_view_serializes_current_channel_payload_shape() {
        let channel = ChannelView {
            id: "voice".to_owned(),
            name: "Voice".to_owned(),
            created_at: 456,
            channel_type: Some(ChannelType::Voice),
            description: Some("Main voice".to_owned()),
            watch_queue_enabled: Some(false),
            min_role: Some("guest".to_owned()),
            is_breakout: Some(true),
            breakout_index: Some(2),
            members: Some(vec!["user-7".to_owned(), "user-8".to_owned()]),
            avatar: Some("/group.png".to_owned()),
            parent_channel_id: Some("lobby".to_owned()),
            parent_message_id: Some("message-1".to_owned()),
            thread_archived: Some(false),
            thread_locked: Some(false),
            thread_auto_archive_minutes: Some(1440),
            thread_last_activity_at: Some(789),
            auto_delete_after: Some(MessageRetentionDuration::TwentyFourHours),
            is_temporary: Some(false),
            persist_messages: Some(true),
            pinned_by: Some(vec!["user-7".to_owned()]),
            voice_settings: Some(VoiceChannelSettings {
                bitrate_mode: Some(VoiceBitrateMode::Standard),
                user_limit: Some(8),
                force_solo: Some(true),
            }),
            topic: None,
        };

        let value = serde_json::to_value(channel).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "id": "voice",
                "name": "Voice",
                "createdAt": 456,
                "type": "voice",
                "description": "Main voice",
                "watchQueueEnabled": false,
                "minRole": "guest",
                "isBreakout": true,
                "breakoutIndex": 2,
                "members": ["user-7", "user-8"],
                "avatar": "/group.png",
                "parentChannelId": "lobby",
                "parentMessageId": "message-1",
                "threadArchived": false,
                "threadLocked": false,
                "threadAutoArchiveMinutes": 1440,
                "threadLastActivityAt": 789,
                "autoDeleteAfter": "24h",
                "isTemporary": false,
                "persistMessages": true,
                "pinnedBy": ["user-7"],
                "voiceSettings": {
                    "bitrateMode": "standard",
                    "userLimit": 8,
                    "forceSolo": true
                }
            })
        );
    }

    #[test]
    fn channel_created_event_is_wire_compatible_with_raw_channel_payloads() {
        let event = ChannelCreatedEvent(ChannelView {
            id: "general".to_owned(),
            name: "general".to_owned(),
            created_at: 1,
            channel_type: Some(ChannelType::Text),
            description: None,
            watch_queue_enabled: None,
            min_role: None,
            is_breakout: None,
            breakout_index: None,
            members: None,
            avatar: None,
            parent_channel_id: None,
            parent_message_id: None,
            thread_archived: None,
            thread_locked: None,
            thread_auto_archive_minutes: None,
            thread_last_activity_at: None,
            auto_delete_after: None,
            is_temporary: None,
            persist_messages: None,
            pinned_by: None,
            voice_settings: None,
            topic: None,
        });

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "id": "general",
                "name": "general",
                "createdAt": 1,
                "type": "text"
            })
        );
    }

    #[test]
    fn channel_updated_event_serializes_current_settings_update_payload_shape() {
        let event = ChannelUpdatedEvent {
            channel_id: "voice".to_owned(),
            auto_delete_after: Some(MessageRetentionDuration::ThirtyMinutes),
            persist_messages: Some(false),
            name: Some("Voice 2".to_owned()),
            description: Some("Updated".to_owned()),
            watch_queue_enabled: Some(true),
            min_role: Some("mod".to_owned()),
            voice_settings: Some(VoiceChannelSettings {
                bitrate_mode: Some(VoiceBitrateMode::High),
                user_limit: Some(12),
                force_solo: Some(false),
            }),
            topic: None,
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "channelId": "voice",
                "autoDeleteAfter": "30m",
                "persistMessages": false,
                "name": "Voice 2",
                "description": "Updated",
                "watchQueueEnabled": true,
                "minRole": "mod",
                "voiceSettings": {
                    "bitrateMode": "high",
                    "userLimit": 12,
                    "forceSolo": false
                }
            })
        );
    }

    #[test]
    fn session_view_serializes_current_guest_session_payload_shape() {
        let session = SessionView {
            session_id: "session-123".to_owned(),
        };

        assert_eq!(
            serde_json::to_value(session).unwrap(),
            serde_json::json!({
                "sessionId": "session-123"
            })
        );
    }

    #[test]
    fn direct_message_channel_event_serializes_current_dm_payload_shape() {
        let event = DirectMessageChannelEvent {
            channel_id: "dm-user-1-user-2".to_owned(),
            other_user: ConversationUserSummary {
                id: "user-2".to_owned(),
                username: "Iyoku".to_owned(),
                color: "#888888".to_owned(),
                status: UserStatus::Offline,
                profile_picture: None,
                db_user_id: Some(2),
            },
            channel: Some(ChannelView {
                id: "dm-user-1-user-2".to_owned(),
                name: "Ronin, Iyoku".to_owned(),
                created_at: 123,
                channel_type: Some(ChannelType::Dm),
                description: None,
                watch_queue_enabled: None,
                min_role: None,
                is_breakout: None,
                breakout_index: None,
                members: Some(vec!["user-1".to_owned(), "user-2".to_owned()]),
                avatar: None,
                parent_channel_id: None,
                parent_message_id: None,
                thread_archived: None,
                thread_locked: None,
                thread_auto_archive_minutes: None,
                thread_last_activity_at: None,
                auto_delete_after: Some(MessageRetentionDuration::TwentyFourHours),
                is_temporary: None,
                persist_messages: Some(true),
                pinned_by: None,
                voice_settings: None,
            topic: None,
            }),
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "channelId": "dm-user-1-user-2",
                "otherUser": {
                    "id": "user-2",
                    "username": "Iyoku",
                    "color": "#888888",
                    "status": "offline",
                    "dbUserId": 2
                },
                "channel": {
                    "id": "dm-user-1-user-2",
                    "name": "Ronin, Iyoku",
                    "createdAt": 123,
                    "type": "dm",
                    "members": ["user-1", "user-2"],
                    "autoDeleteAfter": "24h",
                    "persistMessages": true
                }
            })
        );
    }

    #[test]
    fn group_events_serialize_current_socket_payload_shapes() {
        let created = GroupCreatedEvent {
            id: "group-1".to_owned(),
            name: "Core".to_owned(),
            created_at: 456,
            channel_type: ChannelType::Group,
            members: vec!["user-1".to_owned(), "user-2".to_owned()],
            member_users: vec![ConversationUserSummary {
                id: "user-2".to_owned(),
                username: "Iyoku".to_owned(),
                color: "#888888".to_owned(),
                status: UserStatus::Offline,
                profile_picture: None,
                db_user_id: Some(2),
            }],
            auto_delete_after: Some(MessageRetentionDuration::TwentyFourHours),
            persist_messages: Some(true),
            avatar: None,
        };
        let added = GroupMemberAddedEvent {
            channel_id: "group-1".to_owned(),
            user_id: Some("user-2".to_owned()),
            user: Some(ConversationUserSummary {
                id: "user-2".to_owned(),
                username: "Iyoku".to_owned(),
                color: "#888888".to_owned(),
                status: UserStatus::Offline,
                profile_picture: None,
                db_user_id: Some(2),
            }),
        };
        let removed = GroupMemberRemovedEvent {
            channel_id: "group-1".to_owned(),
            user_id: "user-2".to_owned(),
        };
        let avatar = GroupAvatarUpdatedEvent {
            channel_id: "group-1".to_owned(),
            avatar: None,
        };

        assert_eq!(
            serde_json::to_value(created).unwrap(),
            serde_json::json!({
                "id": "group-1",
                "name": "Core",
                "createdAt": 456,
                "type": "group",
                "members": ["user-1", "user-2"],
                "memberUsers": [{
                    "id": "user-2",
                    "username": "Iyoku",
                    "color": "#888888",
                    "status": "offline",
                    "dbUserId": 2
                }],
                "autoDeleteAfter": "24h",
                "persistMessages": true
            })
        );
        assert_eq!(
            serde_json::to_value(added).unwrap(),
            serde_json::json!({
                "channelId": "group-1",
                "userId": "user-2",
                "user": {
                    "id": "user-2",
                    "username": "Iyoku",
                    "color": "#888888",
                    "status": "offline",
                    "dbUserId": 2
                }
            })
        );
        assert_eq!(
            serde_json::to_value(removed).unwrap(),
            serde_json::json!({
                "channelId": "group-1",
                "userId": "user-2"
            })
        );
        assert_eq!(
            serde_json::to_value(avatar).unwrap(),
            serde_json::json!({
                "channelId": "group-1"
            })
        );
    }

    #[test]
    fn user_left_event_serializes_current_disconnect_payload_shape() {
        let event = UserLeftEvent {
            id: "user-7".to_owned(),
            username: "Ronin".to_owned(),
            db_user_id: Some(7),
            joined_at: Some(123),
        };

        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "id": "user-7",
                "username": "Ronin",
                "dbUserId": 7,
                "joinedAt": 123
            })
        );
    }

    #[test]
    fn serde_strings_match_current_workspace_contract() {
        assert_eq!(
            serde_json::to_string(&UserStatus::Busy).unwrap(),
            "\"busy\""
        );
        assert_eq!(
            serde_json::from_str::<UserStatus>("\"offline\"").unwrap(),
            UserStatus::Offline
        );
        assert_eq!(
            serde_json::to_string(&VoiceBitrateMode::High).unwrap(),
            "\"high\""
        );
        assert_eq!(
            serde_json::from_str::<VoiceBitrateMode>("\"auto\"").unwrap(),
            VoiceBitrateMode::Auto
        );
    }
}
