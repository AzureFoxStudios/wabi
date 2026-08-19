use std::collections::HashMap;

use crate::domain::{
    Album, AlbumItem, Ban, CallParticipant, CallSession, CallSignal, Channel, ChannelMember,
    DmMessage, DmRecipient, EmojiRoleRule, Emote, ForumPost, GalleryFeedback, GalleryWork,
    Incident, Message, Reaction, RetentionPolicy, RoleDefinition, User, UserLayout, Webhook,
    WikiPage, WikiRevision,
};
use crate::error::Result;
use crate::projections::lore::{LoreCommitRecord, LoreFileChangeRecord, LoreRepoRecord, LoreTokenRecord};
use crate::projections::payments::{
    PaymentAccountLinkRecord, PaymentIntentRecord, PaymentUserBlockRecord,
};

/// The storage API trait for WabiDB.
///
/// Domain-level methods for reading and writing data. Implementations
/// are [`Send`] + [`Sync`] so they can be shared across async tasks.
///
/// This trait is the integration point for the wabi-server. Each
/// method returns a typed domain object that the adapter translates
/// into the wabi-core types used by the frontend.
#[allow(clippy::too_many_arguments)]
#[allow(async_fn_in_trait)]
pub trait WabiStore: Send + Sync {
    // --- writes ---

    /// Persist a message in a channel and return its ID.
    async fn send_message(
        &self,
        channel_id: &str,
        user_id: u64,
        content: &str,
        is_spoiler: bool,
        files: &[crate::projections::messages::FileAttachmentRecord],
    ) -> Result<String>;

    /// Create a new user. Returns the new user_id.
    async fn create_user(
        &self,
        username: &str,
        handle: Option<&str>,
        password_hash: &str,
    ) -> Result<u64>;

    /// Create a new channel. Returns the new channel_id.
    async fn create_channel(
        &self,
        name: &str,
        channel_kind: crate::domain::ChannelKind,
        owner_user_id: u64,
        force_spoiler: bool,
    ) -> Result<String>;

    /// Update channel properties (name, description, position, force_spoiler, parent_id).
    async fn update_channel(
        &self,
        channel_id: &str,
        patch: &serde_json::Value,
        actor_user_id: u64,
    ) -> Result<()>;

    /// Add or update a reaction on a message.
    async fn add_reaction(
        &self,
        message_id: &str,
        user_id: u64,
        emote: &str,
    ) -> Result<()>;

    /// Add a user to a channel with a given role.
    async fn add_channel_member(
        &self,
        channel_id: &str,
        user_id: u64,
        role: crate::domain::MemberRole,
    ) -> Result<()>;

    /// Remove a user from a channel.
    async fn remove_channel_member(&self, channel_id: &str, user_id: u64) -> Result<()>;

    /// Ban a user from a channel.
    async fn ban_user(
        &self,
        channel_id: &str,
        actor_user_id: u64,
        target_user_id: u64,
        reason: &str,
    ) -> Result<()>;

    /// Unban a user.
    async fn unban_user(
        &self,
        channel_id: &str,
        actor_user_id: u64,
        target_user_id: u64,
    ) -> Result<()>;

    /// Update a user's last-seen timestamp.
    async fn touch_user(&self, user_id: u64) -> Result<()>;

    /// Patch mutable profile fields on a user (avatar, font, bio, status, color, username).
    async fn update_user(
        &self,
        user_id: u64,
        updates: crate::domain::UserUpdate,
    ) -> Result<()>;

    // --- typed reads ---

    /// List all stream IDs known to the engine.
    async fn list_streams(&self) -> Result<Vec<String>>;

    /// Retrieve a single message by its ID (typed).
    async fn get_message_typed(&self, message_id: &str) -> Result<Option<Message>>;

    /// List messages in a channel, newest first, up to `limit` entries (typed).
    async fn list_messages_typed(
        &self,
        channel_id: &str,
        limit: u64,
    ) -> Result<Vec<Message>>;

    /// Retrieve a single message by its ID (legacy string interface).
    async fn get_message(&self, message_id: &str) -> Result<Option<String>>;

    /// List message IDs in a channel, newest first, up to `limit` entries (legacy).
    async fn list_messages(&self, channel_id: &str, limit: u64) -> Result<Vec<String>>;

    /// Look up a user by ID.
    async fn get_user(&self, user_id: u64) -> Result<Option<User>>;

    /// Look up a user by username (case-insensitive).
    async fn get_user_by_username(&self, username: &str) -> Result<Option<User>>;

    /// List all active users.
    async fn list_users(&self) -> Result<Vec<User>>;

    /// Persist the server owner designation (idempotent: overwrites prior owner).
    async fn claim_owner(&self, user_id: u64) -> Result<()>;

    /// Read the current owner user id from the store, if one has been claimed.
    async fn get_owner_user_id(&self) -> Result<Option<u64>>;

    /// Look up a channel by ID.
    async fn get_channel(&self, channel_id: &str) -> Result<Option<Channel>>;

    /// List channels (optionally filtered by member).
    async fn list_channels(&self, member_user_id: Option<u64>) -> Result<Vec<Channel>>;

    /// List members of a channel.
    async fn list_channel_members(&self, channel_id: &str) -> Result<Vec<ChannelMember>>;

    /// List reactions on a message.
    async fn list_reactions(&self, message_id: &str) -> Result<Vec<Reaction>>;

    /// List active bans for a channel.
    async fn list_bans(&self, channel_id: &str) -> Result<Vec<Ban>>;

    /// List role definitions for a channel.
    async fn list_role_definitions(&self, channel_id: &str) -> Result<Vec<RoleDefinition>>;

    /// Lookup a user's current role name within a workspace (e.g. "Owner",
    /// "Admin", "Moderator", "Member"), if assigned. Backed by the
    /// `rbac_roles` projection maintained by `AuditProjection`.
    async fn get_user_role(&self, workspace_id: &str, user_id: u64) -> Result<Option<String>>;

    // --- new methods ---

    /// Soft-delete a channel.
    async fn delete_channel(&self, _channel_id: &str, _actor_user_id: u64) -> Result<()> {
        Ok(())
    }

    /// Soft-delete a message.
    async fn delete_message(&self, _message_id: &str, _actor_user_id: u64) -> Result<()> {
        Ok(())
    }

    /// Clear all messages in a channel (owner/admin bulk cleanup).
    /// Implementations that persist messages must remove them from the
    /// channel's message store. The default is a no-op for in-memory/compat
    /// stores where the live store lives in the server's session cache.
    async fn clear_channel_messages(&self, _channel_id: &str, _actor_user_id: u64) -> Result<()> {
        Ok(())
    }

    /// Edit a message's content.
    async fn edit_message(&self, _message_id: &str, _actor_user_id: u64, _new_content: &str) -> Result<()> {
        Ok(())
    }

    /// Remove a reaction from a message.
    async fn remove_reaction(&self, _message_id: &str, _user_id: u64, _emote: &str) -> Result<()> {
        Ok(())
    }

    /// Mute a user in a channel until the given microsecond timestamp.
    async fn mute_user(&self, _channel_id: &str, _actor_user_id: u64, _target_user_id: u64, _until_micros: i64) -> Result<()> {
        Ok(())
    }

    /// Unmute a user in a channel.
    async fn unmute_user(&self, _channel_id: &str, _actor_user_id: u64, _target_user_id: u64) -> Result<()> {
        Ok(())
    }

    /// Check whether a user is currently muted in a channel.
    async fn is_user_muted(&self, _channel_id: &str, _user_id: u64) -> Result<bool> {
        Ok(false)
    }

    /// Deafen a user in a voice channel.
    async fn deafen_user(&self, _channel_id: &str, _actor_user_id: u64, _target_user_id: u64) -> Result<()> {
        Ok(())
    }

    /// Undeafen a user in a voice channel.
    async fn undeafen_user(&self, _channel_id: &str, _actor_user_id: u64, _target_user_id: u64) -> Result<()> {
        Ok(())
    }

    /// Check whether a user is currently deafened in a channel.
    async fn is_user_deafened(&self, _channel_id: &str, _user_id: u64) -> Result<bool> {
        Ok(false)
    }

    /// List all emotes.
    async fn get_emotes(&self) -> Result<Vec<Emote>> {
        Ok(Vec::new())
    }

    /// Upsert an emote by name with full metadata.
    #[allow(clippy::too_many_arguments)]
    async fn upsert_emote(
        &self,
        _name: &str,
        _image_url: &str,
        _display_name: &str,
        _artist: &str,
        _category: &str,
        _kind: &str,
        _created_by_user_id: u64,
    ) -> Result<()> {
        Ok(())
    }

    /// Delete an emote by id (name-based lookup key `emo_{name}`).
    async fn delete_emote(&self, _name: &str) -> Result<()> {
        Ok(())
    }

    /// Get emoji role rules for a message.
    async fn get_emoji_role_rules(&self, _message_id: &str) -> Result<Vec<EmojiRoleRule>> {
        Ok(Vec::new())
    }

    /// List webhooks for a channel.
    async fn get_webhooks(&self, _channel_id: &str) -> Result<Vec<Webhook>> {
        Ok(Vec::new())
    }

    /// Upsert a webhook for a channel.
    async fn upsert_webhook(&self, _channel_id: &str, _name: &str, _url: &str) -> Result<()> {
        Ok(())
    }

    /// Get a user's saved layout.
    async fn get_user_layout(&self, _user_id: u64) -> Result<Option<UserLayout>> {
        Ok(None)
    }

    /// Upsert a user's layout.
    async fn upsert_user_layout(&self, _user_id: u64, _layout_json: &str) -> Result<()> {
        Ok(())
    }

    /// Get a whiteboard board document's raw JSON by board id.
    async fn get_whiteboard_doc(&self, _board_id: &str) -> Result<Option<String>> {
        Ok(None)
    }

    /// Persist a whiteboard board document's raw JSON by board id.
    async fn put_whiteboard_doc(&self, _board_id: &str, _json: &str) -> Result<()> {
        Ok(())
    }

    /// Get retention policy for a channel.
    async fn get_channel_retention(&self, _channel_id: &str) -> Result<Option<RetentionPolicy>> {
        Ok(None)
    }

    /// Upsert a retention policy for a channel.
    async fn upsert_channel_retention(&self, _channel_id: &str, _days: u32, _set_by_user_id: u64) -> Result<()> {
        Ok(())
    }

    /// Check if a user is currently banned (server-wide, v1).
    ///
    /// WDB-compat: the original WDB was server-wide (no per-channel
    /// scope). Per-channel ban listing goes through `list_bans(channel_id)`.
    /// For v1 this returns `Ok(false)` (no-op); real implementation lands
    /// when the bans projection is wired into the engine.
    async fn is_user_banned(&self, _user_id: u64) -> Result<bool> {
        Ok(false)
    }

    /// Set a member's role on a channel (wabidb's RBAC model: per-channel
    /// member role, not workspace role definition).
    ///
    /// WDB-compat: replaces `upsert_role_definition(workspace_id,
    /// role_name, display_name, priority, color, is_hoisted)` from the
    /// old WDB API. The wabidb RBAC model is per-channel with a
    /// `MemberRole` enum discriminator (Member/Moderator/Admin/Owner).
    /// For v1 this is a no-op; real implementation lands when the
    /// role_assignments projection is wired into the engine.
    async fn upsert_member_role(
        &self,
        _channel_id: &str,
        _user_id: u64,
        _role: crate::domain::MemberRole,
    ) -> Result<()> {
        Ok(())
    }

    // --- WDB-compat no-ops for socketio migration ---

    /// WDB-compat: raw channel rows. No direct WDB equivalent; callers
    /// that need channel data should use `list_channels` and convert.
    /// For v1 this returns an empty list.
    async fn get_channels_raw(
        &self,
    ) -> Result<Vec<std::collections::HashMap<String, serde_json::Value>>> {
        Ok(Vec::new())
    }

    /// WDB-compat: create a DM channel. For v1 this is a no-op stub
    /// returning a deterministic placeholder. Real impl lands when the
    /// DM projection is wired in (use `create_channel` with
    /// `ChannelKind::Dm`).
    async fn create_dm_channel(
        &self,
        _channel_id: &str,
        _name: &str,
        _members: Option<&[String]>,
        _my_user_id: i64,
    ) -> Result<String> {
        Ok(format!("dm_{}", _channel_id))
    }

    /// WDB-compat: delete a DM channel. For v1 this is a no-op.
    /// Real impl lands when the DM projection is wired in.
    async fn delete_dm_channel(&self, _channel_id: &str) -> Result<()> {
        Ok(())
    }

    /// WDB-compat: upsert a group. No direct WDB equivalent (groups
    /// map to channels with `ChannelKind::GroupDm` plus a
    /// `add_channel_member` per member). For v1 this is a no-op
    /// returning a deterministic placeholder.
    async fn upsert_group(
        &self,
        _channel_id: &str,
        _name: &str,
        _kind: &str,
        _members: Option<&[String]>,
        _avatar: Option<&str>,
        _description: Option<&str>,
    ) -> Result<String> {
        Ok(format!("group_{}", _channel_id))
    }

    // --- subscription bridge ---

    /// Subscribe a consumer (Socket.IO socket ID) to a topic (stream ID).
    /// Returns a receiver for push delivery notifications.
    async fn subscribe_stream(
        &self,
        _consumer_id: &str,
        _topic: &str,
        _since: u64,
    ) -> Result<tokio::sync::broadcast::Receiver<crate::engine::SubscriptionDelivery>> {
        let (_tx, rx) = tokio::sync::broadcast::channel(1);
        Ok(rx)
    }

    /// Unsubscribe a consumer from a topic.
    async fn unsubscribe_stream(&self, _consumer_id: &str, _topic: &str) -> Result<bool> {
        Ok(false)
    }

    // --- ingest_event ---

    /// WDB-compat: generic event ingest. The wabidb design is typed
    /// commands per event type, not a generic event bus. For v1 this
    /// is a no-op. Per-`(entity, op)` routing to typed WDB methods
    /// (e.g. `create_user`, `add_channel_member`) is a follow-up.
    async fn ingest_event(
        &self,
        _entity: &str,
        _op: &str,
        _payload: &serde_json::Value,
    ) -> Result<()> {
        Ok(())
    }

    // --- call-session state (replaces WDB call_session_* tables) ---

    /// Create a new voice/video call session.
    async fn create_call_session(
        &self,
        _session_id: String,
        _channel_id: String,
        _call_type: String,
        _host_user_id: u64,
        _max_participants: u32,
        _transport: String,
    ) -> Result<u64> {
        Ok(0)
    }

    /// Mark a user as joined to a call session.
    async fn join_call_session(
        &self,
        _session_id: String,
        _user_id: u64,
        _stable_user_id: String,
        _is_host: bool,
    ) -> Result<u64> {
        Ok(0)
    }

    /// Mark a user as having left a call session.
    async fn leave_call_session(
        &self,
        _session_id: String,
        _user_id: u64,
    ) -> Result<u64> {
        Ok(0)
    }

    /// Mark a call session as ended.
    async fn end_call_session(
        &self,
        _session_id: String,
        _actor_user_id: u64,
    ) -> Result<u64> {
        Ok(0)
    }

    /// Emit a signaling message within a call session.
    /// `signal_id` is monotonic per session, assigned by the caller.
    async fn emit_call_signal(
        &self,
        _session_id: String,
        _from_user_id: u64,
        _signal_type: String,
        _target_user_id: Option<u64>,
        _payload: String,
        _signal_id: u64,
    ) -> Result<u64> {
        Ok(0)
    }

    /// Look up a call session by id.
    async fn get_call_session(&self, _session_id: &str) -> Result<Option<CallSession>> {
        Ok(None)
    }

    /// List all participants in a call session.
    async fn get_call_participants(
        &self,
        _session_id: &str,
    ) -> Result<Vec<CallParticipant>> {
        Ok(Vec::new())
    }

    /// List signals for a call session, optionally filtered by min signal_id.
    async fn get_call_signals(
        &self,
        _session_id: &str,
        _since_signal_id: u64,
    ) -> Result<Vec<CallSignal>> {
        Ok(Vec::new())
    }

    // --- album / album_items ---

    /// List albums within a scope.
    async fn list_albums(&self, _scope_type: &str, _scope_id: &str) -> Result<Vec<Album>> {
        Ok(Vec::new())
    }

    /// Get a single album.
    async fn get_album(&self, _scope_type: &str, _scope_id: &str, _album_id: &str) -> Result<Option<Album>> {
        Ok(None)
    }

    /// Create an album. Returns the new album_id.
    async fn create_album(&self, _scope_type: &str, _scope_id: &str, _name: &str, _user_id: u64) -> Result<String> {
        Ok(String::new())
    }

    /// Soft-delete an album.
    async fn delete_album(&self, _scope_type: &str, _scope_id: &str, _album_id: &str, _user_id: u64) -> Result<()> {
        Ok(())
    }

    /// List items in an album.
    async fn list_items(&self, _album_id: &str) -> Result<Vec<AlbumItem>> {
        Ok(Vec::new())
    }

    /// Add an item to an album. Returns the new item_id.
    async fn add_item(&self, _album_id: &str, _url: &str, _name: &str, _caption: Option<&str>, _user_id: u64) -> Result<String> {
        Ok(String::new())
    }

    /// Soft-delete an item from an album.
    async fn delete_item(&self, _album_id: &str, _item_id: &str, _user_id: u64) -> Result<()> {
        Ok(())
    }

    // --- wiki ---

    /// Get a single wiki page.
    async fn get_wiki_page(&self, _channel_id: &str, _page_id: &str) -> Result<Option<WikiPage>> {
        Ok(None)
    }

    /// List wiki pages in a channel (excludes deleted).
    async fn list_wiki_pages(&self, _channel_id: &str) -> Result<Vec<WikiPage>> {
        Ok(Vec::new())
    }

    /// Create a wiki page. Returns the new page_id.
    async fn create_wiki_page(
        &self,
        _channel_id: &str,
        _title: &str,
        _body: &str,
        _author_user_id: u64,
        _parent_page_id: &str,
        _slug: &str,
        _order_index: i64,
    ) -> Result<String> {
        Ok(String::new())
    }

    /// Update a wiki page.
    async fn update_wiki_page(
        &self,
        _channel_id: &str,
        _page_id: &str,
        _title: &str,
        _body: &str,
        _author_user_id: u64,
        _parent_page_id: &str,
        _slug: &str,
        _order_index: i64,
    ) -> Result<()> {
        Ok(())
    }

    /// Soft-delete a wiki page.
    async fn delete_wiki_page(&self, _channel_id: &str, _page_id: &str, _actor_user_id: u64) -> Result<()> {
        Ok(())
    }

    /// List revisions for a wiki page.
    async fn list_wiki_revisions(&self, _channel_id: &str, _page_id: &str) -> Result<Vec<WikiRevision>> {
        Ok(Vec::new())
    }

    /// Get a single wiki revision.
    async fn get_wiki_revision(&self, _channel_id: &str, _page_id: &str, _revision_id: &str) -> Result<Option<WikiRevision>> {
        Ok(None)
    }

    // --- forum ---

    /// Get a single forum post.
    async fn get_forum_post(&self, _channel_id: &str, _thread_id: &str, _post_id: &str) -> Result<Option<ForumPost>> {
        Ok(None)
    }

    /// List thread starters in a channel (excludes deleted).
    async fn list_forum_threads(&self, _channel_id: &str) -> Result<Vec<ForumPost>> {
        Ok(Vec::new())
    }

    /// List posts in a thread (excludes deleted).
    async fn list_forum_posts(&self, _channel_id: &str, _thread_id: &str) -> Result<Vec<ForumPost>> {
        Ok(Vec::new())
    }

    /// Create a forum thread. Returns the new thread (post) id.
    async fn create_forum_thread(
        &self,
        _channel_id: &str,
        _body: &str,
        _author_user_id: u64,
        _title: Option<&str>,
        _tags: Option<&[String]>,
        _category: Option<&str>,
    ) -> Result<String> {
        Ok(String::new())
    }

    /// Create a reply in a forum thread. Returns the new post id.
    async fn create_forum_post(
        &self,
        _channel_id: &str,
        _thread_id: &str,
        _body: &str,
        _author_user_id: u64,
        _tags: Option<&[String]>,
    ) -> Result<String> {
        Ok(String::new())
    }

    /// Edit a forum post body.
    async fn update_forum_post(
        &self,
        _channel_id: &str,
        _thread_id: &str,
        _post_id: &str,
        _body: &str,
        _author_user_id: u64,
        _title: Option<&str>,
        _tags: Option<&[String]>,
        _category: Option<&str>,
    ) -> Result<()> {
        Ok(())
    }

    /// Soft-delete a forum post.
    async fn delete_forum_post(&self, _channel_id: &str, _thread_id: &str, _post_id: &str, _actor_user_id: u64) -> Result<()> {
        Ok(())
    }

    /// Vote on a forum post (direction: "up" or "down").
    async fn vote_forum_post(
        &self,
        _channel_id: &str,
        _thread_id: &str,
        _post_id: &str,
        _direction: &str,
        _actor_user_id: u64,
    ) -> Result<()> {
        Ok(())
    }

    /// Mark a forum post as the accepted solution for its thread.
    /// Clears any prior solution on other posts in the same thread.
    async fn mark_forum_solution(
        &self,
        _channel_id: &str,
        _thread_id: &str,
        _post_id: &str,
        _actor_user_id: u64,
    ) -> Result<()> {
        Ok(())
    }

    /// Update thread-level metadata (title, tags, category).
    async fn update_forum_thread_meta(
        &self,
        _channel_id: &str,
        _thread_id: &str,
        _title: &str,
        _tags: &[String],
        _category: Option<&str>,
        _actor_user_id: u64,
    ) -> Result<()> {
        Ok(())
    }

    // --- incidents ---

    /// Get a single incident.
    async fn get_incident(&self, _channel_id: &str, _incident_id: &str) -> Result<Option<Incident>> {
        Ok(None)
    }

    /// List incidents in a channel (excludes deleted).
    async fn list_incidents(&self, _channel_id: &str) -> Result<Vec<Incident>> {
        Ok(Vec::new())
    }

    /// Create an incident. Returns the new incident_id.
    async fn create_incident(&self, _channel_id: &str, _title: &str, _description: &str, _severity: &str, _reporter_user_id: u64) -> Result<String> {
        Ok(String::new())
    }

    /// Update incident fields (title, description, severity, status, assignment).
    async fn update_incident(&self, _channel_id: &str, _incident_id: &str, _title: &str, _description: &str, _severity: &str, _status: &str, _assigned_user_id: Option<u64>, _actor_user_id: u64) -> Result<()> {
        Ok(())
    }

    /// Resolve an incident (sets status to "resolved" and resolved_at).
    async fn resolve_incident(&self, _channel_id: &str, _incident_id: &str, _actor_user_id: u64) -> Result<()> {
        Ok(())
    }

    // --- payments ---

    /// Read a stored payment policy row (e.g. `policy:payments_access`).
    async fn get_payment_policy(&self, _key: &str) -> Result<Option<serde_json::Value>> {
        Ok(None)
    }

    /// Store a payment policy row.
    async fn upsert_payment_policy(&self, _key: &str, _value: &serde_json::Value) -> Result<()> {
        Ok(())
    }

    /// All saved account links for a user, newest-first.
    async fn list_payment_account_links(
        &self,
        _user_id: i64,
    ) -> Result<Vec<PaymentAccountLinkRecord>> {
        Ok(Vec::new())
    }

    /// Upsert a user's account link (one row per plugin_id).
    async fn upsert_payment_account_link(&self, _link: &PaymentAccountLinkRecord) -> Result<()> {
        Ok(())
    }

    /// Remove a user's account link for a plugin.
    async fn delete_payment_account_link(&self, _user_id: i64, _plugin_id: &str) -> Result<()> {
        Ok(())
    }

    /// Persist a new payment intent (record carries its own id).
    async fn create_payment_intent(&self, _intent: &PaymentIntentRecord) -> Result<()> {
        Ok(())
    }

    /// List payment intents. `include_all` grants the admin view.
    async fn list_payment_intents(
        &self,
        _user_id: i64,
        _include_all: bool,
    ) -> Result<Vec<PaymentIntentRecord>> {
        Ok(Vec::new())
    }

    /// Look up a single intent by id (any owner).
    async fn get_payment_intent(&self, _intent_id: &str) -> Result<Option<PaymentIntentRecord>> {
        Ok(None)
    }

    /// Admin: mark a pending intent completed. Returns the updated record, or
    /// `None` when the intent is missing / not pending.
    async fn confirm_payment_intent(
        &self,
        _intent_id: &str,
        _admin_user_id: i64,
        _actual_amount_minor: Option<i64>,
        _reference_note: Option<String>,
    ) -> Result<Option<PaymentIntentRecord>> {
        Ok(None)
    }

    /// Admin: reject a pending intent. Returns the updated record, or `None`
    /// when the intent is missing / not pending.
    async fn reject_payment_intent(
        &self,
        _intent_id: &str,
        _admin_user_id: i64,
        _reference_note: Option<String>,
    ) -> Result<Option<PaymentIntentRecord>> {
        Ok(None)
    }

    /// List admin-issued payment blocks in a workspace.
    async fn list_payment_user_blocks(
        &self,
        _workspace_id: &str,
    ) -> Result<Vec<PaymentUserBlockRecord>> {
        Ok(Vec::new())
    }

    /// Upsert an admin-issued payment block.
    async fn upsert_payment_user_block(&self, _block: &PaymentUserBlockRecord) -> Result<()> {
        Ok(())
    }

    /// Remove an admin-issued payment block.
    async fn delete_payment_user_block(&self, _workspace_id: &str, _user_id: i64) -> Result<()> {
        Ok(())
    }

    // --- direct messages ---

    /// Get a single DM message.
    async fn get_dm_message(&self, _dm_id: &str, _message_id: &str) -> Result<Option<DmMessage>> {
        Ok(None)
    }

    /// List messages in a DM channel, newest first.
    async fn list_dm_messages(&self, _dm_id: &str) -> Result<Vec<DmMessage>> {
        Ok(Vec::new())
    }

    /// List recipients for a DM message (delivery/read status).
    async fn list_dm_recipients(&self, _dm_id: &str, _message_id: &str) -> Result<Vec<DmRecipient>> {
        Ok(Vec::new())
    }

    /// Send a DM message. Returns the new message id.
    async fn send_dm_message(&self, _dm_id: &str, _author_user_id: u64, _content: &str) -> Result<String> {
        Ok(String::new())
    }

    // --- lore ---

    /// Register a Lore repo for a channel.
    async fn lore_create_repo(&self, _channel_id: i64, _repo_name: &str, _lore_server_url: &str, _created_by: i64) -> Result<()> {
        Ok(())
    }

    /// Remove a Lore repo registration from the event log.
    async fn lore_delete_repo(&self, _channel_id: i64, _deleted_by: i64) -> Result<()> {
        Ok(())
    }

    /// Look up a Lore repo by channel_id.
    async fn lore_get_repo(&self, _channel_id: i64) -> Result<Option<LoreRepoRecord>> {
        Ok(None)
    }

    /// Enumerate all registered Lore repos. Used to rehydrate the Lore addon's
    /// in-memory repo index after a process restart (the index is not durable
    /// on its own).
    async fn list_lore_repos(&self) -> Result<Vec<LoreRepoRecord>> {
        Ok(Vec::new())
    }

    /// Record a Lore commit in the event log.
    async fn lore_commit(&self, _channel_id: i64, _commit_hash: &str, _repo_name: &str, _file_path: &str, _message: &str, _author_user_id: i64) -> Result<()> {
        Ok(())
    }

    /// List a channel's Lore commit records (newest last).
    async fn list_lore_commits(&self, _channel_id: i64) -> Result<Vec<LoreCommitRecord>> {
        Ok(Vec::new())
    }

    /// Append a per-file change to the channel's sync change feed. Returns
    /// the change's cursor (commit_seq).
    async fn lore_file_change(
        &self,
        _channel_id: i64,
        _path: &str,
        _action: &str,
        _etag: Option<&str>,
        _revision: &str,
        _author_user_id: i64,
    ) -> Result<u64> {
        Ok(0)
    }

    /// Changes for a channel with seq > since, oldest first.
    async fn list_lore_file_changes(
        &self,
        _channel_id: i64,
        _since: u64,
    ) -> Result<Vec<LoreFileChangeRecord>> {
        Ok(Vec::new())
    }

    /// Mint (persist) an external-tool connect token record.
    async fn lore_mint_token(
        &self,
        _token_hash: &str,
        _channel_id: i64,
        _user_id: i64,
        _scopes: &str,
    ) -> Result<()> {
        Ok(())
    }

    /// Revoke a connect token by hash.
    async fn lore_revoke_token(&self, _token_hash: &str, _revoked_by: i64) -> Result<()> {
        Ok(())
    }

    /// Look up a connect token by hash (auth path).
    async fn lore_get_token(&self, _token_hash: &str) -> Result<Option<LoreTokenRecord>> {
        Ok(None)
    }

    /// List a channel's active connect tokens (management UI).
    async fn list_lore_tokens(&self, _channel_id: i64) -> Result<Vec<LoreTokenRecord>> {
        Ok(Vec::new())
    }

    // --- gallery ---

    /// List gallery works in a channel (excludes deleted).
    async fn list_gallery_works(&self, _channel_id: &str) -> Result<Vec<GalleryWork>> {
        Ok(Vec::new())
    }

    /// Get a single gallery work.
    async fn get_gallery_work(&self, _channel_id: &str, _work_id: &str) -> Result<Option<GalleryWork>> {
        Ok(None)
    }

    /// Upload a gallery work. Returns the new work_id.
    async fn upload_gallery_work(&self, _channel_id: &str, _title: &str, _caption: &str, _attachment_url: &str, _mime_type: &str, _category: &str, _is_wip: bool, _author_user_id: u64) -> Result<String> {
        Ok(String::new())
    }

    /// Edit a gallery work's mutable fields.
    async fn edit_gallery_work(&self, _channel_id: &str, _work_id: &str, _title: &str, _caption: &str, _category: &str, _is_wip: bool, _actor_user_id: u64) -> Result<()> {
        Ok(())
    }

    /// Soft-delete a gallery work.
    async fn delete_gallery_work(&self, _channel_id: &str, _work_id: &str, _actor_user_id: u64) -> Result<()> {
        Ok(())
    }

    /// List feedback for a gallery work (excludes deleted).
    async fn list_gallery_feedback(&self, _channel_id: &str, _work_id: &str) -> Result<Vec<GalleryFeedback>> {
        Ok(Vec::new())
    }

    /// Add feedback to a gallery work. Returns the new feedback_id.
    async fn add_gallery_feedback(&self, _channel_id: &str, _work_id: &str, _comment: &str, _x_percent: f32, _y_percent: f32, _author_user_id: u64) -> Result<String> {
        Ok(String::new())
    }

    /// Soft-delete a feedback comment.
    async fn delete_gallery_feedback(&self, _channel_id: &str, _work_id: &str, _feedback_id: &str, _actor_user_id: u64) -> Result<()> {
        Ok(())
    }
}
/// An in-memory implementation of [`WabiStore`] backed by `HashMap`s.
///
/// Useful for testing and local development. All data is lost on drop.
#[derive(Debug, Default)]
pub struct LocalWabiStore {
    users: HashMap<u64, User>,
    users_by_name: HashMap<String, u64>,
    channels: HashMap<String, Channel>,
    channel_members: HashMap<String, Vec<ChannelMember>>,
    messages: HashMap<String, Message>,
    messages_by_channel: HashMap<String, Vec<String>>,
    reactions: HashMap<String, Vec<Reaction>>,
    bans: HashMap<String, Vec<Ban>>,
    role_definitions: HashMap<String, Vec<RoleDefinition>>,
    streams: Vec<String>,
    next_message_id: u64,
    emotes: HashMap<String, Emote>,
    webhooks: HashMap<String, Vec<Webhook>>,
    user_layouts: HashMap<u64, UserLayout>,
    retention_policies: HashMap<String, RetentionPolicy>,
}

impl LocalWabiStore {
    /// Create an empty store.
    pub fn new() -> Self {
        Self::default()
    }
}

impl WabiStore for LocalWabiStore {
    async fn send_message(
        &self,
        _channel_id: &str,
        _user_id: u64,
        _content: &str,
        _is_spoiler: bool,
        _files: &[crate::projections::messages::FileAttachmentRecord],
    ) -> Result<String> {
        // LocalWabiStore is read-only by design (no interior mutability);
        // real writes go through the engine via WdbAdapter.
        Ok("msg_local_stub".to_string())
    }

    async fn create_user(
        &self,
        _username: &str,
        _handle: Option<&str>,
        _password_hash: &str,
    ) -> Result<u64> {
        Ok(0)
    }

    async fn create_channel(
        &self,
        _name: &str,
        _channel_kind: crate::domain::ChannelKind,
        _owner_user_id: u64,
        _force_spoiler: bool,
    ) -> Result<String> {
        Ok("ch_local_stub".to_string())
    }

    async fn add_reaction(
        &self,
        _message_id: &str,
        _user_id: u64,
        _emote: &str,
    ) -> Result<()> {
        Ok(())
    }

    async fn add_channel_member(
        &self,
        _channel_id: &str,
        _user_id: u64,
        _role: crate::domain::MemberRole,
    ) -> Result<()> {
        Ok(())
    }

    async fn remove_channel_member(&self, _channel_id: &str, _user_id: u64) -> Result<()> {
        Ok(())
    }

    async fn ban_user(
        &self,
        _channel_id: &str,
        _actor_user_id: u64,
        _target_user_id: u64,
        _reason: &str,
    ) -> Result<()> {
        Ok(())
    }

    async fn unban_user(
        &self,
        _channel_id: &str,
        _actor_user_id: u64,
        _target_user_id: u64,
    ) -> Result<()> {
        Ok(())
    }

    async fn touch_user(&self, _user_id: u64) -> Result<()> {
        Ok(())
    }

    async fn update_user(
        &self,
        _user_id: u64,
        _updates: crate::domain::UserUpdate,
    ) -> Result<()> {
        Ok(())
    }

    async fn list_streams(&self) -> Result<Vec<String>> {
        Ok(self.streams.clone())
    }

    async fn get_message_typed(&self, message_id: &str) -> Result<Option<Message>> {
        Ok(self.messages.get(message_id).cloned())
    }

    async fn list_messages_typed(
        &self,
        channel_id: &str,
        limit: u64,
    ) -> Result<Vec<Message>> {
        let ids = self
            .messages_by_channel
            .get(channel_id)
            .cloned()
            .unwrap_or_default();
        let mut msgs: Vec<Message> = ids
            .into_iter()
            .filter_map(|id| self.messages.get(&id).cloned())
            .collect();
        msgs.sort_by(|a, b| b.created_at_micros.cmp(&a.created_at_micros));
        msgs.truncate(limit as usize);
        Ok(msgs)
    }

    async fn get_message(&self, message_id: &str) -> Result<Option<String>> {
        Ok(self
            .messages
            .get(message_id)
            .map(|m| serde_json::to_string(m).unwrap_or_default()))
    }

    async fn list_messages(&self, channel_id: &str, limit: u64) -> Result<Vec<String>> {
        Ok(self
            .list_messages_typed(channel_id, limit)
            .await?
            .into_iter()
            .map(|m| m.message_id)
            .collect())
    }

    async fn get_user(&self, user_id: u64) -> Result<Option<User>> {
        Ok(self.users.get(&user_id).cloned())
    }

    async fn get_user_by_username(&self, username: &str) -> Result<Option<User>> {
        let key = username.to_lowercase();
        if let Some(&id) = self.users_by_name.get(&key) {
            return self.get_user(id).await;
        }
        Ok(None)
    }

    async fn list_users(&self) -> Result<Vec<User>> {
        Ok(self.users.values().cloned().collect())
    }

    async fn claim_owner(&self, _user_id: u64) -> Result<()> {
        Ok(())
    }

    async fn get_owner_user_id(&self) -> Result<Option<u64>> {
        Ok(None)
    }

    async fn get_channel(&self, channel_id: &str) -> Result<Option<Channel>> {
        Ok(self.channels.get(channel_id).cloned())
    }

    async fn list_channels(&self, member_user_id: Option<u64>) -> Result<Vec<Channel>> {
        let all: Vec<Channel> = self.channels.values().cloned().collect();
        match member_user_id {
            None => Ok(all),
            Some(uid) => {
                let member_of: std::collections::HashSet<String> = self
                    .channel_members
                    .iter()
                    .filter(|(_, members)| members.iter().any(|m| m.user_id == uid))
                    .map(|(ch_id, _)| ch_id.clone())
                    .collect();
                Ok(all
                    .into_iter()
                    .filter(|c| member_of.contains(&c.channel_id))
                    .collect())
            }
        }
    }

    async fn list_channel_members(&self, channel_id: &str) -> Result<Vec<ChannelMember>> {
        Ok(self
            .channel_members
            .get(channel_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn list_reactions(&self, message_id: &str) -> Result<Vec<Reaction>> {
        Ok(self
            .reactions
            .get(message_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn list_bans(&self, channel_id: &str) -> Result<Vec<Ban>> {
        Ok(self.bans.get(channel_id).cloned().unwrap_or_default())
    }

    async fn list_role_definitions(&self, channel_id: &str) -> Result<Vec<RoleDefinition>> {
        Ok(self
            .role_definitions
            .get(channel_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn get_user_role(&self, _workspace_id: &str, _user_id: u64) -> Result<Option<String>> {
        Ok(None)
    }

    async fn delete_channel(&self, channel_id: &str, _actor_user_id: u64) -> Result<()> {
        let _ = channel_id;
        Ok(())
    }

    async fn update_channel(
        &self,
        channel_id: &str,
        patch: &serde_json::Value,
        actor_user_id: u64,
    ) -> Result<()> {
        let _ = (channel_id, patch, actor_user_id);
        Ok(())
    }

    async fn delete_message(&self, message_id: &str, _actor_user_id: u64) -> Result<()> {
        let _ = message_id;
        Ok(())
    }

    async fn edit_message(&self, message_id: &str, _actor_user_id: u64, _new_content: &str) -> Result<()> {
        let _ = message_id;
        Ok(())
    }

    async fn remove_reaction(&self, message_id: &str, _user_id: u64, _emote: &str) -> Result<()> {
        let _ = message_id;
        Ok(())
    }

    async fn mute_user(
        &self,
        _channel_id: &str,
        _actor_user_id: u64,
        _target_user_id: u64,
        _until_micros: i64,
    ) -> Result<()> {
        Ok(())
    }

    async fn unmute_user(
        &self,
        _channel_id: &str,
        _actor_user_id: u64,
        _target_user_id: u64,
    ) -> Result<()> {
        Ok(())
    }

    async fn is_user_muted(&self, _channel_id: &str, _user_id: u64) -> Result<bool> {
        Ok(false)
    }

    async fn deafen_user(
        &self,
        _channel_id: &str,
        _actor_user_id: u64,
        _target_user_id: u64,
    ) -> Result<()> {
        Ok(())
    }

    async fn undeafen_user(
        &self,
        _channel_id: &str,
        _actor_user_id: u64,
        _target_user_id: u64,
    ) -> Result<()> {
        Ok(())
    }

    async fn is_user_deafened(&self, _channel_id: &str, _user_id: u64) -> Result<bool> {
        Ok(false)
    }

    async fn get_emotes(&self) -> Result<Vec<Emote>> {
        Ok(self.emotes.values().cloned().collect())
    }

    #[allow(clippy::too_many_arguments)]
    async fn upsert_emote(
        &self,
        _name: &str,
        _image_url: &str,
        _display_name: &str,
        _artist: &str,
        _category: &str,
        _kind: &str,
        _created_by_user_id: u64,
    ) -> Result<()> {
        Ok(())
    }

    async fn delete_emote(&self, _name: &str) -> Result<()> {
        Ok(())
    }

    async fn get_emoji_role_rules(&self, _message_id: &str) -> Result<Vec<EmojiRoleRule>> {
        Ok(Vec::new())
    }

    async fn get_webhooks(&self, channel_id: &str) -> Result<Vec<Webhook>> {
        Ok(self
            .webhooks
            .get(channel_id)
            .cloned()
            .unwrap_or_default())
    }

    async fn upsert_webhook(&self, _channel_id: &str, _name: &str, _url: &str) -> Result<()> {
        Ok(())
    }

    async fn get_user_layout(&self, user_id: u64) -> Result<Option<UserLayout>> {
        Ok(self.user_layouts.get(&user_id).cloned())
    }

    async fn upsert_user_layout(&self, _user_id: u64, _layout_json: &str) -> Result<()> {
        Ok(())
    }

    async fn get_channel_retention(&self, channel_id: &str) -> Result<Option<RetentionPolicy>> {
        Ok(self.retention_policies.get(channel_id).cloned())
    }

    async fn upsert_channel_retention(
        &self,
        _channel_id: &str,
        _days: u32,
        _set_by_user_id: u64,
    ) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Channel, ChannelKind, ChannelMember, MemberRole, Message, User};

    #[tokio::test]
    async fn trait_methods_compile() {
        let store = LocalWabiStore::new();
        let _ = store.list_streams().await.unwrap();
        let _ = store.get_user(1).await.unwrap();
        let _ = store.list_users().await.unwrap();
        let _ = store.list_channels(None).await.unwrap();
    }

    #[tokio::test]
    async fn legacy_string_methods_still_work() {
        let store = LocalWabiStore::new();
        let id = store.send_message("ch_1", 42, "hello", false, &[]).await.unwrap();
        assert!(!id.is_empty());
        let _ = store.get_message("any_id").await.unwrap();
        let _ = store.list_messages("ch_1", 10).await.unwrap();
    }

    #[test]
    fn user_construction() {
        let u = User::new(42, "alice", "argon2:hash");
        assert_eq!(u.user_id, 42);
        assert!(u.is_active);
    }

    #[test]
    fn channel_construction() {
        let c = Channel::new("ch_01H", "general", 42);
        assert_eq!(c.channel_kind, ChannelKind::Text);
    }

    #[test]
    fn member_role_has_u8_repr() {
        // Stable wire format.
        assert_eq!(MemberRole::Member as u8, 0);
        assert_eq!(MemberRole::Owner as u8, 3);
    }

    #[test]
    fn channel_member_serde() {
        let m = ChannelMember {
            channel_id: "ch_01H".to_string(),
            user_id: 42,
            role: MemberRole::Admin,
            joined_at_micros: 1234567890,
        };
        let s = serde_json::to_string(&m).unwrap();
        let back: ChannelMember = serde_json::from_str(&s).unwrap();
        assert_eq!(m, back);
    }

    #[tokio::test]
    async fn new_methods_compile_and_return_defaults() {
        let store = LocalWabiStore::new();
        store.delete_channel("ch_1", 1).await.unwrap();
        store.delete_message("msg_1", 1).await.unwrap();
        store.edit_message("msg_1", 1, "new").await.unwrap();
        store.remove_reaction("msg_1", 42, "👍").await.unwrap();
        store.mute_user("ch_1", 1, 42, 9999).await.unwrap();
        store.unmute_user("ch_1", 1, 42).await.unwrap();
        assert!(!store.is_user_muted("ch_1", 42).await.unwrap());
        store.deafen_user("ch_1", 1, 42).await.unwrap();
        store.undeafen_user("ch_1", 1, 42).await.unwrap();
        assert!(!store.is_user_deafened("ch_1", 42).await.unwrap());
        assert!(store.get_emotes().await.unwrap().is_empty());
        store.upsert_emote("wave", "url", "Wave", "", "custom", "emoji", 42).await.unwrap();
        assert!(store.get_emoji_role_rules("msg_1").await.unwrap().is_empty());
        assert!(store.get_webhooks("ch_1").await.unwrap().is_empty());
        store.upsert_webhook("ch_1", "hook", "url").await.unwrap();
        assert!(store.get_user_layout(42).await.unwrap().is_none());
        store.upsert_user_layout(42, "{}").await.unwrap();
        assert!(store.get_whiteboard_doc("channel:abc").await.unwrap().is_none());
        store.put_whiteboard_doc("channel:abc", "{}").await.unwrap();
        assert!(store.get_channel_retention("ch_1").await.unwrap().is_none());
        store.upsert_channel_retention("ch_1", 30, 1).await.unwrap();
    }

    #[tokio::test]
    async fn get_user_returns_none_for_missing() {
        let store = LocalWabiStore::new();
        assert!(store.get_user(999).await.unwrap().is_none());
        assert!(store.get_user_by_username("nobody").await.unwrap().is_none());
        assert!(store.list_users().await.unwrap().is_empty());
    }

    #[test]
    fn message_serde() {
        let m = Message {
            message_id: "msg_01H".to_string(),
            channel_id: "ch_01H".to_string(),
            author_user_id: 42,
            author_username: None,
            author_display_name: None,
            author_device_id: "dev_01H".to_string(),
            content: "hello".to_string(),
            message_type: "text".to_string(),
            created_at_micros: 1234567890,
            edited_at_micros: None,
            commit_seq: 1,
            is_deleted: false,
            is_spoiler: false,
            files: vec![],
        };
        let s = serde_json::to_string(&m).unwrap();
        let back: Message = serde_json::from_str(&s).unwrap();
        assert_eq!(m, back);
    }
}
