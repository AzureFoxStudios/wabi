//! Shared Wabi protocol and domain logic.
//!
//! This crate is intentionally pure: no networking, database, Tauri, DOM, or
//! deployment assumptions. Runtime-specific crates and apps should adapt these
//! types and validators to their own transports.

pub mod auth;
pub mod message;
pub mod message_retention;
pub mod plugin;
pub mod workspace;

pub use auth::{
    AuthResponse, AuthSessionView, GuestCode, JwtClaims, LoginCommand, RegisterCommand,
    SessionCreatedEvent, SessionDestroyedEvent, SessionEndReason, UserRole,
};
pub use message::{
    is_valid_client_message_id, normalize_client_message_id, AttachmentEncryptionMeta,
    AttachmentEncryptionScheme, AttachmentStorageCodec, AttachmentStorageMeta,
    AttachmentStorageScheme, ChannelMessageWindowEvent, ChannelType, FileAttachment,
    HistoryDirection, HistoryLoadedEvent, MessageAcceptedEvent, MessageCreateCommand,
    MessageCreatedEvent, MessageEntity, MessageEntityKind, MessagePersistFailedEvent,
    MessagePersistedEvent, MessageQueuedEvent, MessageType, MessageView, OfflineMessagesEvent,
};
pub use message_retention::{
    format_message_retention_label, message_retention_to_ms, normalize_message_retention_duration,
    MessageRetentionDuration, MESSAGE_RETENTION_PRESETS,
};
pub use plugin::{
    PluginApiMethod, PluginConfig, PluginError, PluginEvent, PluginManifest, PluginPermission,
    PluginStatus,
};
pub use workspace::{
    ChannelCreatedEvent, ChannelUpdatedEvent, ChannelView, ConversationUserSummary,
    DirectMessageChannelEvent, GroupAvatarUpdatedEvent, GroupCreatedEvent, GroupMemberAddedEvent,
    GroupMemberRemovedEvent, GroupRemovedEvent, UserLeftEvent, UserStatus, UserView, UsernameFont,
    VoiceBitrateMode, VoiceChannelParticipantView, VoiceChannelSettings, VoiceChannelStateEvent,
    VoiceChannelSubscriptionEvent, VoiceChannelUserJoinedEvent, VoiceChannelUserLeftEvent,
    VoiceStateEvent,
};
