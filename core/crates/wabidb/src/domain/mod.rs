//! Domain types for the WabiDB storage API.
//!
//! These are the typed domain objects returned by [`crate::engine::WabiStore`]
//! read methods. They match the wabi-server's data model (User, Channel,
//! Message, ChannelMember, Reaction) but are owned by wabidb so the engine
//! is self-contained.
//!
//! The wabi-server's adapter translates between these types and the
//! wabi-core types used by the frontend.

use serde::{Deserialize, Serialize};

/// A registered user account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct User {
    pub user_id: u64,
    pub username: String,
    pub handle: Option<String>,
    pub color: String,
    pub password_hash: String,
    pub is_registered: bool,
    pub is_active: bool,
    pub created_at_micros: i64,
    pub last_seen_micros: i64,
    pub profile_picture: Option<String>,
    pub username_font: Option<String>,
    pub bio: Option<String>,
    pub status_message: Option<String>,
}

impl User {
    /// Construct a new user with sensible defaults.
    pub fn new(user_id: u64, username: impl Into<String>, password_hash: impl Into<String>) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0);
        Self {
            user_id,
            username: username.into(),
            handle: None,
            color: "blue".to_string(),
            password_hash: password_hash.into(),
            is_registered: true,
            is_active: true,
            created_at_micros: now,
            last_seen_micros: now,
            profile_picture: None,
            username_font: None,
            bio: None,
            status_message: None,
        }
    }
}

/// A set of mutable profile fields to patch onto a user. `None` means
/// "leave unchanged"; `Some(value)` means "set to this value" (an empty
/// string clears the field).
#[derive(Debug, Clone, Default)]
pub struct UserUpdate {
    pub username: Option<String>,
    pub color: Option<String>,
    pub profile_picture: Option<String>,
    pub username_font: Option<String>,
    pub bio: Option<String>,
    pub status_message: Option<String>,
    /// When set, replaces the stored password hash (already bcrypt/argon hashed).
    pub password_hash: Option<String>,
}

/// A channel in Wabi (text, voice, DM, etc.).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Channel {
    pub channel_id: String,
    pub name: String,
    pub channel_kind: ChannelKind,
    pub owner_user_id: u64,
    pub created_at_micros: i64,
    pub is_active: bool,
    /// Free-form channel description (shown in channel settings).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Sort position for sidebar ordering.
    #[serde(default)]
    pub position: i32,
    /// Parent channel ID for nested channels (e.g. announcement threads).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// When true, a Lore asset storage repo is auto-created for this channel.
    #[serde(default)]
    pub asset_storage: bool,
    /// When true, every message sent in this channel is automatically marked
    /// as a spoiler (and existing messages render spoiled by default).
    #[serde(default)]
    pub force_spoiler: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[repr(u8)]
pub enum ChannelKind {
    Text = 0,
    Voice = 1,
    Dm = 2,
    GroupDm = 3,
    Announcement = 4,
    Whiteboard = 5,
    Wiki = 6,
    Forum = 7,
    Incident = 8,
}

impl Channel {
    pub fn new(channel_id: impl Into<String>, name: impl Into<String>, owner_user_id: u64) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0);
        Self {
            channel_id: channel_id.into(),
            name: name.into(),
            channel_kind: ChannelKind::Text,
            owner_user_id,
            created_at_micros: now,
            is_active: true,
            description: None,
            position: 0,
            parent_id: None,
            asset_storage: false,
            force_spoiler: false,
        }
    }
}

/// A message in a channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Message {
    pub message_id: String,
    pub channel_id: String,
    pub author_user_id: u64,
    /// Optional cached username for the author. Populated by the projection
    /// when the user lookup succeeds. The frontend prefers this over a
    /// second round-trip to /users/{id}.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_username: Option<String>,
    /// Optional cached display name / handle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_display_name: Option<String>,
    pub author_device_id: String,
    pub content: String,
    pub message_type: String,
    pub created_at_micros: i64,
    pub edited_at_micros: Option<i64>,
    pub commit_seq: u64,
    pub is_deleted: bool,
    /// When true, the message content is hidden behind a spoiler veil by
    /// default. Also forced on by a channel's `force_spoiler` flag.
    #[serde(default)]
    pub is_spoiler: bool,
}

/// A reaction on a message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Reaction {
    pub message_id: String,
    pub user_id: u64,
    pub emote: String,
    pub created_at_micros: i64,
}

/// A member of a channel with their role.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChannelMember {
    pub channel_id: String,
    pub user_id: u64,
    pub role: MemberRole,
    pub joined_at_micros: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[repr(u8)]
pub enum MemberRole {
    Member = 0,
    Moderator = 1,
    Admin = 2,
    Owner = 3,
}

/// A ban record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Ban {
    pub channel_id: String,
    pub user_id: u64,
    pub banned_by_user_id: u64,
    pub reason: String,
    pub banned_at_micros: i64,
}

/// A role definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoleDefinition {
    pub channel_id: String,
    pub role: MemberRole,
    pub permissions: u64,
    pub description: String,
}

/// A custom emote definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Emote {
    pub emote_id: String,
    pub name: String,
    pub image_url: String,
    pub created_at_micros: i64,
    pub created_by_user_id: u64,
}

/// A webhook attached to a channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Webhook {
    pub webhook_id: String,
    pub channel_id: String,
    pub name: String,
    pub url: String,
    pub created_at_micros: i64,
    pub created_by_user_id: u64,
}

/// A user's saved layout (position/sizing of UI panels).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UserLayout {
    pub user_id: u64,
    pub layout_json: String,
    pub updated_at_micros: i64,
}

/// Retention policy for a channel (auto-delete messages after N days).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RetentionPolicy {
    pub channel_id: String,
    pub days: u32,
    pub set_at_micros: i64,
    pub set_by_user_id: u64,
}

/// A rule that grants a role when a specific emoji reaction is added to a message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EmojiRoleRule {
    pub message_id: String,
    pub emote: String,
    pub role: MemberRole,
    pub set_at_micros: i64,
}

/// A mute record for a user in a channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MuteRecord {
    pub channel_id: String,
    pub user_id: u64,
    pub muted_by_user_id: u64,
    pub until_micros: i64,
    pub set_at_micros: i64,
}

/// A deafen record for a user in a channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeafenRecord {
    pub channel_id: String,
    pub user_id: u64,
    pub deafened_by_user_id: u64,
    pub set_at_micros: i64,
}

/// A voice/video call session scoped to one channel.
///
/// Replaces the WDB `state_call_session` table. Created by
/// `wabidb::commands::call_session_create::create_call_session`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CallSession {
    /// Synthetic session id (caller-chosen, e.g. "session-1234567890-abc").
    pub session_id: String,
    /// Channel the call belongs to.
    pub channel_id: String,
    /// "audio-call" | "video-call" | "screen-share".
    pub call_type: String,
    /// User id of the call host (initiator).
    pub host_user_id: u64,
    /// Unix micros when the session was created.
    pub started_at_micros: i64,
    /// Unix micros when the session was ended, or None if still active.
    pub ended_at_micros: Option<i64>,
    /// Transport used: "webrtc" | "sfu" | "wabidb".
    pub transport: String,
    /// Cap on participants; 0 means unlimited.
    pub max_participants: u32,
    /// Whether the session is still active.
    pub active: bool,
    /// Unix micros of last projection update.
    pub last_updated_at_micros: i64,
}

impl CallSession {
    /// Construct a new active call session with sensible defaults.
    pub fn new(
        session_id: impl Into<String>,
        channel_id: impl Into<String>,
        call_type: impl Into<String>,
        host_user_id: u64,
        max_participants: u32,
        transport: impl Into<String>,
    ) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0);
        Self {
            session_id: session_id.into(),
            channel_id: channel_id.into(),
            call_type: call_type.into(),
            host_user_id,
            started_at_micros: now,
            ended_at_micros: None,
            transport: transport.into(),
            max_participants,
            active: true,
            last_updated_at_micros: now,
        }
    }
}

/// One participant in a call session.
///
/// Replaces the WDB `state_call_participant` table. The synthetic
/// `participant_key` is `<session_id>:<user_id>` and serves as the
/// primary key in the projection index.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CallParticipant {
    /// `<session_id>:<user_id>` synthetic primary key.
    pub participant_key: String,
    pub session_id: String,
    pub user_id: u64,
    /// Client-side UUID that survives reconnects.
    pub stable_user_id: String,
    /// Unix micros when the participant joined.
    pub joined_at_micros: i64,
    /// Unix micros when the participant left, or None if still in the call.
    pub left_at_micros: Option<i64>,
    /// Whether this participant is the call host.
    pub is_host: bool,
    /// Whether the participant is muted.
    pub muted: bool,
    /// Whether the participant has video enabled.
    pub video_enabled: bool,
    /// Unix micros of last projection update.
    pub last_updated_at_micros: i64,
}

impl CallParticipant {
    /// Construct a new participant record.
    pub fn new(
        session_id: impl Into<String>,
        user_id: u64,
        stable_user_id: impl Into<String>,
        is_host: bool,
    ) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0);
        let session_id = session_id.into();
        Self {
            participant_key: format!("{}:{}", session_id, user_id),
            session_id,
            user_id,
            stable_user_id: stable_user_id.into(),
            joined_at_micros: now,
            left_at_micros: None,
            is_host,
            muted: false,
            video_enabled: false,
            last_updated_at_micros: now,
        }
    }
}

/// A signaling message within a call (offer/answer/ICE/mute/kick/etc).
///
/// Replaces the WDB `state_call_signal` table. `signal_id` is assigned
/// by the caller (the command), so it survives engine restart and
/// remains monotonic per session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CallSignal {
    /// Monotonic per session, assigned by the command.
    pub signal_id: u64,
    pub session_id: String,
    pub from_user_id: u64,
    /// "offer" | "answer" | "ice" | "mute" | "unmute" | "kick" | ...
    pub signal_type: String,
    /// Target user id for unicast signals; None for broadcast.
    pub target_user_id: Option<u64>,
    /// JSON-stringified signal body.
    pub payload: String,
    /// Unix micros when the signal was emitted.
    pub created_at_micros: i64,
}

/// An album (media collection) scoped to a channel or user.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Album {
    pub album_id: String,
    pub scope_type: String,
    pub scope_id: String,
    pub name: String,
    pub description: String,
    pub owner_user_id: u64,
    pub cover_url: String,
    pub created_at_micros: i64,
    pub updated_at_micros: i64,
    pub is_deleted: bool,
}

impl From<crate::projections::albums::AlbumRecord> for Album {
    fn from(r: crate::projections::albums::AlbumRecord) -> Self {
        Self {
            album_id: r.album_id,
            scope_type: r.scope_type,
            scope_id: r.scope_id,
            name: r.name,
            description: r.description,
            owner_user_id: r.owner_user_id,
            cover_url: r.cover_url,
            created_at_micros: r.created_at_micros,
            updated_at_micros: r.updated_at_micros,
            is_deleted: r.is_deleted,
        }
    }
}

/// A single item inside an album.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AlbumItem {
    pub item_id: String,
    pub album_id: String,
    pub url: String,
    pub name: String,
    pub size: Option<i64>,
    pub mime: Option<String>,
    pub caption: Option<String>,
    pub sort_order: i64,
    pub created_at_micros: i64,
    pub is_deleted: bool,
}

impl From<crate::projections::album_items::AlbumItemRecord> for AlbumItem {
    fn from(r: crate::projections::album_items::AlbumItemRecord) -> Self {
        Self {
            item_id: r.item_id,
            album_id: r.album_id,
            url: r.url,
            name: r.name,
            size: r.size,
            mime: r.mime,
            caption: r.caption,
            sort_order: r.sort_order,
            created_at_micros: r.created_at_micros,
            is_deleted: r.is_deleted,
        }
    }
}

/// A wiki page in a wiki channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WikiPage {
    pub page_id: String,
    pub channel_id: String,
    pub title: String,
    pub body: String,
    pub author_user_id: u64,
    pub created_at_micros: i64,
    pub updated_at_micros: i64,
    pub is_deleted: bool,
}

impl From<crate::projections::wiki::WikiPageRecord> for WikiPage {
    fn from(r: crate::projections::wiki::WikiPageRecord) -> Self {
        Self {
            page_id: r.page_id,
            channel_id: r.channel_id,
            title: r.title,
            body: r.body,
            author_user_id: r.author_user_id,
            created_at_micros: r.created_at_micros,
            updated_at_micros: r.updated_at_micros,
            is_deleted: r.is_deleted,
        }
    }
}

/// A forum post (or thread starter) in a forum channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ForumPost {
    pub post_id: String,
    pub thread_id: String,
    pub channel_id: String,
    pub author_user_id: u64,
    pub body: String,
    pub created_at_micros: i64,
    pub edited_at_micros: Option<i64>,
    pub is_deleted: bool,
    pub is_thread_starter: bool,
}

impl From<crate::projections::forum::ForumPostRecord> for ForumPost {
    fn from(r: crate::projections::forum::ForumPostRecord) -> Self {
        Self {
            post_id: r.post_id,
            thread_id: r.thread_id,
            channel_id: r.channel_id,
            author_user_id: r.author_user_id,
            body: r.body,
            created_at_micros: r.created_at_micros,
            edited_at_micros: r.edited_at_micros,
            is_deleted: r.is_deleted,
            is_thread_starter: r.is_thread_starter,
        }
    }
}

/// An incident report in an incident channel.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Incident {
    pub incident_id: String,
    pub channel_id: String,
    pub title: String,
    pub description: String,
    pub severity: String,
    pub status: String,
    pub reporter_user_id: u64,
    pub assigned_user_id: Option<u64>,
    pub created_at_micros: i64,
    pub updated_at_micros: i64,
    pub resolved_at_micros: Option<i64>,
    pub is_deleted: bool,
}

impl From<crate::projections::incidents::IncidentRecord> for Incident {
    fn from(r: crate::projections::incidents::IncidentRecord) -> Self {
        Self {
            incident_id: r.incident_id,
            channel_id: r.channel_id,
            title: r.title,
            description: r.description,
            severity: r.severity,
            status: r.status,
            reporter_user_id: r.reporter_user_id,
            assigned_user_id: r.assigned_user_id,
            created_at_micros: r.created_at_micros,
            updated_at_micros: r.updated_at_micros,
            resolved_at_micros: r.resolved_at_micros,
            is_deleted: r.is_deleted,
        }
    }
}

/// A DM message (direct message).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DmMessage {
    pub dm_id: String,
    pub message_id: String,
    pub author_user_id: u64,
    pub author_device_id: String,
    pub created_at_micros: i64,
}

impl From<crate::projections::dm_messages::DmMessageRecord> for DmMessage {
    fn from(r: crate::projections::dm_messages::DmMessageRecord) -> Self {
        Self {
            dm_id: r.dm_id,
            message_id: r.message_id,
            author_user_id: r.author_user_id,
            author_device_id: r.author_device_id,
            created_at_micros: r.created_at_micros,
        }
    }
}

/// A DM message recipient record (delivery/read status).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DmRecipient {
    pub dm_id: String,
    pub message_id: String,
    pub recipient_user_id: u64,
    pub delivered_at_micros: Option<i64>,
    pub read_at_micros: Option<i64>,
}

impl From<crate::projections::dm_message_recipients::DmRecipientRecord> for DmRecipient {
    fn from(r: crate::projections::dm_message_recipients::DmRecipientRecord) -> Self {
        Self {
            dm_id: r.dm_id,
            message_id: r.message_id,
            recipient_user_id: r.recipient_user_id,
            delivered_at_micros: r.delivered_at_micros,
            read_at_micros: r.read_at_micros,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_new_has_sensible_defaults() {
        let u = User::new(42, "alice", "argon2:...");
        assert_eq!(u.user_id, 42);
        assert_eq!(u.username, "alice");
        assert!(u.is_registered);
        assert!(u.is_active);
        assert!(u.created_at_micros > 0);
    }

    #[test]
    fn channel_new_defaults_to_text() {
        let c = Channel::new("ch_01H", "general", 42);
        assert_eq!(c.channel_id, "ch_01H");
        assert_eq!(c.channel_kind, ChannelKind::Text);
    }

    #[test]
    fn channel_kind_repr_is_u8() {
        // The repr(u8) is important: we store this in the on-disk
        // format. Verify the values are stable.
        assert_eq!(ChannelKind::Text as u8, 0);
        assert_eq!(ChannelKind::Voice as u8, 1);
        assert_eq!(ChannelKind::Dm as u8, 2);
        assert_eq!(ChannelKind::GroupDm as u8, 3);
        assert_eq!(ChannelKind::Announcement as u8, 4);
        assert_eq!(ChannelKind::Whiteboard as u8, 5);
        assert_eq!(ChannelKind::Wiki as u8, 6);
        assert_eq!(ChannelKind::Forum as u8, 7);
        assert_eq!(ChannelKind::Incident as u8, 8);
    }

    #[test]
    fn member_role_repr_is_u8() {
        assert_eq!(MemberRole::Member as u8, 0);
        assert_eq!(MemberRole::Moderator as u8, 1);
        assert_eq!(MemberRole::Admin as u8, 2);
        assert_eq!(MemberRole::Owner as u8, 3);
    }

    #[test]
    fn user_serialize_round_trip() {
        let u = User::new(42, "alice", "argon2:hash");
        let json = serde_json::to_string(&u).unwrap();
        let back: User = serde_json::from_str(&json).unwrap();
        assert_eq!(u, back);
    }

    #[test]
    fn emote_serde_round_trip() {
        let e = Emote {
            emote_id: "emo_01H".into(),
            name: "blobwave".into(),
            image_url: "https://cdn.example.com/emotes/blobwave.png".into(),
            created_at_micros: 1234567890,
            created_by_user_id: 42,
        };
        let json = serde_json::to_string(&e).unwrap();
        let back: Emote = serde_json::from_str(&json).unwrap();
        assert_eq!(e, back);
    }

    #[test]
    fn webhook_serde_round_trip() {
        let w = Webhook {
            webhook_id: "wh_01H".into(),
            channel_id: "ch_01H".into(),
            name: "my webhook".into(),
            url: "https://hooks.example.com/xyz".into(),
            created_at_micros: 1234567890,
            created_by_user_id: 42,
        };
        let json = serde_json::to_string(&w).unwrap();
        let back: Webhook = serde_json::from_str(&json).unwrap();
        assert_eq!(w, back);
    }

    #[test]
    fn user_layout_serde_round_trip() {
        let l = UserLayout {
            user_id: 42,
            layout_json: r#"{"panels":[]}"#.into(),
            updated_at_micros: 1234567890,
        };
        let json = serde_json::to_string(&l).unwrap();
        let back: UserLayout = serde_json::from_str(&json).unwrap();
        assert_eq!(l, back);
    }

    #[test]
    fn retention_policy_serde_round_trip() {
        let r = RetentionPolicy {
            channel_id: "ch_01H".into(),
            days: 30,
            set_at_micros: 1234567890,
            set_by_user_id: 1,
        };
        let json = serde_json::to_string(&r).unwrap();
        let back: RetentionPolicy = serde_json::from_str(&json).unwrap();
        assert_eq!(r, back);
    }

    #[test]
    fn emoji_role_rule_serde_round_trip() {
        let rule = EmojiRoleRule {
            message_id: "msg_01H".into(),
            emote: "👍".into(),
            role: MemberRole::Moderator,
            set_at_micros: 1234567890,
        };
        let json = serde_json::to_string(&rule).unwrap();
        let back: EmojiRoleRule = serde_json::from_str(&json).unwrap();
        assert_eq!(rule, back);
    }

    #[test]
    fn mute_record_serde_round_trip() {
        let m = MuteRecord {
            channel_id: "ch_01H".into(),
            user_id: 42,
            muted_by_user_id: 1,
            until_micros: 9999999999,
            set_at_micros: 1234567890,
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: MuteRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }

    #[test]
    fn deafen_record_serde_round_trip() {
        let d = DeafenRecord {
            channel_id: "ch_01H".into(),
            user_id: 42,
            deafened_by_user_id: 1,
            set_at_micros: 1234567890,
        };
        let json = serde_json::to_string(&d).unwrap();
        let back: DeafenRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(d, back);
    }

    #[test]
    fn message_with_username_round_trip() {
        let m = Message {
            message_id: "m1".into(),
            channel_id: "c1".into(),
            author_user_id: 42,
            author_username: Some("alice".into()),
            author_display_name: Some("Alice".into()),
            author_device_id: "d1".into(),
            content: "hi".into(),
            message_type: "text".into(),
            created_at_micros: 1,
            edited_at_micros: None,
            commit_seq: 1,
            is_deleted: false,
            is_spoiler: false,
        };
        let s = serde_json::to_string(&m).unwrap();
        let back: Message = serde_json::from_str(&s).unwrap();
        assert_eq!(m, back);
    }

    #[test]
    fn channel_with_description_round_trip() {
        let c = Channel {
            channel_id: "c1".into(),
            name: "general".into(),
            channel_kind: ChannelKind::Text,
            owner_user_id: 42,
            created_at_micros: 1,
            is_active: true,
            description: Some("general discussion".into()),
            position: 5,
            parent_id: None,
            asset_storage: false,
            force_spoiler: false,
        };
        let s = serde_json::to_string(&c).unwrap();
        let back: Channel = serde_json::from_str(&s).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn message_serialize_round_trip() {
        let m = Message {
            message_id: "msg_01H".to_string(),
            channel_id: "ch_01H".to_string(),
            author_user_id: 42,
            author_username: Some("alice".to_string()),
            author_display_name: None,
            author_device_id: "dev_01H".to_string(),
            content: "hello".to_string(),
            message_type: "text".to_string(),
            created_at_micros: 1234567890,
            edited_at_micros: None,
            commit_seq: 1,
            is_deleted: false,
            is_spoiler: false,
        };
        let json = serde_json::to_string(&m).unwrap();
        let back: Message = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }
}
