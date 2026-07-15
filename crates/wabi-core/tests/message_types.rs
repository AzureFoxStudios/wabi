use std::collections::BTreeMap;
use wabi_core::{
    is_valid_client_message_id, normalize_client_message_id, AttachmentEncryptionMeta,
    AttachmentEncryptionScheme, AttachmentStorageCodec, AttachmentStorageMeta,
    AttachmentStorageScheme, ChannelMessageWindowEvent, ChannelType, FileAttachment,
    HistoryDirection, HistoryLoadedEvent, MessageCreateCommand,
    MessageCreatedEvent, MessageEntity, MessageEntityKind,
    MessageType, MessageView, OfflineMessagesEvent,
};

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
    assert!(!is_valid_client_message_id("emoji-\u{1F600}"));
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
