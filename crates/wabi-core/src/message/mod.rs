mod attachments;
mod events;

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

pub use attachments::*;
pub use events::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct MessageCreateCommand {
    pub channel_id: String,
    pub text: String,
    #[serde(rename = "type")]
    pub message_type: MessageType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_spoiler: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_gate_persist: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gif_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<FileAttachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_encryption: Option<AttachmentEncryptionMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_storage: Option<AttachmentStorageMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entities: Option<Vec<MessageEntity>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct MessageView {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    pub user: String,
    pub user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_stable_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub text: String,
    pub timestamp: u64,
    #[serde(rename = "type")]
    pub message_type: MessageType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_deletion_time: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gif_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<FileAttachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_encryption: Option<AttachmentEncryptionMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_storage: Option<AttachmentStorageMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_pinned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_edited: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encrypted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iv: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_spoiler: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reactions: Option<BTreeMap<String, Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entities: Option<Vec<MessageEntity>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct MessageEntity {
    pub kind: MessageEntityKind,
    pub start: u32,
    pub end: u32,
    /// Canonical id for the referenced entity. For legacy Place payloads, this field
    /// was named `place_id` and is still accepted on deserialization via serde alias.
    #[serde(alias = "placeId")]
    pub target_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poi_id: Option<String>,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_subtitle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_thumb_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_status: Option<String>,
}

#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum MessageEntityKind {
    Place,
    User,
    Channel,
    ForumPost,
    WikiPage,
    GalleryWork,
}

#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum MessageType {
    Text,
    Gif,
    File,
    Emoji,
    RoleGate,
}

#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum ChannelType {
    Text,
    Voice,
    Dm,
    Group,
    Public,
    ThreadPublic,
    ThreadPrivate,
    Forum,
    Gallery,
    Wiki,
    Stage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MessageTypeParseError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelTypeParseError;

impl MessageType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Gif => "gif",
            Self::File => "file",
            Self::Emoji => "emoji",
            Self::RoleGate => "role_gate",
        }
    }
}

impl ChannelType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Voice => "voice",
            Self::Dm => "dm",
            Self::Group => "group",
            Self::Public => "public",
            Self::ThreadPublic => "thread_public",
            Self::ThreadPrivate => "thread_private",
            Self::Forum => "forum",
            Self::Gallery => "gallery",
            Self::Wiki => "wiki",
            Self::Stage => "stage",
        }
    }
}

impl fmt::Display for MessageType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl fmt::Display for ChannelType {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for MessageType {
    type Err = MessageTypeParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "text" => Ok(Self::Text),
            "gif" => Ok(Self::Gif),
            "file" => Ok(Self::File),
            "emoji" => Ok(Self::Emoji),
            "role_gate" => Ok(Self::RoleGate),
            _ => Err(MessageTypeParseError),
        }
    }
}

impl FromStr for ChannelType {
    type Err = ChannelTypeParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "text" => Ok(Self::Text),
            "voice" => Ok(Self::Voice),
            "dm" => Ok(Self::Dm),
            "group" => Ok(Self::Group),
            "public" => Ok(Self::Public),
            "thread_public" => Ok(Self::ThreadPublic),
            "thread_private" => Ok(Self::ThreadPrivate),
            "forum" => Ok(Self::Forum),
            "gallery" => Ok(Self::Gallery),
            "wiki" => Ok(Self::Wiki),
            "stage" => Ok(Self::Stage),
            _ => Err(ChannelTypeParseError),
        }
    }
}

pub fn normalize_client_message_id(value: &str) -> Option<String> {
    let trimmed = value.trim();

    if !is_valid_client_message_id(trimmed) {
        return None;
    }

    Some(trimmed.to_owned())
}

pub fn is_valid_client_message_id(value: &str) -> bool {
    let length = value.len();
    (8..=120).contains(&length)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'_' | b'-'))
}
