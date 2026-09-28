mod groups;
mod voice;

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

use crate::ChannelType;
use crate::MessageRetentionDuration;

pub use groups::*;
pub use voice::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum NameStyleEffect {
    Solid,
    Gradient,
    Glow,
    Shimmer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum NameplateStyle {
    None,
    Solid,
    Gradient,
    Outline,
}

/// Declarative appearance values; this is a JSON wire type, not a durable record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "ts", ts(export))]
pub struct NameStyleDesign {
    pub effect: NameStyleEffect,
    pub color: String,
    pub color2: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub angle: serde_json::Number,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub glow: serde_json::Number,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub animation_seconds: serde_json::Number,
    pub plate: NameplateStyle,
    pub plate_color: String,
    pub plate_color2: String,
    #[cfg_attr(feature = "ts", ts(type = "number"))]
    pub plate_opacity: serde_json::Number,
}

impl NameStyleDesign {
    pub fn validate(&self) -> Result<(), String> {
        for (name, color) in [
            ("color", &self.color),
            ("color2", &self.color2),
            ("plateColor", &self.plate_color),
            ("plateColor2", &self.plate_color2),
        ] {
            if color.len() != 7
                || !color.starts_with('#')
                || !color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            {
                return Err(format!("design.{name} must be a #RRGGBB color"));
            }
        }
        for (name, number, min, max) in [
            ("angle", &self.angle, 0.0, 360.0),
            ("glow", &self.glow, 0.0, 12.0),
            ("animationSeconds", &self.animation_seconds, 4.0, 20.0),
            ("plateOpacity", &self.plate_opacity, 0.0, 1.0),
        ] {
            if !number
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= min && n <= max)
            {
                return Err(format!("design.{name} must be between {min} and {max}"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct UsernameFont {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design: Option<NameStyleDesign>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
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
    /// False for guest accounts (no password). True for registered users.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_registered: Option<bool>,
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
#[cfg_attr(not(feature = "ts"), serde(transparent))]
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
