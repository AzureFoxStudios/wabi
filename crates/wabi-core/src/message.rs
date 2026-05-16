use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
#[cfg(feature = "ts")]
use ts_rs::TS;

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
pub struct MessageCreatedEvent {
    pub channel_id: String,
    pub message: MessageView,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct ChannelMessageWindowEvent {
    pub channel_id: String,
    pub messages: Vec<MessageView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_more: Option<bool>,
}

#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum HistoryDirection {
    Older,
    Newer,
    Initial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct HistoryLoadedEvent {
    pub channel_id: String,
    pub messages: Vec<MessageView>,
    pub has_more: bool,
    pub direction: HistoryDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct OfflineMessagesEvent {
    pub channel_id: String,
    pub messages: Vec<MessageView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct MessageAcceptedEvent {
    pub channel_id: String,
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_deletion_time: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct MessagePersistFailedEvent {
    pub channel_id: String,
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct MessagePersistedEvent {
    pub channel_id: String,
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempts: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct MessageQueuedEvent {
    pub message_id: String,
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
pub struct FileAttachment {
    pub file_url: String,
    pub file_name: String,
    pub file_size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_encryption: Option<AttachmentEncryptionMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_storage: Option<AttachmentStorageMeta>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct AttachmentEncryptionMeta {
    pub scheme: AttachmentEncryptionScheme,
    pub iv: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_size: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct AttachmentStorageMeta {
    pub scheme: AttachmentStorageScheme,
    pub compressed: bool,
    pub codec: AttachmentStorageCodec,
    pub original_size: u64,
    pub stored_size: u64,
    pub at_rest_encrypted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", ts(export))]
pub struct MessageEntity {
    pub kind: MessageEntityKind,
    pub start: u32,
    pub end: u32,
    pub place_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poi_id: Option<String>,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
}

#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub enum AttachmentEncryptionScheme {
    #[serde(rename = "dm-e2ee-v1")]
    #[cfg_attr(feature = "ts", ts(rename = "dm-e2ee-v1"))]
    DmE2eeV1,
}

#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[cfg_attr(feature = "ts", ts(export))]
pub enum AttachmentStorageScheme {
    #[serde(rename = "wabi-storage-v1")]
    #[cfg_attr(feature = "ts", ts(rename = "wabi-storage-v1"))]
    WabiStorageV1,
}

#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum AttachmentStorageCodec {
    Identity,
    Gzip,
}

#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(TS))]
#[serde(rename_all = "snake_case")]
#[cfg_attr(feature = "ts", ts(export))]
pub enum MessageEntityKind {
    Place,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_type_strings_match_current_socket_contract() {
        assert_eq!(MessageType::Text.as_str(), "text");
        assert_eq!(MessageType::Gif.as_str(), "gif");
        assert_eq!(MessageType::File.as_str(), "file");
        assert_eq!(MessageType::Emoji.as_str(), "emoji");
        assert_eq!(MessageType::RoleGate.as_str(), "role_gate");
        assert_eq!(
            "role_gate".parse::<MessageType>(),
            Ok(MessageType::RoleGate)
        );
        assert!("unknown".parse::<MessageType>().is_err());
    }

    #[test]
    fn channel_type_strings_match_current_socket_contract() {
        assert_eq!(ChannelType::Text.as_str(), "text");
        assert_eq!(ChannelType::Voice.as_str(), "voice");
        assert_eq!(ChannelType::Dm.as_str(), "dm");
        assert_eq!(ChannelType::Group.as_str(), "group");
        assert_eq!(ChannelType::Public.as_str(), "public");
        assert_eq!(ChannelType::ThreadPublic.as_str(), "thread_public");
        assert_eq!(ChannelType::ThreadPrivate.as_str(), "thread_private");
        assert_eq!(ChannelType::Forum.as_str(), "forum");
        assert_eq!(ChannelType::Gallery.as_str(), "gallery");
        assert_eq!(ChannelType::Wiki.as_str(), "wiki");
        assert_eq!(ChannelType::Stage.as_str(), "stage");
        assert_eq!(
            "thread_private".parse::<ChannelType>(),
            Ok(ChannelType::ThreadPrivate)
        );
        assert!("category".parse::<ChannelType>().is_err());
    }

    #[test]
    fn client_message_ids_match_backend_regex_contract() {
        assert_eq!(
            normalize_client_message_id(" client:message_123 "),
            Some("client:message_123".to_owned())
        );
        assert!(is_valid_client_message_id("abcdefgh"));
        assert!(is_valid_client_message_id("abcDEF12:_-"));
        assert!(!is_valid_client_message_id("abcdefg"));
        assert!(!is_valid_client_message_id(&"a".repeat(121)));
        assert!(!is_valid_client_message_id("message id"));
        assert!(!is_valid_client_message_id("message.id"));
        assert!(!is_valid_client_message_id("emoji-😀"));
    }

    #[test]
    fn serde_strings_match_current_socket_contract() {
        assert_eq!(
            serde_json::to_string(&MessageType::RoleGate).unwrap(),
            "\"role_gate\""
        );
        assert_eq!(
            serde_json::from_str::<MessageType>("\"file\"").unwrap(),
            MessageType::File
        );
        assert_eq!(
            serde_json::to_string(&ChannelType::ThreadPrivate).unwrap(),
            "\"thread_private\""
        );
        assert_eq!(
            serde_json::from_str::<ChannelType>("\"voice\"").unwrap(),
            ChannelType::Voice
        );
    }

    #[test]
    fn message_create_command_serializes_current_socket_payload_shape() {
        let command = MessageCreateCommand {
            channel_id: "channel-1".to_owned(),
            text: "hello".to_owned(),
            message_type: MessageType::Text,
            client_message_id: Some("client:message_123".to_owned()),
            reply_to: Some("message-1".to_owned()),
            is_spoiler: Some(true),
            encrypted: Some(false),
            iv: None,
            role_gate_persist: None,
            gif_url: None,
            emoji_url: None,
            emoji_name: None,
            file_url: None,
            file_name: None,
            file_size: None,
            files: None,
            attachment_encryption: None,
            attachment_storage: None,
            entities: None,
        };

        let value = serde_json::to_value(command).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "channelId": "channel-1",
                "text": "hello",
                "type": "text",
                "clientMessageId": "client:message_123",
                "replyTo": "message-1",
                "isSpoiler": true,
                "encrypted": false
            })
        );
    }

    #[test]
    fn message_create_command_deserializes_minimal_current_socket_payload() {
        let command: MessageCreateCommand = serde_json::from_value(serde_json::json!({
            "channelId": "channel-1",
            "text": "hello",
            "type": "gif"
        }))
        .unwrap();

        assert_eq!(command.channel_id, "channel-1");
        assert_eq!(command.text, "hello");
        assert_eq!(command.message_type, MessageType::Gif);
        assert_eq!(command.client_message_id, None);
    }

    #[test]
    fn file_attachment_metadata_serializes_current_payload_shape() {
        let attachment = FileAttachment {
            file_url: "/uploads/file.png".to_owned(),
            file_name: "file.png".to_owned(),
            file_size: 42,
            attachment_encryption: Some(AttachmentEncryptionMeta {
                scheme: AttachmentEncryptionScheme::DmE2eeV1,
                iv: "iv-123".to_owned(),
                mime_type: Some("image/png".to_owned()),
                original_size: Some(42),
            }),
            attachment_storage: Some(AttachmentStorageMeta {
                scheme: AttachmentStorageScheme::WabiStorageV1,
                compressed: true,
                codec: AttachmentStorageCodec::Gzip,
                original_size: 84,
                stored_size: 42,
                at_rest_encrypted: true,
            }),
        };

        let value = serde_json::to_value(attachment).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "fileUrl": "/uploads/file.png",
                "fileName": "file.png",
                "fileSize": 42,
                "attachmentEncryption": {
                    "scheme": "dm-e2ee-v1",
                    "iv": "iv-123",
                    "mimeType": "image/png",
                    "originalSize": 42
                },
                "attachmentStorage": {
                    "scheme": "wabi-storage-v1",
                    "compressed": true,
                    "codec": "gzip",
                    "originalSize": 84,
                    "storedSize": 42,
                    "atRestEncrypted": true
                }
            })
        );
    }

    #[test]
    fn message_entity_serializes_current_place_entity_shape() {
        let entity = MessageEntity {
            kind: MessageEntityKind::Place,
            start: 0,
            end: 5,
            place_id: "studio".to_owned(),
            layer_id: Some("floor-1".to_owned()),
            poi_id: None,
            label: "Studio".to_owned(),
            display_text: Some("there".to_owned()),
        };

        let value = serde_json::to_value(entity).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "kind": "place",
                "start": 0,
                "end": 5,
                "placeId": "studio",
                "layerId": "floor-1",
                "label": "Studio",
                "displayText": "there"
            })
        );
    }

    #[test]
    fn message_create_command_accepts_attachments_and_entities() {
        let command: MessageCreateCommand = serde_json::from_value(serde_json::json!({
            "channelId": "channel-1",
            "text": "meet here",
            "type": "file",
            "fileUrl": "/uploads/file.png",
            "fileName": "file.png",
            "fileSize": 42,
            "files": [{
                "fileUrl": "/uploads/file.png",
                "fileName": "file.png",
                "fileSize": 42
            }],
            "entities": [{
                "kind": "place",
                "start": 5,
                "end": 9,
                "placeId": "studio",
                "label": "Studio"
            }]
        }))
        .unwrap();

        assert_eq!(command.file_size, Some(42));
        assert_eq!(command.files.as_ref().map(Vec::len), Some(1));
        assert_eq!(command.entities.as_ref().map(Vec::len), Some(1));
    }

    #[test]
    fn message_view_serializes_current_client_message_shape() {
        let mut reactions = BTreeMap::new();
        reactions.insert("thumbsup".to_owned(), vec!["user-1".to_owned()]);

        let message = MessageView {
            id: "message-1".to_owned(),
            client_message_id: Some("client:message_123".to_owned()),
            user: "Ronin".to_owned(),
            user_id: "socket-1".to_owned(),
            sender_stable_id: Some("user-1".to_owned()),
            color: Some("#ffcc00".to_owned()),
            text: "meet here".to_owned(),
            timestamp: 1_777_000_000_000,
            message_type: MessageType::File,
            scheduled_deletion_time: Some(1_777_000_060_000),
            gif_url: None,
            emoji_url: None,
            emoji_name: None,
            file_url: Some("/uploads/file.png".to_owned()),
            file_name: Some("file.png".to_owned()),
            file_size: Some(42),
            files: Some(vec![FileAttachment {
                file_url: "/uploads/file.png".to_owned(),
                file_name: "file.png".to_owned(),
                file_size: 42,
                attachment_encryption: None,
                attachment_storage: None,
            }]),
            attachment_encryption: Some(AttachmentEncryptionMeta {
                scheme: AttachmentEncryptionScheme::DmE2eeV1,
                iv: "iv-123".to_owned(),
                mime_type: None,
                original_size: None,
            }),
            attachment_storage: Some(AttachmentStorageMeta {
                scheme: AttachmentStorageScheme::WabiStorageV1,
                compressed: false,
                codec: AttachmentStorageCodec::Identity,
                original_size: 42,
                stored_size: 42,
                at_rest_encrypted: false,
            }),
            is_pinned: Some(true),
            is_edited: Some(false),
            encrypted: Some(true),
            iv: Some("message-iv".to_owned()),
            reply_to: Some("message-0".to_owned()),
            is_spoiler: Some(true),
            reactions: Some(reactions),
            entities: Some(vec![MessageEntity {
                kind: MessageEntityKind::Place,
                start: 5,
                end: 9,
                place_id: "studio".to_owned(),
                layer_id: None,
                poi_id: None,
                label: "Studio".to_owned(),
                display_text: None,
            }]),
        };

        let value = serde_json::to_value(message).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "id": "message-1",
                "clientMessageId": "client:message_123",
                "user": "Ronin",
                "userId": "socket-1",
                "senderStableId": "user-1",
                "color": "#ffcc00",
                "text": "meet here",
                "timestamp": 1777000000000u64,
                "type": "file",
                "scheduledDeletionTime": 1777000060000u64,
                "fileUrl": "/uploads/file.png",
                "fileName": "file.png",
                "fileSize": 42,
                "files": [{
                    "fileUrl": "/uploads/file.png",
                    "fileName": "file.png",
                    "fileSize": 42
                }],
                "attachmentEncryption": {
                    "scheme": "dm-e2ee-v1",
                    "iv": "iv-123"
                },
                "attachmentStorage": {
                    "scheme": "wabi-storage-v1",
                    "compressed": false,
                    "codec": "identity",
                    "originalSize": 42,
                    "storedSize": 42,
                    "atRestEncrypted": false
                },
                "isPinned": true,
                "isEdited": false,
                "encrypted": true,
                "iv": "message-iv",
                "replyTo": "message-0",
                "isSpoiler": true,
                "reactions": {
                    "thumbsup": ["user-1"]
                },
                "entities": [{
                    "kind": "place",
                    "start": 5,
                    "end": 9,
                    "placeId": "studio",
                    "label": "Studio"
                }]
            })
        );
    }

    #[test]
    fn message_view_deserializes_minimal_history_message_shape() {
        let message: MessageView = serde_json::from_value(serde_json::json!({
            "id": "message-1",
            "user": "Ronin",
            "userId": "user-1",
            "text": "hello",
            "timestamp": 1777000000000u64,
            "type": "text"
        }))
        .unwrap();

        assert_eq!(message.id, "message-1");
        assert_eq!(message.message_type, MessageType::Text);
        assert_eq!(message.sender_stable_id, None);
    }

    #[test]
    fn message_created_event_serializes_current_socket_payload_shape() {
        let event = MessageCreatedEvent {
            channel_id: "general".to_owned(),
            message: MessageView {
                id: "message-1".to_owned(),
                client_message_id: None,
                user: "Ronin".to_owned(),
                user_id: "socket-1".to_owned(),
                sender_stable_id: Some("user-1".to_owned()),
                color: None,
                text: "hello".to_owned(),
                timestamp: 1_777_000_000_000,
                message_type: MessageType::Text,
                scheduled_deletion_time: None,
                gif_url: None,
                emoji_url: None,
                emoji_name: None,
                file_url: None,
                file_name: None,
                file_size: None,
                files: None,
                attachment_encryption: None,
                attachment_storage: None,
                is_pinned: None,
                is_edited: None,
                encrypted: None,
                iv: None,
                reply_to: None,
                is_spoiler: None,
                reactions: None,
                entities: None,
            },
        };

        let value = serde_json::to_value(event).unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "channelId": "general",
                "message": {
                    "id": "message-1",
                    "user": "Ronin",
                    "userId": "socket-1",
                    "senderStableId": "user-1",
                    "text": "hello",
                    "timestamp": 1777000000000u64,
                    "type": "text"
                }
            })
        );
    }

    #[test]
    fn message_window_events_serialize_current_socket_payloads() {
        let message = MessageView {
            id: "message-1".to_owned(),
            client_message_id: None,
            user: "Ronin".to_owned(),
            user_id: "user-1".to_owned(),
            sender_stable_id: None,
            color: None,
            text: "hello".to_owned(),
            timestamp: 123,
            message_type: MessageType::Text,
            scheduled_deletion_time: None,
            gif_url: None,
            emoji_url: None,
            emoji_name: None,
            file_url: None,
            file_name: None,
            file_size: None,
            files: None,
            attachment_encryption: None,
            attachment_storage: None,
            is_pinned: None,
            is_edited: None,
            encrypted: None,
            iv: None,
            reply_to: None,
            is_spoiler: None,
            reactions: None,
            entities: None,
        };

        let window = ChannelMessageWindowEvent {
            channel_id: "general".to_owned(),
            messages: vec![message.clone()],
            has_more: Some(true),
        };
        let history = HistoryLoadedEvent {
            channel_id: "general".to_owned(),
            messages: vec![message.clone()],
            has_more: false,
            direction: HistoryDirection::Initial,
            request_id: Some("general:1".to_owned()),
        };
        let offline = OfflineMessagesEvent {
            channel_id: "general".to_owned(),
            messages: vec![message],
        };

        assert_eq!(
            serde_json::to_value(window).unwrap(),
            serde_json::json!({
                "channelId": "general",
                "messages": [{
                    "id": "message-1",
                    "user": "Ronin",
                    "userId": "user-1",
                    "text": "hello",
                    "timestamp": 123,
                    "type": "text"
                }],
                "hasMore": true
            })
        );
        assert_eq!(
            serde_json::to_value(history).unwrap(),
            serde_json::json!({
                "channelId": "general",
                "messages": [{
                    "id": "message-1",
                    "user": "Ronin",
                    "userId": "user-1",
                    "text": "hello",
                    "timestamp": 123,
                    "type": "text"
                }],
                "hasMore": false,
                "direction": "initial",
                "requestId": "general:1"
            })
        );
        assert_eq!(
            serde_json::to_value(offline).unwrap(),
            serde_json::json!({
                "channelId": "general",
                "messages": [{
                    "id": "message-1",
                    "user": "Ronin",
                    "userId": "user-1",
                    "text": "hello",
                    "timestamp": 123,
                    "type": "text"
                }]
            })
        );
    }
}
