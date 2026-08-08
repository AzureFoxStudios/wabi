//! wdbAdapter: implements `WabiStore` against the embedded WabiDB engine.
//!
//! Replaces the `WdbClient` (HTTP-to-wabiDB) path in wabi-server with a
//! direct call into the embedded `WabiDbEngine`.
//!
//! Each write method builds a `CommandCommit` and submits it via
//! `engine.run_command()`. Each read method queries the projection state and
//! deserializes the typed value (serde_json for now — the format the
//! projection handlers use).
//!
//! Status (2026-06-21): all 23 WabiStore methods implemented. Writes go
//! through the engine. Reads use `ProjectionState::get` and `for_each` with
//! serde_json value decoding. The on-disk projection handler key/value
//! formats are still being verified end-to-end; deserialization may need
//! to switch to bincode once the projection handlers' format is confirmed.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use wabidb::domain::{
    Ban, Channel, ChannelMember, DeafenRecord, EmojiRoleRule, Emote, Message,
    MuteRecord, Reaction, RetentionPolicy, RoleDefinition, User, UserLayout,
    Webhook,
};
use wabidb::engine::wabi_store::WabiStore;
use wabidb::projections::lore::LoreRepoRecord;
use wabidb::projections::query::QueryableProjection;
use wabidb::engine::{WabiDbConfig, WabiDbEngine};
use wabidb::error::{Result, WabiError};
use wabidb::format::record::RecordKind;
use wabidb::sequencer::types::{CommandCommit, EventToWrite};

/// Adapter from the WabiClient method shape to wabidb commands.
///
/// Holds an `Arc<WabiDbEngine>` and implements the `WabiStore` trait, which
/// is the integration surface the wabi-server's AppState holds as
/// `Arc<dyn WabiStore>`.
pub struct WdbAdapter {
    engine: Arc<WabiDbEngine>,
}

#[allow(dead_code)]
impl WdbAdapter {
    /// Open the engine at the given data dir (uses `from_env_var` config).
    pub async fn open(data_dir: &Path) -> Result<Self> {
        let config = WabiDbConfig::from_env_var(data_dir.to_path_buf());
        let engine = WabiDbEngine::open(config).await?;
        Ok(Self { engine: Arc::new(engine) })
    }

    /// Open the engine with a pre-built config (for production with replication).
    pub async fn open_with_config(config: WabiDbConfig) -> Result<Self> {
        let engine = WabiDbEngine::open(config).await?;
        Ok(Self { engine: Arc::new(engine) })
    }

    /// Open the engine with a passphrase-derived bootstrap key (production).
    pub async fn open_with_passphrase(
        data_dir: PathBuf,
        passphrase: String,
        salt: [u8; 16],
    ) -> Result<Self> {
        let config = WabiDbConfig::from_passphrase(data_dir, passphrase, salt);
        let engine = WabiDbEngine::open(config).await?;
        Ok(Self { engine: Arc::new(engine) })
    }

    /// Reference to the underlying engine (for advanced callers).
    pub fn engine(&self) -> &WabiDbEngine {
        &*self.engine
    }

    // ============================================================
    // Internal helpers
    // ============================================================

    /// Build a `CommandCommit` for the given command and submit it. Returns
    /// the resulting `commit_seq`.
    async fn run(
        &self,
        caller_user_id: u64,
        command_name: &str,
        stream_id: String,
        event_type: &str,
        stream_kind: u8,
        plaintext: Vec<u8>,
        essential: bool,
        idempotency_key: Option<String>,
    ) -> Result<u64> {
        let event_type_owned = event_type.to_string();
        let stream_id_for_cmd = stream_id.clone();
        let plaintext_for_cmd = plaintext.clone();
        // Ensure the stream has an encryption key (derived from bootstrap key).
        self.engine
            .get_or_create_stream_key(&stream_id_for_cmd)
            .await?;
        let cmd = CommandCommit {
            caller_user_id,
            caller_device_id: "primary".into(),
            command_name: command_name.into(),
            idempotency_key,
            events: vec![EventToWrite {
                stream_id: stream_id_for_cmd,
                event_type: event_type_owned.clone(),
                stream_kind,
                record_kind: RecordKind::Event,
                plaintext: plaintext_for_cmd,
            }],
            essential,
            response_tx: tokio::sync::oneshot::channel().0,
        };
        let outcome = self.engine.run_command(cmd).await?;
        // Fan-out to subscription engine for real-time push.
        self.engine
            .deliver_event(&stream_id, event_type, &plaintext, outcome.commit_seq)
            .await;
        Ok(outcome.commit_seq)
    }

    /// Serialize a JSON-serializable value into bytes for use as the
    /// `plaintext` payload of an `EventToWrite`.
    fn payload_json<T: serde::Serialize>(value: &T) -> Result<Vec<u8>> {
        serde_json::to_vec(value).map_err(|e| WabiError::Validation {
            command: "serialize".into(),
            reason: format!("serialize failed: {}", e),
        })
    }

    /// Deserialize value bytes from the projection state into a typed
    /// domain object. Takes a slice so it can be used from both
    /// `ProjectionState::get` (returns `Vec<u8>`) and `for_each` (gives
    /// `&[u8]`).
    fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T> {
        serde_json::from_slice(bytes).map_err(|e| WabiError::Validation {
            command: "deserialize".into(),
            reason: format!("decode failed: {}", e),
        })
    }
}

/// Returns current wall-clock time in microseconds since Unix epoch.
fn now_micros() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

/// Derive a URL-friendly slug from a title. Lowercases, replaces whitespace
/// with hyphens, removes non-alphanumeric characters.
fn slugify_title(title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() { "untitled".into() } else { slug }
}

impl WabiStore for WdbAdapter {
    // ============================================================
    // Writes
    // ============================================================

    async fn send_message(
        &self,
        channel_id: &str,
        user_id: u64,
        content: &str,
        is_spoiler: bool,
        files: &[wabidb::projections::messages::FileAttachmentRecord],
    ) -> Result<String> {
        use wabidb::projections::messages::{encode_record, MessageRecord};
        let idem = format!(
            "send_message:{}:{}",
            channel_id,
            uuid::Uuid::new_v4()
        );
        // Canonical wire/DB id: UUID. Must be stamped into the record BEFORE
        // commit so projection, session_messages, and socket emits agree.
        // Using only commit_seq caused client keyed {#each} collapses when
        // ids collided ("new message eats old").
        let message_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
        let record = MessageRecord {
            message_id: message_id.clone(),
            channel_id: channel_id.to_string(),
            author_user_id: user_id,
            author_device_id: String::new(),
            created_at_micros: now_micros(),
            encrypted_body_ref: content.to_string(),
            idempotency_key: Some(idem.clone()),
            edit_history: vec![],
            edited_at_micros: None,
            is_deleted: false,
            is_spoiler,
            files: files.to_vec(),
        };
        let payload = encode_record(&record);
        let _seq = self
            .run(
                user_id,
                "send_message",
                channel_id.to_string(),
                "message_created",
                1, // 1 = channel
                payload,
                true,
                Some(idem),
            )
            .await?;
        Ok(message_id)
    }

    async fn create_user(
        &self,
        username: &str,
        handle: Option<&str>,
        password_hash: &str,
    ) -> Result<u64> {
        use wabidb::projections::users::{encode_record, UserRecord};
        let now_micros = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as i64;
        let record = UserRecord {
            user_id: 0, // engine assigns
            username: username.to_string(),
            handle: handle.map(String::from),
            color: "#98D8C8".to_string(),
            password_hash: password_hash.to_string(),
            is_registered: true,
            is_active: true,
            created_at_micros: now_micros,
            last_seen_micros: now_micros,
            profile_picture: None,
            username_font: None,
            bio: None,
            status_message: None,
        };
        let payload = encode_record(&record);
        let seq = self
            .run(
                0,
                "create_user",
                "users".into(),
                "user_registered",
                6, // 6 = other
                payload,
                true,
                None,
            )
            .await?;
        Ok(seq)
    }

    async fn create_channel(
        &self,
        name: &str,
        channel_kind: wabidb::domain::ChannelKind,
        owner_user_id: u64,
        force_spoiler: bool,
    ) -> Result<String> {
        use wabidb::domain::Channel;
        let mut channel = Channel::new("", name, owner_user_id);
        channel.channel_kind = channel_kind;
        channel.force_spoiler = force_spoiler;
        // L1: Lore channels always carry asset_storage so repo auto-provision fires.
        if matches!(channel_kind, wabidb::domain::ChannelKind::Lore) {
            channel.asset_storage = true;
        }
        let payload = Self::payload_json(&channel)?;
        let seq = self
            .run(
                owner_user_id,
                "create_channel",
                "channels".into(),
                "channel_created",
                6,
                payload,
                true,
                None,
            )
            .await?;
        Ok(format!("ch_{:x}", seq))
    }

    async fn update_channel(
        &self,
        channel_id: &str,
        patch: &serde_json::Value,
        actor_user_id: u64,
    ) -> Result<()> {
        let mut payload = serde_json::Map::new();
        payload.insert("channel_id".to_string(), serde_json::json!(channel_id));
        if let Some(name) = patch.get("name") {
            payload.insert("name".to_string(), name.clone());
        }
        if let Some(desc) = patch.get("description") {
            payload.insert("description".to_string(), desc.clone());
        }
        if let Some(force) = patch.get("force_spoiler") {
            payload.insert("force_spoiler".to_string(), force.clone());
        }
        if let Some(asset) = patch.get("asset_storage") {
            payload.insert("asset_storage".to_string(), asset.clone());
        }
        if let Some(pos) = patch.get("position") {
            payload.insert("position".to_string(), pos.clone());
        }
        if let Some(parent) = patch.get("parent_id") {
            payload.insert("parent_id".to_string(), parent.clone());
        }
        let payload = serde_json::Value::Object(payload);
        self.run(
            actor_user_id,
            "update_channel",
            format!("channels:{}", channel_id),
            "channel_updated",
            1,
            Self::payload_json(&payload)?,
            false,
            None,
        )
        .await?;
        Ok(())
    }

    async fn add_reaction(
        &self,
        message_id: &str,
        user_id: u64,
        emote: &str,
    ) -> Result<()> {
        use wabidb::projections::reactions::{encode_reaction, Reaction};
        let reaction = Reaction {
            message_id: message_id.to_string(),
            user_id,
            reaction_type: emote.to_string(),
            created_at_micros: now_micros(),
            key_id: "v0".to_string(),
        };
        let payload = encode_reaction(&reaction);
        self.run(
            user_id,
            "add_reaction",
            format!("reactions:{}", message_id),
            "reaction_added",
            6,
            payload,
            false,
            None,
        )
        .await?;
        Ok(())
    }

    async fn add_channel_member(
        &self,
        channel_id: &str,
        user_id: u64,
        role: wabidb::domain::MemberRole,
    ) -> Result<()> {
        use wabidb::projections::channel_members::{encode_record, ChannelMemberRecord};
        let record = ChannelMemberRecord {
            channel_id: channel_id.to_string(),
            user_id,
            joined_at_micros: now_micros(),
            role: role as u8,
            nick: None,
        };
        let payload = encode_record(&record);
        self.run(
            user_id,
            "add_channel_member",
            format!("channel_members:{}", channel_id),
            "channel_member_added",
            1,
            payload,
            false,
            None,
        )
        .await?;
        Ok(())
    }

    async fn remove_channel_member(&self, channel_id: &str, user_id: u64) -> Result<()> {
        use wabidb::projections::channel_members::{encode_record, ChannelMemberRecord};
        let record = ChannelMemberRecord {
            channel_id: channel_id.to_string(),
            user_id,
            joined_at_micros: 0,
            role: 0,
            nick: None,
        };
        let payload = encode_record(&record);
        self.run(
            user_id,
            "remove_channel_member",
            format!("channel_members:{}", channel_id),
            "channel_member_removed",
            1,
            payload,
            false,
            None,
        )
        .await?;
        Ok(())
    }

    async fn ban_user(
        &self,
        channel_id: &str,
        actor_user_id: u64,
        target_user_id: u64,
        reason: &str,
    ) -> Result<()> {
        let payload = serde_json::json!({
            "channel_id": channel_id,
            "actor_user_id": actor_user_id,
            "target_user_id": target_user_id,
            "reason": reason,
        });
        self.run(
            actor_user_id,
            "ban_user",
            format!("bans:{}", channel_id),
            "ban_added",
            1,
            Self::payload_json(&payload)?,
            false,
            None,
        )
        .await?;
        Ok(())
    }

    async fn unban_user(
        &self,
        channel_id: &str,
        actor_user_id: u64,
        target_user_id: u64,
    ) -> Result<()> {
        let payload = serde_json::json!({
            "channel_id": channel_id,
            "actor_user_id": actor_user_id,
            "target_user_id": target_user_id,
        });
        self.run(
            actor_user_id,
            "unban_user",
            format!("bans:{}", channel_id),
            "ban_removed",
            1,
            Self::payload_json(&payload)?,
            false,
            None,
        )
        .await?;
        Ok(())
    }

    async fn touch_user(&self, user_id: u64) -> Result<()> {
        let payload = serde_json::json!({ "user_id": user_id });
        self.run(
            user_id,
            "touch_user",
            format!("user:{}", user_id),
            "user_touched",
            6,
            Self::payload_json(&payload)?,
            false,
            None,
        )
        .await?;
        Ok(())
    }

    async fn update_user(
        &self,
        user_id: u64,
        updates: wabidb::domain::UserUpdate,
    ) -> Result<()> {
        use wabidb::projections::users::{encode_record, UserRecord};

        let current = self
            .get_user(user_id)
            .await?
            .ok_or_else(|| WabiError::NotFound { what: format!("User {} not found", user_id) })?;

        let record = UserRecord {
            user_id,
            username: updates.username.unwrap_or(current.username),
            handle: current.handle,
            color: updates.color.unwrap_or(current.color),
            password_hash: updates.password_hash.unwrap_or(current.password_hash),
            is_registered: current.is_registered,
            is_active: current.is_active,
            created_at_micros: current.created_at_micros,
            last_seen_micros: current.last_seen_micros,
            profile_picture: updates.profile_picture.or(current.profile_picture),
            username_font: updates.username_font.or(current.username_font),
            bio: updates.bio.or(current.bio),
            status_message: updates.status_message.or(current.status_message),
        };
        let payload = encode_record(&record);
        self.run(
            user_id,
            "update_user",
            format!("user:{}", user_id),
            "user_updated",
            6,
            payload,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    // ============================================================
    // Reads
    // ============================================================

    async fn list_streams(&self) -> Result<Vec<String>> {
        let state = self.engine.projection_state();
        let mut out = Vec::new();
        state.for_each("streams", |_key, _value| {
            // The actual stream id isn't easily recoverable from raw bytes here;
            // this is a placeholder. The wabi-server's adapter can build its
            // own stream-id list from typed reads instead.
            out.push(String::new());
        });
        Ok(out.into_iter().filter(|s| !s.is_empty()).collect())
    }

    async fn get_message_typed(&self, message_id: &str) -> Result<Option<Message>> {
        use wabidb::projections::messages::MessagesProjection;
        use wabidb::projections::query::MessagesFilter;
        let state = self.engine.projection_state();
        // No message_id-only index yet, so query scans the primary index and
        // decodes only matching rows.
        let found = MessagesProjection
            .query(
                &state,
                &MessagesFilter {
                    include_deleted: true,
                    ..Default::default()
                },
            )?
            .into_iter()
            .find(|r| r.message_id == message_id)
            .map(Message::from);
        Ok(found)
    }

    async fn list_messages_typed(
        &self,
        channel_id: &str,
        limit: u64,
    ) -> Result<Vec<Message>> {
        use wabidb::projections::messages::MessagesProjection;
        use wabidb::projections::query::MessagesFilter;
        let state = self.engine.projection_state();
        let mut out: Vec<Message> = MessagesProjection
            .query(
                &state,
                &MessagesFilter {
                    channel_id: Some(channel_id.to_string()),
                    limit: Some(limit as usize),
                    ..Default::default()
                },
            )?
            .into_iter()
            .map(Message::from)
            .collect();
        out.sort_by(|a, b| a.created_at_micros.cmp(&b.created_at_micros));
        Ok(out)
    }

    async fn get_message(&self, message_id: &str) -> Result<Option<String>> {
        let msg = self.get_message_typed(message_id).await?;
        Ok(msg.map(|m| serde_json::to_string(&m).unwrap_or_default()))
    }

    async fn list_messages(&self, channel_id: &str, limit: u64) -> Result<Vec<String>> {
        let msgs = self.list_messages_typed(channel_id, limit).await?;
        Ok(msgs.into_iter().map(|m| m.message_id).collect())
    }

    async fn get_user(&self, user_id: u64) -> Result<Option<User>> {
        use wabidb::projections::users::decode_record;
        let state = self.engine.projection_state();
        let key = user_id.to_be_bytes().to_vec();
        match state.get("users", &key) {
            Some(bytes) => {
                let record = decode_record(&bytes)?;
                Ok(Some(User::from(record)))
            }
            None => Ok(None),
        }
    }

    async fn get_user_by_username(&self, username: &str) -> Result<Option<User>> {
        use wabidb::projections::query::UsersFilter;
        use wabidb::projections::users::UsersProjection;
        let state = self.engine.projection_state();
        let key_lc = username.to_lowercase();
        let found = UsersProjection
            .query(&state, &UsersFilter::default())?
            .into_iter()
            .find(|r| r.username.to_lowercase() == key_lc)
            .map(User::from);
        Ok(found)
    }

    async fn list_users(&self) -> Result<Vec<User>> {
        use wabidb::projections::query::UsersFilter;
        use wabidb::projections::users::UsersProjection;
        let state = self.engine.projection_state();
        let out: Vec<User> = UsersProjection
            .query(&state, &UsersFilter::default())?
            .into_iter()
            .map(User::from)
            .collect();
        Ok(out)
    }

    async fn claim_owner(&self, user_id: u64) -> Result<()> {
        use wabidb::projections::owner::{OwnerProjection, OwnerRecord};
        let payload = serde_json::to_vec(&OwnerRecord { owner_user_id: user_id })
            .map_err(|e| WabiError::Validation {
                command: "claim_owner".into(),
                reason: format!("serialize failed: {e}"),
            })?;
        self.run(
            user_id,
            "set_owner",
            "server_meta".into(),
            "owner_claimed",
            6,
            payload,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    async fn get_owner_user_id(&self) -> Result<Option<u64>> {
        use wabidb::projections::owner::OwnerProjection;
        let state = self.engine.projection_state();
        Ok(OwnerProjection::get_owner(&state))
    }

    async fn get_channel(&self, channel_id: &str) -> Result<Option<Channel>> {
        let state = self.engine.projection_state();
        let key = channel_id.as_bytes().to_vec();
        match state.get("channels", &key) {
            Some(bytes) => Ok(Some(Self::decode::<Channel>(&bytes)?)),
            None => Ok(None),
        }
    }

    async fn list_channels(&self, member_user_id: Option<u64>) -> Result<Vec<Channel>> {
        use wabidb::projections::channels::ChannelProjection;
        use wabidb::projections::query::ChannelsFilter;
        let state = self.engine.projection_state();
        let all: Vec<Channel> =
            ChannelProjection.query(&state, &ChannelsFilter::default())?;
        match member_user_id {
            None => Ok(all),
            Some(uid) => {
                // Filter by membership: read members index, then intersect.
                use wabidb::projections::channel_members::decode_record;
                let mut member_of = std::collections::HashSet::new();
                state.for_each("channel_members", |_key, value| {
                    if let Ok(m) = decode_record(value) {
                        if m.user_id == uid {
                            member_of.insert(m.channel_id);
                        }
                    }
                });
                Ok(all.into_iter().filter(|c| member_of.contains(&c.channel_id)).collect())
            }
        }
    }

    async fn list_channel_members(&self, channel_id: &str) -> Result<Vec<ChannelMember>> {
        use wabidb::projections::channel_members::decode_record;
        let state = self.engine.projection_state();
        let mut out: Vec<ChannelMember> = Vec::new();
        state.for_each("channel_members", |_key, value| {
            if let Ok(record) = decode_record(value) {
                if record.channel_id == channel_id {
                    out.push(ChannelMember::from(record));
                }
            }
        });
        Ok(out)
    }

    async fn list_reactions(&self, message_id: &str) -> Result<Vec<Reaction>> {
        use wabidb::projections::query::ReactionsFilter;
        use wabidb::projections::reactions::ReactionsProjection;
        let state = self.engine.projection_state();
        let out = ReactionsProjection
            .query(
                &state,
                &ReactionsFilter {
                    message_id: Some(message_id.to_string()),
                    ..Default::default()
                },
            )?
            .into_iter()
            .map(Reaction::from)
            .collect();
        Ok(out)
    }

    async fn list_bans(&self, channel_id: &str) -> Result<Vec<Ban>> {
        let state = self.engine.projection_state();
        let mut out: Vec<Ban> = Vec::new();
        state.for_each("bans", |_key, value| {
            if let Ok(b) = Self::decode::<Ban>(value) {
                if b.channel_id == channel_id {
                    out.push(b);
                }
            }
        });
        Ok(out)
    }

    async fn list_role_definitions(&self, channel_id: &str) -> Result<Vec<RoleDefinition>> {
        let state = self.engine.projection_state();
        let mut out: Vec<RoleDefinition> = Vec::new();
        state.for_each("role_definitions", |_key, value| {
            if let Ok(r) = Self::decode::<RoleDefinition>(value) {
                if r.channel_id == channel_id {
                    out.push(r);
                }
            }
        });
        Ok(out)
    }

    async fn get_user_role(&self, workspace_id: &str, user_id: u64) -> Result<Option<String>> {
        let state = self.engine.projection_state();
        Ok(wabidb::projections::audit::AuditProjection::get_role(
            state, workspace_id, user_id,
        ))
    }

    // ============================================================
    // Soft-delete + edit (overwrite with updated record)
    // ============================================================

    async fn delete_channel(&self, channel_id: &str, _actor_user_id: u64) -> Result<()> {
        // v1: soft-delete by overwriting the channel row with is_active=false.
        if let Some(mut ch) = self.get_channel(channel_id).await? {
            ch.is_active = false;
            let bytes = Self::payload_json(&ch)?;
            let state = self.engine.projection_state();
            let key = channel_id.as_bytes().to_vec();
            state.insert("channels", key, bytes, u64::MAX);
        }
        Ok(())
    }

    async fn delete_dm_channel(&self, channel_id: &str) -> Result<()> {
        self.delete_channel(channel_id, 0).await
    }

    async fn create_dm_channel(
        &self,
        channel_id: &str,
        name: &str,
        members: Option<&[String]>,
        my_user_id: i64,
    ) -> Result<String> {
        let payload = serde_json::json!({
            "channel_id": channel_id,
            "name": name,
            "channel_kind": wabidb::domain::ChannelKind::Dm as u8,
            "owner_user_id": my_user_id,
            "created_at_micros": now_micros(),
        });
        self.run(
            my_user_id as u64,
            "create_dm_channel",
            channel_id.into(),
            "channel_created",
            6,
            Self::payload_json(&payload)?,
            true,
            None,
        )
        .await?;
        if let Some(member_ids) = members {
            for m in member_ids.iter() {
                let user_id = m.trim_start_matches("user-").parse::<u64>().unwrap_or(0);
                if user_id > 0 {
                    self.add_channel_member(channel_id, user_id, wabidb::domain::MemberRole::Member).await?;
                }
            }
        }
        Ok(channel_id.to_string())
    }

    async fn upsert_group(
        &self,
        channel_id: &str,
        name: &str,
        _kind: &str,
        members: Option<&[String]>,
        _avatar: Option<&str>,
        _description: Option<&str>,
    ) -> Result<String> {
        let payload = serde_json::json!({
            "channel_id": channel_id,
            "name": name,
            "channel_kind": wabidb::domain::ChannelKind::GroupDm as u8,
            "owner_user_id": 0,
            "created_at_micros": now_micros(),
        });
        self.run(
            0,
            "upsert_group",
            channel_id.into(),
            "channel_created",
            6,
            Self::payload_json(&payload)?,
            true,
            None,
        )
        .await?;
        if let Some(member_ids) = members {
            for m in member_ids.iter() {
                let user_id = m.trim_start_matches("user-").parse::<u64>().unwrap_or(0);
                if user_id > 0 {
                    self.add_channel_member(channel_id, user_id, wabidb::domain::MemberRole::Member).await?;
                }
            }
        }
        Ok(channel_id.to_string())
    }

    async fn get_channels_raw(
        &self,
    ) -> Result<Vec<std::collections::HashMap<String, serde_json::Value>>> {
        use wabidb::projections::channels::ChannelProjection;
        use wabidb::projections::query::ChannelsFilter;
        let state = self.engine.projection_state();
        let mut out = Vec::new();
        for c in ChannelProjection.query(&state, &ChannelsFilter::default())? {
            let mut row = std::collections::HashMap::new();
                row.insert("channel_id".into(), serde_json::Value::String(c.channel_id.clone()));
                row.insert("id".into(), serde_json::Value::String(c.channel_id));
                row.insert("name".into(), serde_json::Value::String(c.name));
                row.insert("created_at".into(), serde_json::json!(c.created_at_micros));
                let kind = match c.channel_kind {
                    wabidb::domain::ChannelKind::Text => {
                        if c.asset_storage { "lore" } else { "text" }
                    }
                    wabidb::domain::ChannelKind::Voice => "voice",
                    wabidb::domain::ChannelKind::Dm => "dm",
                    wabidb::domain::ChannelKind::GroupDm => "group",
                    wabidb::domain::ChannelKind::Announcement => "announcement",
                    wabidb::domain::ChannelKind::Whiteboard => "whiteboard",
                    wabidb::domain::ChannelKind::Wiki => "wiki",
                    wabidb::domain::ChannelKind::Forum => "forum",
                    wabidb::domain::ChannelKind::Incident => "incident",
                    wabidb::domain::ChannelKind::Gallery => "gallery",
                    wabidb::domain::ChannelKind::Category => "category",
                    wabidb::domain::ChannelKind::Lore => "lore",
                wabidb::domain::ChannelKind::Planning => "planning",
                };
                row.insert("channel_type".into(), serde_json::json!(kind));
                row.insert("type".into(), serde_json::json!(kind));
                if let Some(desc) = &c.description {
                    row.insert("description".into(), serde_json::json!(desc));
                }
                // Category/sidebar nesting uses parent_id → wire as parentId.
                // Do NOT alias into parent_channel_id (that is threads/breakouts on the FE).
                row.insert("position".into(), serde_json::json!(c.position));
                if let Some(parent) = &c.parent_id {
                    row.insert("parent_id".into(), serde_json::json!(parent));
                    row.insert("parentId".into(), serde_json::json!(parent));
                }
                row.insert("force_spoiler".into(), serde_json::json!(c.force_spoiler));
                row.insert(
                    "asset_storage".into(),
                    serde_json::json!(
                        c.asset_storage
                            || matches!(c.channel_kind, wabidb::domain::ChannelKind::Lore)
                    ),
                );
                out.push(row);
            }
        Ok(out)
    }

    async fn delete_message(&self, message_id: &str, actor_user_id: u64) -> Result<()> {
        use wabidb::projections::messages::{encode_record, MessageRecord};
        if let Some(mut m) = self.get_message_typed(message_id).await? {
            m.is_deleted = true;
            m.edited_at_micros = Some(now_micros());
            let record = MessageRecord::from(m);
            let payload = encode_record(&record);
            self.run(
                actor_user_id,
                "delete_message",
                record.channel_id.clone(),
                "message_deleted",
                1,
                payload,
                true,
                None,
            )
            .await?;
        }
        Ok(())
    }

    async fn edit_message(
        &self,
        message_id: &str,
        actor_user_id: u64,
        new_content: &str,
    ) -> Result<()> {
        use wabidb::projections::messages::{encode_record, MessageRecord};
        if let Some(mut m) = self.get_message_typed(message_id).await? {
            m.content = new_content.to_string();
            m.edited_at_micros = Some(now_micros());
            let record = MessageRecord::from(m);
            let payload = encode_record(&record);
            self.run(
                actor_user_id,
                "edit_message",
                record.channel_id.clone(),
                "message_edited",
                1,
                payload,
                true,
                None,
            )
            .await?;
        }
        Ok(())
    }

    async fn remove_reaction(
        &self,
        message_id: &str,
        user_id: u64,
        emote: &str,
    ) -> Result<()> {
        use wabidb::projections::reactions::{encode_reaction, Reaction};
        let reaction = Reaction {
            message_id: message_id.to_string(),
            user_id,
            reaction_type: emote.to_string(),
            created_at_micros: now_micros(),
            key_id: "v0".to_string(),
        };
        let payload = encode_reaction(&reaction);
        self.run(
            user_id,
            "remove_reaction",
            format!("reactions:{}:{}:removed", message_id, emote),
            "reaction_removed",
            6,
            payload,
            false,
            None,
        )
        .await?;
        Ok(())
    }

    // ============================================================
    // Mutes / deafens (per-channel voice moderation)
    // ============================================================

    async fn mute_user(
        &self,
        channel_id: &str,
        actor_user_id: u64,
        target_user_id: u64,
        until_micros: i64,
    ) -> Result<()> {
        let payload = serde_json::json!({
            "channel_id": channel_id,
            "target_user_id": target_user_id,
            "until_micros": until_micros,
        });
        self.run(
            actor_user_id,
            "mute_user",
            format!("mutes:{}:{}", channel_id, target_user_id),
            "user_muted",
            1,
            Self::payload_json(&payload)?,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    async fn unmute_user(
        &self,
        channel_id: &str,
        actor_user_id: u64,
        target_user_id: u64,
    ) -> Result<()> {
        let payload = serde_json::json!({
            "channel_id": channel_id,
            "target_user_id": target_user_id,
        });
        self.run(
            actor_user_id,
            "unmute_user",
            format!("mutes:{}:{}", channel_id, target_user_id),
            "user_unmuted",
            1,
            Self::payload_json(&payload)?,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    async fn is_user_muted(&self, channel_id: &str, user_id: u64) -> Result<bool> {
        // v1: scan the mutes index for the (channel_id, user_id) pair.
        let state = self.engine.projection_state();
        let mut found = false;
        state.for_each("mutes", |_key, value| {
            if let Ok(m) = Self::decode::<MuteRecord>(value) {
                if m.channel_id == channel_id && m.user_id == user_id {
                    found = true;
                }
            }
        });
        Ok(found)
    }

    async fn deafen_user(
        &self,
        channel_id: &str,
        actor_user_id: u64,
        target_user_id: u64,
    ) -> Result<()> {
        let payload = serde_json::json!({
            "channel_id": channel_id,
            "target_user_id": target_user_id,
        });
        self.run(
            actor_user_id,
            "deafen_user",
            format!("deafens:{}:{}", channel_id, target_user_id),
            "user_deafened",
            1,
            Self::payload_json(&payload)?,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    async fn undeafen_user(
        &self,
        channel_id: &str,
        actor_user_id: u64,
        target_user_id: u64,
    ) -> Result<()> {
        self.run(
            actor_user_id,
            "undeafen_user",
            format!("deafens:{}:{}", channel_id, target_user_id),
            "user_undeafened",
            1,
            Self::payload_json(&serde_json::json!({
                "channel_id": channel_id,
                "target_user_id": target_user_id,
            }))?,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    async fn is_user_deafened(&self, channel_id: &str, user_id: u64) -> Result<bool> {
        let state = self.engine.projection_state();
        let mut found = false;
        state.for_each("deafens", |_key, value| {
            if let Ok(d) = Self::decode::<DeafenRecord>(value) {
                if d.channel_id == channel_id && d.user_id == user_id {
                    found = true;
                }
            }
        });
        Ok(found)
    }

    // ============================================================
    // Emotes / webhooks / user layouts / channel retention
    // ============================================================

    async fn get_emotes(&self) -> Result<Vec<Emote>> {
        use wabidb::projections::emotes::decode_record;
        let state = self.engine.projection_state();
        let mut out = Vec::new();
        state.for_each("emotes", |_key, value| {
            if let Ok(e) = decode_record(value) {
                out.push(e);
            }
        });
        Ok(out)
    }

    async fn upsert_emote(
        &self,
        name: &str,
        image_url: &str,
        display_name: &str,
        artist: &str,
        category: &str,
        kind: &str,
        created_by_user_id: u64,
    ) -> Result<()> {
        use wabidb::domain::Emote;
        use wabidb::projections::emotes::encode_record;
        let now = now_micros();
        let emote = Emote {
            emote_id: format!("emo_{}", name),
            name: name.to_string(),
            image_url: image_url.to_string(),
            created_at_micros: now,
            created_by_user_id,
            display_name: display_name.to_string(),
            artist: artist.to_string(),
            category: if category.is_empty() {
                "custom".to_string()
            } else {
                category.to_string()
            },
            kind: if kind.is_empty() {
                "emoji".to_string()
            } else {
                kind.to_string()
            },
        };
        let payload = encode_record(&emote);
        self.run(
            created_by_user_id,
            "upsert_emote",
            "emotes".into(),
            "emote_upserted",
            6,
            payload,
            false,
            None,
        )
        .await?;
        Ok(())
    }

    async fn delete_emote(&self, name: &str) -> Result<()> {
        self.run(
            0,
            "delete_emote",
            "emotes".into(),
            "emote_deleted",
            6,
            format!("emo_{}", name).into_bytes(),
            false,
            None,
        )
        .await?;
        Ok(())
    }

    async fn get_emoji_role_rules(&self, message_id: &str) -> Result<Vec<EmojiRoleRule>> {
        let state = self.engine.projection_state();
        let mut out = Vec::new();
        state.for_each("emoji_role_rules", |_key, value| {
            if let Ok(r) = Self::decode::<EmojiRoleRule>(value) {
                if r.message_id == message_id {
                    out.push(r);
                }
            }
        });
        Ok(out)
    }

    async fn upsert_webhook(&self, channel_id: &str, name: &str, url: &str) -> Result<()> {
        use wabidb::domain::Webhook;
        use wabidb::projections::webhooks::encode_record;
        let now = now_micros();
        let webhook = Webhook {
            webhook_id: format!("wh_{}", uuid::Uuid::new_v4()),
            channel_id: channel_id.to_string(),
            name: name.to_string(),
            url: url.to_string(),
            created_at_micros: now,
            created_by_user_id: 0,
        };
        let payload = encode_record(&webhook);
        self.run(
            0,
            "upsert_webhook",
            format!("webhooks:{}", channel_id),
            "webhook_upserted",
            1,
            payload,
            false,
            None,
        )
        .await?;
        Ok(())
    }

    async fn get_webhooks(&self, channel_id: &str) -> Result<Vec<Webhook>> {
        use wabidb::projections::webhooks::decode_record;
        let state = self.engine.projection_state();
        let mut out = Vec::new();
        state.for_each("webhooks", |_key, value| {
            if let Ok(w) = decode_record(value) {
                if w.channel_id == channel_id {
                    out.push(w);
                }
            }
        });
        Ok(out)
    }

    async fn get_user_layout(&self, user_id: u64) -> Result<Option<UserLayout>> {
        use wabidb::projections::layouts::decode_record;
        use wabidb::projections::layouts::encode_key;
        let state = self.engine.projection_state();
        let key = encode_key(user_id);
        match state.get("user_layouts", &key) {
            Some(bytes) => {
                match decode_record(&bytes) {
                    Ok(layout) => Ok(Some(layout)),
                    Err(e) => Err(wabidb::error::WabiError::Validation {
                        command: "get_user_layout".into(),
                        reason: format!("failed to decode user layout record: {e}"),
                    }),
                }
            }
            None => Ok(None),
        }
    }

    async fn upsert_user_layout(&self, user_id: u64, layout_json: &str) -> Result<()> {
        use wabidb::domain::UserLayout;
        use wabidb::projections::layouts::encode_record;
        let layout = UserLayout {
            user_id,
            layout_json: layout_json.to_string(),
            updated_at_micros: now_micros(),
        };
        let payload = encode_record(&layout);
        self.run(
            user_id,
            "upsert_user_layout",
            format!("user_layouts:{}", user_id),
            "user_layout_upserted",
            6,
            payload,
            false,
            None,
        )
        .await?;
        Ok(())
    }

    async fn get_whiteboard_doc(&self, board_id: &str) -> Result<Option<String>> {
        use wabidb::projections::whiteboard_docs::{decode_record, encode_key};
        let state = self.engine.projection_state();
        let key = encode_key(board_id);
        match state.get("whiteboard_docs", &key) {
            Some(bytes) => match decode_record(&bytes) {
                Ok(doc) => Ok(Some(doc.doc_json)),
                Err(e) => Err(wabidb::error::WabiError::Validation {
                    command: "get_whiteboard_doc".into(),
                    reason: format!("failed to decode whiteboard doc record: {e}"),
                }),
            },
            None => Ok(None),
        }
    }

    async fn put_whiteboard_doc(&self, board_id: &str, json: &str) -> Result<()> {
        use wabidb::domain::WhiteboardDoc;
        use wabidb::projections::whiteboard_docs::encode_record;
        let doc = WhiteboardDoc {
            board_id: board_id.to_string(),
            doc_json: json.to_string(),
            updated_at_micros: now_micros(),
        };
        let payload = encode_record(&doc);
        self.run(
            0,
            "put_whiteboard_doc",
            format!("whiteboard_docs:{}", board_id),
            "whiteboard_doc_upserted",
            6,
            payload,
            false,
            None,
        )
        .await?;
        Ok(())
    }

    async fn get_channel_retention(&self, channel_id: &str) -> Result<Option<RetentionPolicy>> {
        let state = self.engine.projection_state();
        let key = channel_id.as_bytes().to_vec();
        match state.get("channel_retention", &key) {
            Some(bytes) => Ok(Some(Self::decode::<RetentionPolicy>(&bytes)?)),
            None => Ok(None),
        }
    }

    async fn upsert_channel_retention(
        &self,
        channel_id: &str,
        days: u32,
        set_by_user_id: u64,
    ) -> Result<()> {
        let payload = serde_json::json!({
            "channel_id": channel_id,
            "days": days,
            "set_by_user_id": set_by_user_id,
        });
        self.run(
            set_by_user_id,
            "upsert_channel_retention",
            format!("channel_retention:{}", channel_id),
            "channel_retention_upserted",
            1,
            Self::payload_json(&payload)?,
            false,
            None,
        )
        .await?;
        Ok(())
    }

    async fn upsert_member_role(
        &self,
        channel_id: &str,
        user_id: u64,
        role: wabidb::domain::MemberRole,
    ) -> Result<()> {
        let payload = serde_json::json!({
            "channel_id": channel_id,
            "user_id": user_id,
            "role": role as u8,
        });
        self.run(
            user_id,
            "upsert_member_role",
            format!("member_roles:{}", channel_id),
            "member_role_upserted",
            6,
            Self::payload_json(&payload)?,
            false,
            None,
        )
        .await?;
        Ok(())
    }

    /// Generic event ingest — WDB-compat routing table.
    ///
    /// Maps `(entity, op)` pairs from the old `ingest_wabi_event` funnel to
    /// typed WDB commands. Writes go through `self.run()` so they enter the
    /// stream log durably, even if no projection handler exists yet. When a
    /// future projection is added for the entity, replay from the stream log
    /// will pick up these events.
    async fn ingest_event(
        &self,
        entity: &str,
        op: &str,
        payload: &serde_json::Value,
    ) -> Result<()> {
        match (entity, op) {
            ("rbac", "assign_role") => {
                let user_id = payload.get("userId").and_then(|v| v.as_i64()).unwrap_or(0) as u64;
                let workspace_id = payload.get("workspaceId").and_then(|v| v.as_str()).unwrap_or("default");
                let role = payload.get("role").and_then(|v| v.as_str()).unwrap_or("Member");
                let assigned_by = payload.get("assignedBy").and_then(|v| v.as_i64()).unwrap_or(0) as u64;
                let pl = serde_json::json!({
                    "user_id": user_id,
                    "workspace_id": workspace_id,
                    "role": role,
                    "assigned_by": assigned_by,
                });
                self.run(
                    assigned_by,
                    "ingest_rbac_assign_role",
                    format!("rbac:{}", workspace_id),
                    "role_assigned",
                    6,
                    Self::payload_json(&pl)?,
                    false,
                    None,
                ).await?;
            }
            ("rbac", "remove_role") => {
                let user_id = payload.get("userId").and_then(|v| v.as_i64()).unwrap_or(0) as u64;
                let workspace_id = payload.get("workspaceId").and_then(|v| v.as_str()).unwrap_or("default");
                let role = payload.get("role").and_then(|v| v.as_str()).unwrap_or("Member");
                let pl = serde_json::json!({
                    "user_id": user_id,
                    "workspace_id": workspace_id,
                    "role": role,
                });
                self.run(
                    0,
                    "ingest_rbac_remove_role",
                    format!("rbac:{}", workspace_id),
                    "role_removed",
                    6,
                    Self::payload_json(&pl)?,
                    false,
                    None,
                ).await?;
            }
            ("channel", "update_settings") => {
                let row = &payload["row"];
                let channel_id = row.get("channel_id").and_then(|v| v.as_str()).unwrap_or("");
                let pl = serde_json::json!({
                    "channel_id": channel_id,
                    "settings": row,
                });
                self.run(
                    0,
                    "ingest_channel_update_settings",
                    format!("channel_settings:{}", channel_id),
                    "channel_settings_updated",
                    1,
                    Self::payload_json(&pl)?,
                    false,
                    None,
                ).await?;
            }
            ("channel", "update") => {
                // Merge a partial channel update into the `channels` index
                // (used for force_spoiler, name, description). The projection
                // (`channel_updated`) applies only the provided fields.
                let row = &payload["row"];
                let channel_id = row.get("channel_id").and_then(|v| v.as_str()).unwrap_or("");
                let pl = serde_json::json!({
                    "channel_id": channel_id,
                    "name": row.get("name"),
                    "description": row.get("description"),
                    "force_spoiler": row.get("force_spoiler"),
                });
                self.run(
                    0,
                    "ingest_channel_update",
                    format!("channels:{}", channel_id),
                    "channel_updated",
                    1,
                    Self::payload_json(&pl)?,
                    false,
                    None,
                ).await?;
            }
            // Payment event types — written to the stream log for future
            // projection processing. No projection handler exists in v1.
            ("payment", _) => {
                let pl = serde_json::json!({
                    "entity": entity,
                    "op": op,
                    "payload": payload,
                });
                self.run(
                    0,
                    "ingest_payment_event",
                    "payments".into(),
                    &format!("payment_{}", op),
                    6,
                    Self::payload_json(&pl)?,
                    false,
                    None,
                ).await?;
            }
            // Unknown entity/op pairs are silently logged but not persisted.
            // This matches WDB compat behavior — unknown events were
            // dropped by the WDB bridge's reducer.
            _ => {
                tracing::debug!("ingest_event: unhandled ({}, {})", entity, op);
            }
        }
        Ok(())
    }

    async fn is_user_banned(&self, _user_id: u64) -> Result<bool> {
        // v1: no server-wide ban enforcement. Per-channel bans are checked
        // by the wabi-server handler when it has channel context.
        Ok(false)
    }

    // --- subscription bridge ---

    async fn subscribe_stream(
        &self,
        consumer_id: &str,
        topic: &str,
        since: u64,
    ) -> Result<tokio::sync::broadcast::Receiver<wabidb::engine::SubscriptionDelivery>> {
        Ok(self.engine.subscribe_stream(consumer_id, topic, since).await)
    }

    async fn unsubscribe_stream(&self, consumer_id: &str, topic: &str) -> Result<bool> {
        Ok(self.engine.unsubscribe_stream(consumer_id, topic).await)
    }
// --- call-session state (replaces WDB call_session_* tables) ---

    async fn create_call_session(
        &self,
        session_id: String,
        channel_id: String,
        call_type: String,
        host_user_id: u64,
        max_participants: u32,
        transport: String,
    ) -> Result<u64> {
        use wabidb::commands::call_session_create;
        let sequencer = self.engine.sequencer().ok_or_else(|| wabidb::error::WabiError::InternalInvariantViolated { invariant: "sequencer not initialized".into() })?;
        call_session_create::create_call_session(
            session_id,
            channel_id,
            call_type,
            host_user_id,
            max_participants,
            transport,
            self.engine(),
            sequencer,
        )
        .await
        .map(|o| o.commit_seq)
    }

    async fn join_call_session(
        &self,
        session_id: String,
        user_id: u64,
        stable_user_id: String,
        is_host: bool,
    ) -> Result<u64> {
        use wabidb::commands::call_session_join;
        let sequencer = self.engine.sequencer().ok_or_else(|| wabidb::error::WabiError::InternalInvariantViolated { invariant: "sequencer not initialized".into() })?;
        call_session_join::join_call_session(
            session_id,
            user_id,
            stable_user_id,
            is_host,
            self.engine(),
            sequencer,
        )
        .await
        .map(|o| o.commit_seq)
    }

    async fn leave_call_session(
        &self,
        session_id: String,
        user_id: u64,
    ) -> Result<u64> {
        use wabidb::commands::call_session_leave;
        let sequencer = self.engine.sequencer().ok_or_else(|| wabidb::error::WabiError::InternalInvariantViolated { invariant: "sequencer not initialized".into() })?;
        call_session_leave::leave_call_session(session_id, user_id, self.engine(), sequencer)
            .await
            .map(|o| o.commit_seq)
    }

    async fn end_call_session(
        &self,
        session_id: String,
        actor_user_id: u64,
    ) -> Result<u64> {
        use wabidb::commands::call_session_end;
        let sequencer = self.engine.sequencer().ok_or_else(|| wabidb::error::WabiError::InternalInvariantViolated { invariant: "sequencer not initialized".into() })?;
        call_session_end::end_call_session(session_id, actor_user_id, self.engine(), sequencer)
            .await
            .map(|o| o.commit_seq)
    }

    async fn emit_call_signal(
        &self,
        session_id: String,
        from_user_id: u64,
        signal_type: String,
        target_user_id: Option<u64>,
        payload: String,
        signal_id: u64,
    ) -> Result<u64> {
        use wabidb::commands::call_signal_emit;
        let sequencer = self.engine.sequencer().ok_or_else(|| wabidb::error::WabiError::InternalInvariantViolated { invariant: "sequencer not initialized".into() })?;
        call_signal_emit::emit_call_signal(
            session_id,
            from_user_id,
            signal_type,
            target_user_id,
            payload,
            signal_id,
            self.engine(),
            sequencer,
        )
        .await
        .map(|o| o.commit_seq)
    }

    async fn get_call_session(
        &self,
        session_id: &str,
    ) -> Result<Option<wabidb::domain::CallSession>> {
        use wabidb::projections::call_sessions;
        let key = call_sessions::encode_key(session_id);
        match self.engine.projection_state().get(call_sessions::INDEX_NAME, &key) {
            Some(bytes) => Ok(Some(call_sessions::decode_value(&bytes)?)),
            None => Ok(None),
        }
    }

    async fn get_call_participants(
        &self,
        session_id: &str,
    ) -> Result<Vec<wabidb::domain::CallParticipant>> {
        use wabidb::projections::call_participants;
        let secondary_key = call_participants::secondary_key(session_id);
        let mut participants = Vec::new();
        let Some(keys_bytes) = self
            .engine.projection_state()
            .get(call_participants::INDEX_NAME, &secondary_key)
        else {
            return Ok(participants);
        };
        let keys: Vec<String> = serde_json::from_slice(&keys_bytes).map_err(|e| {
            wabidb::error::WabiError::Validation {
                command: "get_call_participants".into(),
                reason: format!("decode secondary index: {e}"),
            }
        })?;
        for k in keys {
            let pk = call_participants::encode_key(&k);
            if let Some(bytes) = self.engine.projection_state().get(call_participants::INDEX_NAME, &pk) {
                participants.push(call_participants::decode_value(&bytes)?);
            }
        }
        Ok(participants)
    }

    async fn get_call_signals(
        &self,
        session_id: &str,
        since_signal_id: u64,
    ) -> Result<Vec<wabidb::domain::CallSignal>> {
        use wabidb::projections::call_signals;
        let mut signals = Vec::new();
        self.engine.projection_state().for_each(call_signals::INDEX_NAME, |k, v| {
            // Key format: "<session_id>:<20-digit-zero-padded-signal_id>"
            let key = String::from_utf8_lossy(k);
            let Some((stored_session, id_str)) = key.split_once(':') else {
                return;
            };
            if stored_session != session_id {
                return;
            }
            let Ok(id) = id_str.parse::<u64>() else {
                return;
            };
            if id <= since_signal_id {
                return;
            }
            match call_signals::decode_value(v) {
                Ok(sig) => signals.push(sig),
                Err(_) => {}
            }
        });
        signals.sort_by_key(|s| s.signal_id);
        Ok(signals)
    }

    // ============================================================
    // Album / album-items
    // ============================================================

    async fn list_albums(&self, scope_type: &str, scope_id: &str) -> Result<Vec<wabidb::domain::Album>> {
        use wabidb::projections::albums;
        let state = self.engine.projection_state();
        let records = albums::AlbumProjection::list_albums(&state, scope_type, scope_id, false)?;
        Ok(records.into_iter().map(wabidb::domain::Album::from).collect())
    }

    async fn get_album(&self, scope_type: &str, scope_id: &str, album_id: &str) -> Result<Option<wabidb::domain::Album>> {
        use wabidb::projections::albums;
        let state = self.engine.projection_state();
        match albums::AlbumProjection::get_album(&state, scope_type, scope_id, album_id)? {
            Some(r) => Ok(Some(wabidb::domain::Album::from(r))),
            None => Ok(None),
        }
    }

    async fn create_album(&self, scope_type: &str, scope_id: &str, name: &str, user_id: u64) -> Result<String> {
        use wabidb::projections::albums::{encode_record, AlbumRecord};
        let now = now_micros();
        let record = AlbumRecord {
            album_id: String::new(),
            scope_type: scope_type.to_string(),
            scope_id: scope_id.to_string(),
            name: name.to_string(),
            description: String::new(),
            owner_user_id: user_id,
            cover_url: String::new(),
            created_at_micros: now,
            updated_at_micros: now,
            is_deleted: false,
        };
        let payload = encode_record(&record);
        let seq = self
            .run(
                user_id,
                "create_album",
                format!("albums:{}", scope_id),
                "album_created",
                6,
                payload,
                true,
                None,
            )
            .await?;
        Ok(format!("alb_{:x}", seq))
    }

    async fn delete_album(&self, scope_type: &str, scope_id: &str, album_id: &str, user_id: u64) -> Result<()> {
        use wabidb::projections::albums::{self, encode_record};
        let state = self.engine.projection_state();
        if let Some(mut record) = albums::AlbumProjection::get_album(&state, scope_type, scope_id, album_id)? {
            record.is_deleted = true;
            record.updated_at_micros = now_micros();
            let payload = encode_record(&record);
            self.run(
                user_id,
                "delete_album",
                format!("albums:{}", scope_id),
                "album_deleted",
                6,
                payload,
                true,
                None,
            )
            .await?;
        }
        Ok(())
    }

    async fn list_items(&self, album_id: &str) -> Result<Vec<wabidb::domain::AlbumItem>> {
        use wabidb::projections::album_items;
        let state = self.engine.projection_state();
        let records = album_items::AlbumItemsProjection::list_items(&state, album_id, false)?;
        Ok(records.into_iter().map(wabidb::domain::AlbumItem::from).collect())
    }

    async fn add_item(&self, album_id: &str, url: &str, name: &str, caption: Option<&str>, user_id: u64) -> Result<String> {
        use wabidb::projections::album_items::{encode_record, AlbumItemRecord};
        let now = now_micros();
        let record = AlbumItemRecord {
            item_id: String::new(),
            album_id: album_id.to_string(),
            url: url.to_string(),
            name: name.to_string(),
            size: None,
            mime: None,
            caption: caption.map(String::from),
            sort_order: 0,
            created_at_micros: now,
            is_deleted: false,
        };
        let payload = encode_record(&record);
        let seq = self
            .run(
                user_id,
                "add_item",
                format!("album_items:{}", album_id),
                "album_item_added",
                6,
                payload,
                true,
                None,
            )
            .await?;
        Ok(format!("item_{:x}", seq))
    }

    async fn delete_item(&self, album_id: &str, item_id: &str, user_id: u64) -> Result<()> {
        use wabidb::projections::album_items::{self, encode_record};
        let state = self.engine.projection_state();
        if let Some(mut record) = album_items::AlbumItemsProjection::get_item(&state, album_id, item_id)? {
            record.is_deleted = true;
            let payload = encode_record(&record);
            self.run(
                user_id,
                "delete_item",
                format!("album_items:{}", album_id),
                "album_item_removed",
                6,
                payload,
                true,
                None,
            )
            .await?;
        }
        Ok(())
    }

    // ================================================================
    // Wiki
    // ================================================================

    async fn get_wiki_page(&self, channel_id: &str, page_id: &str) -> Result<Option<wabidb::domain::WikiPage>> {
        use wabidb::projections::wiki;
        let state = self.engine.projection_state();
        match wiki::WikiProjection::get_page(&state, channel_id, page_id)? {
            Some(r) => Ok(Some(wabidb::domain::WikiPage::from(r))),
            None => Ok(None),
        }
    }

    async fn list_wiki_pages(&self, channel_id: &str) -> Result<Vec<wabidb::domain::WikiPage>> {
        use wabidb::projections::wiki;
        let state = self.engine.projection_state();
        let records = wiki::WikiProjection::list_pages(&state, channel_id, false)?;
        Ok(records.into_iter().map(wabidb::domain::WikiPage::from).collect())
    }

    async fn create_wiki_page(
        &self,
        channel_id: &str,
        title: &str,
        body: &str,
        author_user_id: u64,
        parent_page_id: &str,
        slug: &str,
        order_index: i64,
    ) -> Result<String> {
        use wabidb::projections::wiki::{encode_record, WikiPageRecord};
        let now = now_micros();
        let slug = if slug.is_empty() {
            slugify_title(title)
        } else {
            slug.to_string()
        };
        let record = WikiPageRecord {
            page_id: String::new(),
            channel_id: channel_id.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            author_user_id,
            created_at_micros: now,
            updated_at_micros: now,
            is_deleted: false,
            parent_page_id: parent_page_id.to_string(),
            slug,
            order_index,
        };
        let payload = encode_record(&record);
        let seq = self
            .run(
                author_user_id,
                "create_wiki_page",
                channel_id.to_string(),
                "wiki_page_created",
                6,
                payload,
                true,
                None,
            )
            .await?;
        Ok(format!("page_{:x}", seq))
    }

    async fn update_wiki_page(
        &self,
        channel_id: &str,
        page_id: &str,
        title: &str,
        body: &str,
        author_user_id: u64,
        parent_page_id: &str,
        slug: &str,
        order_index: i64,
    ) -> Result<()> {
        use wabidb::projections::wiki::{self, encode_record, encode_revision_record, WikiPageRecord, WikiRevisionRecord};
        let state = self.engine.projection_state();
        let existing = wiki::WikiProjection::get_page(&state, channel_id, page_id)?;
        let record = match existing {
            Some(r) => {
                // Capture pre-edit state as a revision
                let revision = WikiRevisionRecord {
                    revision_id: String::new(),
                    page_id: r.page_id.clone(),
                    channel_id: r.channel_id.clone(),
                    editor_user_id: author_user_id,
                    title: r.title.clone(),
                    body: r.body.clone(),
                    summary: String::new(),
                    created_at_micros: now_micros(),
                };
                let rev_payload = encode_revision_record(&revision);
                let rev_seq = self
                    .run(
                        author_user_id,
                        "create_wiki_revision",
                        channel_id.to_string(),
                        "wiki_revision_created",
                        6,
                        rev_payload,
                        true,
                        None,
                    )
                    .await?;
                let _ = rev_seq;
                let slug = if slug.is_empty() { r.slug.clone() } else { slug.to_string() };
                WikiPageRecord {
                    page_id: r.page_id,
                    channel_id: r.channel_id,
                    title: title.to_string(),
                    body: body.to_string(),
                    author_user_id: r.author_user_id,
                    created_at_micros: r.created_at_micros,
                    updated_at_micros: now_micros(),
                    is_deleted: r.is_deleted,
                    parent_page_id: parent_page_id.to_string(),
                    slug,
                    order_index,
                }
            }
            None => {
                let now = now_micros();
                let slug = if slug.is_empty() {
                    slugify_title(title)
                } else {
                    slug.to_string()
                };
                WikiPageRecord {
                    page_id: page_id.to_string(),
                    channel_id: channel_id.to_string(),
                    title: title.to_string(),
                    body: body.to_string(),
                    author_user_id,
                    created_at_micros: now,
                    updated_at_micros: now,
                    is_deleted: false,
                    parent_page_id: parent_page_id.to_string(),
                    slug,
                    order_index,
                }
            }
        };
        let payload = encode_record(&record);
        self.run(
            author_user_id,
            "update_wiki_page",
            channel_id.to_string(),
            "wiki_page_edited",
            6,
            payload,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    async fn delete_wiki_page(&self, channel_id: &str, page_id: &str, actor_user_id: u64) -> Result<()> {
        use wabidb::projections::wiki::{self, encode_record};
        let state = self.engine.projection_state();
        if let Some(mut record) = wiki::WikiProjection::get_page(&state, channel_id, page_id)? {
            record.is_deleted = true;
            record.updated_at_micros = now_micros();
            let payload = encode_record(&record);
            self.run(
                actor_user_id,
                "delete_wiki_page",
                channel_id.to_string(),
                "wiki_page_deleted",
                6,
                payload,
                true,
                None,
            )
            .await?;
        }
        Ok(())
    }

    async fn list_wiki_revisions(&self, channel_id: &str, page_id: &str) -> Result<Vec<wabidb::domain::WikiRevision>> {
        use wabidb::projections::wiki;
        let state = self.engine.projection_state();
        let records = wiki::WikiRevisionProjection::list_revisions(&state, channel_id, page_id)?;
        Ok(records.into_iter().map(wabidb::domain::WikiRevision::from).collect())
    }

    async fn get_wiki_revision(&self, channel_id: &str, page_id: &str, revision_id: &str) -> Result<Option<wabidb::domain::WikiRevision>> {
        use wabidb::projections::wiki;
        let state = self.engine.projection_state();
        match wiki::WikiRevisionProjection::get_revision(&state, channel_id, page_id, revision_id)? {
            Some(r) => Ok(Some(wabidb::domain::WikiRevision::from(r))),
            None => Ok(None),
        }
    }

    // ================================================================
    // Forum
    // ================================================================

    async fn get_forum_post(&self, channel_id: &str, thread_id: &str, post_id: &str) -> Result<Option<wabidb::domain::ForumPost>> {
        use wabidb::projections::forum;
        let state = self.engine.projection_state();
        match forum::ForumProjection::get_post(&state, channel_id, thread_id, post_id)? {
            Some(r) => Ok(Some(wabidb::domain::ForumPost::from(r))),
            None => Ok(None),
        }
    }

    async fn list_forum_threads(&self, channel_id: &str) -> Result<Vec<wabidb::domain::ForumPost>> {
        use wabidb::projections::forum;
        let state = self.engine.projection_state();
        let records = forum::ForumProjection::list_threads(&state, channel_id, false)?;
        Ok(records.into_iter().map(wabidb::domain::ForumPost::from).collect())
    }

    async fn list_forum_posts(&self, channel_id: &str, thread_id: &str) -> Result<Vec<wabidb::domain::ForumPost>> {
        use wabidb::projections::forum;
        let state = self.engine.projection_state();
        let records = forum::ForumProjection::list_posts(&state, channel_id, thread_id, false)?;
        Ok(records.into_iter().map(wabidb::domain::ForumPost::from).collect())
    }

    async fn create_forum_thread(
        &self,
        channel_id: &str,
        body: &str,
        author_user_id: u64,
        title: Option<&str>,
        tags: Option<&[String]>,
        category: Option<&str>,
    ) -> Result<String> {
        use wabidb::projections::forum::{encode_record, ForumPostRecord};
        let now = now_micros();
        let record = ForumPostRecord {
            post_id: String::new(),
            thread_id: String::new(),
            channel_id: channel_id.to_string(),
            author_user_id,
            body: body.to_string(),
            created_at_micros: now,
            edited_at_micros: None,
            is_deleted: false,
            is_thread_starter: true,
            title: title.unwrap_or("").to_string(),
            tags: tags.map(|t| t.to_vec()).unwrap_or_default(),
            votes_up: 0,
            votes_down: 0,
            is_solution: false,
            category: category.map(|c| c.to_string()),
        };
        let payload = encode_record(&record);
        let seq = self
            .run(
                author_user_id,
                "create_forum_thread",
                channel_id.to_string(),
                "forum_thread_created",
                6,
                payload,
                true,
                None,
            )
            .await?;
        Ok(format!("post_{:x}", seq))
    }

    async fn create_forum_post(
        &self,
        channel_id: &str,
        thread_id: &str,
        body: &str,
        author_user_id: u64,
        tags: Option<&[String]>,
    ) -> Result<String> {
        use wabidb::projections::forum::{encode_record, ForumPostRecord};
        let now = now_micros();
        let record = ForumPostRecord {
            post_id: String::new(),
            thread_id: thread_id.to_string(),
            channel_id: channel_id.to_string(),
            author_user_id,
            body: body.to_string(),
            created_at_micros: now,
            edited_at_micros: None,
            is_deleted: false,
            is_thread_starter: false,
            title: String::new(),
            tags: tags.map(|t| t.to_vec()).unwrap_or_default(),
            votes_up: 0,
            votes_down: 0,
            is_solution: false,
            category: None,
        };
        let payload = encode_record(&record);
        let seq = self
            .run(
                author_user_id,
                "create_forum_post",
                channel_id.to_string(),
                "forum_post_created",
                6,
                payload,
                true,
                None,
            )
            .await?;
        Ok(format!("post_{:x}", seq))
    }

    async fn update_forum_post(
        &self,
        channel_id: &str,
        thread_id: &str,
        post_id: &str,
        body: &str,
        author_user_id: u64,
        title: Option<&str>,
        tags: Option<&[String]>,
        category: Option<&str>,
    ) -> Result<()> {
        use wabidb::projections::forum::{self, encode_record, ForumPostRecord};
        let state = self.engine.projection_state();
        let existing = forum::ForumProjection::get_post(&state, channel_id, thread_id, post_id)?;
        let record = match existing {
            Some(r) => ForumPostRecord {
                body: body.to_string(),
                edited_at_micros: Some(now_micros()),
                title: title.unwrap_or("").to_string(),
                tags: tags.map(|t| t.to_vec()).unwrap_or_default(),
                category: category.map(|c| c.to_string()),
                ..r
            },
            None => {
                let now = now_micros();
                ForumPostRecord {
                    post_id: post_id.to_string(),
                    thread_id: thread_id.to_string(),
                    channel_id: channel_id.to_string(),
                    author_user_id,
                    body: body.to_string(),
                    created_at_micros: now,
                    edited_at_micros: Some(now),
                    is_deleted: false,
                    is_thread_starter: false,
                    title: title.unwrap_or("").to_string(),
                    tags: tags.map(|t| t.to_vec()).unwrap_or_default(),
                    votes_up: 0,
                    votes_down: 0,
                    is_solution: false,
                    category: category.map(|c| c.to_string()),
                }
            }
        };
        let payload = encode_record(&record);
        self.run(
            author_user_id,
            "update_forum_post",
            channel_id.to_string(),
            "forum_post_edited",
            6,
            payload,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    async fn delete_forum_post(&self, channel_id: &str, thread_id: &str, post_id: &str, actor_user_id: u64) -> Result<()> {
        use wabidb::projections::forum::{self, encode_record};
        let state = self.engine.projection_state();
        if let Some(mut record) = forum::ForumProjection::get_post(&state, channel_id, thread_id, post_id)? {
            record.is_deleted = true;
            record.edited_at_micros = Some(now_micros());
            let payload = encode_record(&record);
            self.run(
                actor_user_id,
                "delete_forum_post",
                channel_id.to_string(),
                "forum_post_deleted",
                6,
                payload,
                true,
                None,
            )
            .await?;
        }
        Ok(())
    }

    async fn vote_forum_post(&self, channel_id: &str, thread_id: &str, post_id: &str, direction: &str, actor_user_id: u64) -> Result<()> {
        use postcard::to_allocvec;
        #[derive(serde::Serialize)]
        struct VotePayload {
            post_id: String,
            thread_id: String,
            channel_id: String,
            direction: String,
            actor_user_id: u64,
        }
        let payload = to_allocvec(&VotePayload {
            post_id: post_id.to_string(),
            thread_id: thread_id.to_string(),
            channel_id: channel_id.to_string(),
            direction: direction.to_string(),
            actor_user_id,
        })
        .map_err(|e| wabidb::error::WabiError::Corrupt {
            location: "vote_forum_post".into(),
            detail: format!("postcard encode failed: {e}"),
        })?;
        self.run(
            actor_user_id,
            "vote_forum_post",
            channel_id.to_string(),
            "forum_post_voted",
            6,
            payload,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    async fn mark_forum_solution(&self, channel_id: &str, thread_id: &str, post_id: &str, actor_user_id: u64) -> Result<()> {
        use postcard::to_allocvec;
        #[derive(serde::Serialize)]
        struct SolutionPayload {
            post_id: String,
            thread_id: String,
            channel_id: String,
            actor_user_id: u64,
        }
        let payload = to_allocvec(&SolutionPayload {
            post_id: post_id.to_string(),
            thread_id: thread_id.to_string(),
            channel_id: channel_id.to_string(),
            actor_user_id,
        })
        .map_err(|e| wabidb::error::WabiError::Corrupt {
            location: "mark_forum_solution".into(),
            detail: format!("postcard encode failed: {e}"),
        })?;
        self.run(
            actor_user_id,
            "mark_forum_solution",
            channel_id.to_string(),
            "forum_post_solution_set",
            6,
            payload,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    async fn update_forum_thread_meta(
        &self,
        channel_id: &str,
        thread_id: &str,
        title: &str,
        tags: &[String],
        category: Option<&str>,
        actor_user_id: u64,
    ) -> Result<()> {
        use wabidb::projections::forum::{self, encode_record};
        let state = self.engine.projection_state();
        if let Some(mut record) = forum::ForumProjection::get_post(&state, channel_id, thread_id, thread_id)? {
            record.title = title.to_string();
            record.tags = tags.to_vec();
            record.category = category.map(|c| c.to_string());
            record.edited_at_micros = Some(now_micros());
            let payload = encode_record(&record);
            self.run(
                actor_user_id,
                "update_forum_thread_meta",
                channel_id.to_string(),
                "forum_thread_meta_updated",
                6,
                payload,
                true,
                None,
            )
            .await?;
        }
        Ok(())
    }

    // ================================================================
    // Incidents
    // ================================================================

    async fn get_incident(&self, channel_id: &str, incident_id: &str) -> Result<Option<wabidb::domain::Incident>> {
        use wabidb::projections::incidents;
        let state = self.engine.projection_state();
        match incidents::IncidentProjection::get_incident(&state, channel_id, incident_id)? {
            Some(r) => Ok(Some(wabidb::domain::Incident::from(r))),
            None => Ok(None),
        }
    }

    async fn list_incidents(&self, channel_id: &str) -> Result<Vec<wabidb::domain::Incident>> {
        use wabidb::projections::incidents;
        let state = self.engine.projection_state();
        let records = incidents::IncidentProjection::list_incidents(&state, channel_id, false)?;
        Ok(records.into_iter().map(wabidb::domain::Incident::from).collect())
    }

    async fn create_incident(&self, channel_id: &str, title: &str, description: &str, severity: &str, reporter_user_id: u64) -> Result<String> {
        use wabidb::projections::incidents::{encode_record, IncidentRecord};
        let now = now_micros();
        let record = IncidentRecord {
            incident_id: String::new(),
            channel_id: channel_id.to_string(),
            title: title.to_string(),
            description: description.to_string(),
            severity: severity.to_string(),
            status: "open".to_string(),
            reporter_user_id,
            assigned_user_id: None,
            created_at_micros: now,
            updated_at_micros: now,
            resolved_at_micros: None,
            is_deleted: false,
        };
        let payload = encode_record(&record);
        let seq = self
            .run(
                reporter_user_id,
                "create_incident",
                channel_id.to_string(),
                "incident_created",
                6,
                payload,
                true,
                None,
            )
            .await?;
        Ok(format!("inc_{:x}", seq))
    }

    async fn update_incident(
        &self,
        channel_id: &str,
        incident_id: &str,
        title: &str,
        description: &str,
        severity: &str,
        status: &str,
        assigned_user_id: Option<u64>,
        _actor_user_id: u64,
    ) -> Result<()> {
        use wabidb::projections::incidents::{self, encode_record, IncidentRecord};
        let state = self.engine.projection_state();
        let existing = incidents::IncidentProjection::get_incident(&state, channel_id, incident_id)?;
        let now = now_micros();
        let record = match existing {
            Some(r) => IncidentRecord {
                title: title.to_string(),
                description: description.to_string(),
                severity: severity.to_string(),
                status: status.to_string(),
                assigned_user_id,
                updated_at_micros: now,
                ..r
            },
            None => IncidentRecord {
                incident_id: incident_id.to_string(),
                channel_id: channel_id.to_string(),
                title: title.to_string(),
                description: description.to_string(),
                severity: severity.to_string(),
                status: status.to_string(),
                reporter_user_id: 0,
                assigned_user_id,
                created_at_micros: now,
                updated_at_micros: now,
                resolved_at_micros: None,
                is_deleted: false,
            },
        };
        let payload = encode_record(&record);
        self.run(
            0,
            "update_incident",
            channel_id.to_string(),
            "incident_updated",
            6,
            payload,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    async fn resolve_incident(&self, channel_id: &str, incident_id: &str, actor_user_id: u64) -> Result<()> {
        use wabidb::projections::incidents::{self, encode_record};
        let state = self.engine.projection_state();
        if let Some(mut record) = incidents::IncidentProjection::get_incident(&state, channel_id, incident_id)? {
            let now = now_micros();
            record.status = "resolved".to_string();
            record.resolved_at_micros = Some(now);
            record.updated_at_micros = now;
            let payload = encode_record(&record);
            self.run(
                actor_user_id,
                "resolve_incident",
                channel_id.to_string(),
                "incident_resolved",
                6,
                payload,
                true,
                None,
            )
            .await?;
        }
        Ok(())
    }

    // ================================================================
    // DM (Direct Messages)
    // ================================================================

    async fn get_dm_message(&self, dm_id: &str, message_id: &str) -> Result<Option<wabidb::domain::DmMessage>> {
        use wabidb::projections::dm_messages;
        let state = self.engine.projection_state();
        match dm_messages::DmMessagesProjection::get_message(&state, dm_id, message_id)? {
            Some(r) => Ok(Some(wabidb::domain::DmMessage::from(r))),
            None => Ok(None),
        }
    }

    async fn list_dm_messages(&self, dm_id: &str) -> Result<Vec<wabidb::domain::DmMessage>> {
        use wabidb::projections::dm_messages;
        let state = self.engine.projection_state();
        let records = dm_messages::DmMessagesProjection::list_messages(&state, dm_id)?;
        Ok(records.into_iter().map(wabidb::domain::DmMessage::from).collect())
    }

    async fn list_dm_recipients(&self, dm_id: &str, message_id: &str) -> Result<Vec<wabidb::domain::DmRecipient>> {
        use wabidb::projections::dm_message_recipients;
        let state = self.engine.projection_state();
        let records = dm_message_recipients::DmMessageRecipientsProjection::list_recipients(&state, dm_id, message_id)?;
        Ok(records.into_iter().map(wabidb::domain::DmRecipient::from).collect())
    }

    async fn send_dm_message(&self, dm_id: &str, author_user_id: u64, content: &str) -> Result<String> {
        use wabidb::projections::dm_messages::{encode_record, DmMessageRecord};
        use wabidb::projections::dm_message_recipients::encode_record as encode_recipient;
        let now = now_micros();
        let record = DmMessageRecord {
            dm_id: dm_id.to_string(),
            message_id: String::new(),
            author_user_id,
            author_device_id: "primary".into(),
            created_at_micros: now,
            encrypted_body_ref: content.to_string(),
            idempotency_key: None,
            edit_history: vec![],
        };
        let payload = encode_record(&record);
        let seq = self
            .run(
                author_user_id,
                "send_dm_message",
                dm_id.to_string(),
                "dm_message_created",
                2,
                payload,
                true,
                None,
            )
            .await?;
        Ok(format!("dm_msg_{:x}", seq))
    }

    async fn lore_create_repo(&self, channel_id: i64, repo_name: &str, lore_server_url: &str, created_by: i64) -> Result<()> {
        use wabidb::projections::lore::{encode_repo_record, LoreRepoRecord};
        let now = now_micros();
        let record = LoreRepoRecord {
            channel_id,
            repo_name: repo_name.to_string(),
            lore_server_url: lore_server_url.to_string(),
            created_by,
            created_at_micros: now,
        };
        let payload = encode_repo_record(&record);
        self.run(
            created_by as u64,
            "lore_create_repo",
            channel_id.to_string(),
            "lore_repo_registered",
            6,
            payload,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    async fn lore_delete_repo(&self, channel_id: i64, deleted_by: i64) -> Result<()> {
        let payload = channel_id.to_le_bytes().to_vec();
        self.run(
            deleted_by as u64,
            "lore_delete_repo",
            channel_id.to_string(),
            "lore_repo_deleted",
            6,
            payload,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    async fn lore_get_repo(&self, channel_id: i64) -> Result<Option<LoreRepoRecord>> {
        use wabidb::projections::lore::LoreRepoProjection;
        let state = self.engine.projection_state();
        LoreRepoProjection::get_repo(&state, channel_id)
    }

    async fn list_lore_repos(&self) -> Result<Vec<LoreRepoRecord>> {
        use wabidb::projections::lore::LoreRepoProjection;
        let state = self.engine.projection_state();
        LoreRepoProjection::list_repos(&state)
    }

    async fn lore_commit(&self, channel_id: i64, commit_hash: &str, repo_name: &str, file_path: &str, message: &str, author_user_id: i64) -> Result<()> {
        use wabidb::projections::lore::{encode_record, LoreCommitRecord};
        let now = now_micros();
        let record = LoreCommitRecord {
            commit_hash: commit_hash.to_string(),
            channel_id,
            repo_name: repo_name.to_string(),
            file_path: file_path.to_string(),
            message: message.to_string(),
            author_user_id,
            timestamp_micros: now,
        };
        let payload = encode_record(&record);
        self.run(
            author_user_id as u64,
            "lore_commit",
            channel_id.to_string(),
            "lore_commit",
            6,
            payload,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    // ================================================================
    // Gallery
    // ================================================================

    async fn list_gallery_works(&self, channel_id: &str) -> Result<Vec<wabidb::domain::GalleryWork>> {
        use wabidb::projections::gallery;
        let state = self.engine.projection_state();
        let records = gallery::GalleryWorkProjection::list_works(&state, channel_id, false)?;
        Ok(records.into_iter().map(wabidb::domain::GalleryWork::from).collect())
    }

    async fn get_gallery_work(&self, channel_id: &str, work_id: &str) -> Result<Option<wabidb::domain::GalleryWork>> {
        use wabidb::projections::gallery;
        let state = self.engine.projection_state();
        match gallery::GalleryWorkProjection::get_work(&state, channel_id, work_id)? {
            Some(r) => Ok(Some(wabidb::domain::GalleryWork::from(r))),
            None => Ok(None),
        }
    }

    async fn upload_gallery_work(
        &self,
        channel_id: &str,
        title: &str,
        caption: &str,
        attachment_url: &str,
        mime_type: &str,
        category: &str,
        is_wip: bool,
        author_user_id: u64,
    ) -> Result<String> {
        use wabidb::projections::gallery::{encode_record, GalleryWorkRecord};
        let now = now_micros();
        let record = GalleryWorkRecord {
            work_id: String::new(),
            channel_id: channel_id.to_string(),
            author_user_id,
            title: title.to_string(),
            caption: caption.to_string(),
            attachment_url: attachment_url.to_string(),
            mime_type: mime_type.to_string(),
            category: category.to_string(),
            is_wip,
            created_at_micros: now,
            updated_at_micros: now,
            is_deleted: false,
        };
        let payload = encode_record(&record);
        let seq = self
            .run(
                author_user_id,
                "upload_gallery_work",
                channel_id.to_string(),
                "gallery_work_uploaded",
                6,
                payload,
                true,
                None,
            )
            .await?;
        Ok(format!("work_{:x}", seq))
    }

    async fn edit_gallery_work(
        &self,
        channel_id: &str,
        work_id: &str,
        title: &str,
        caption: &str,
        category: &str,
        is_wip: bool,
        actor_user_id: u64,
    ) -> Result<()> {
        use wabidb::projections::gallery::{self, encode_record, GalleryWorkRecord};
        let state = self.engine.projection_state();
        let existing = gallery::GalleryWorkProjection::get_work(&state, channel_id, work_id)?;
        let record = match existing {
            Some(r) => GalleryWorkRecord {
                title: title.to_string(),
                caption: caption.to_string(),
                category: category.to_string(),
                is_wip,
                updated_at_micros: now_micros(),
                ..r
            },
            None => {
                let now = now_micros();
                GalleryWorkRecord {
                    work_id: work_id.to_string(),
                    channel_id: channel_id.to_string(),
                    author_user_id: actor_user_id,
                    title: title.to_string(),
                    caption: caption.to_string(),
                    attachment_url: String::new(),
                    mime_type: String::new(),
                    category: category.to_string(),
                    is_wip,
                    created_at_micros: now,
                    updated_at_micros: now,
                    is_deleted: false,
                }
            }
        };
        let payload = encode_record(&record);
        self.run(
            actor_user_id,
            "edit_gallery_work",
            channel_id.to_string(),
            "gallery_work_edited",
            6,
            payload,
            true,
            None,
        )
        .await?;
        Ok(())
    }

    async fn delete_gallery_work(&self, channel_id: &str, work_id: &str, actor_user_id: u64) -> Result<()> {
        use wabidb::projections::gallery::{self, encode_record};
        let state = self.engine.projection_state();
        if let Some(mut record) = gallery::GalleryWorkProjection::get_work(&state, channel_id, work_id)? {
            record.is_deleted = true;
            record.updated_at_micros = now_micros();
            let payload = encode_record(&record);
            self.run(
                actor_user_id,
                "delete_gallery_work",
                channel_id.to_string(),
                "gallery_work_deleted",
                6,
                payload,
                true,
                None,
            )
            .await?;
        }
        Ok(())
    }

    async fn list_gallery_feedback(&self, channel_id: &str, work_id: &str) -> Result<Vec<wabidb::domain::GalleryFeedback>> {
        use wabidb::projections::gallery;
        let state = self.engine.projection_state();
        let records = gallery::GalleryFeedbackProjection::list_feedback_for_work(&state, channel_id, work_id, false)?;
        Ok(records.into_iter().map(wabidb::domain::GalleryFeedback::from).collect())
    }

    async fn add_gallery_feedback(
        &self,
        channel_id: &str,
        work_id: &str,
        comment: &str,
        x_percent: f32,
        y_percent: f32,
        author_user_id: u64,
    ) -> Result<String> {
        use wabidb::projections::gallery::{encode_feedback_record, GalleryFeedbackRecord};
        let now = now_micros();
        let record = GalleryFeedbackRecord {
            feedback_id: String::new(),
            work_id: work_id.to_string(),
            channel_id: channel_id.to_string(),
            author_user_id,
            comment: comment.to_string(),
            x_percent,
            y_percent,
            created_at_micros: now,
            is_deleted: false,
        };
        let payload = encode_feedback_record(&record);
        let seq = self
            .run(
                author_user_id,
                "add_gallery_feedback",
                channel_id.to_string(),
                "gallery_feedback_added",
                6,
                payload,
                false,
                None,
            )
            .await?;
        Ok(format!("feedback_{:x}", seq))
    }

    async fn delete_gallery_feedback(&self, channel_id: &str, work_id: &str, feedback_id: &str, actor_user_id: u64) -> Result<()> {
        use wabidb::projections::gallery::{self, encode_feedback_record};
        let state = self.engine.projection_state();
        // We need to fetch the feedback record; list_feedback_for_work then filter by feedback_id.
        let all = gallery::GalleryFeedbackProjection::list_feedback_for_work(&state, channel_id, work_id, true)?;
        if let Some(mut record) = all.into_iter().find(|r| r.feedback_id == feedback_id) {
            record.is_deleted = true;
            let payload = encode_feedback_record(&record);
            self.run(
                actor_user_id,
                "delete_gallery_feedback",
                channel_id.to_string(),
                "gallery_feedback_deleted",
                6,
                payload,
                true,
                None,
            )
            .await?;
        }
        Ok(())
    }
}

impl WdbAdapter {
    /// Dump every message record in the `messages` projection, regardless of
    /// channel id. Used by maintenance diagnostics to detect channel-id
    /// mismatches that hide messages from `list_messages_typed`.
    pub async fn list_all_messages_typed(&self) -> anyhow::Result<Vec<Message>> {
        use wabidb::projections::messages::MessagesProjection;
        use wabidb::projections::query::MessagesFilter;
        let state = self.engine.projection_state();
        let out: Vec<Message> = MessagesProjection
            .query(&state, &MessagesFilter { include_deleted: true, ..Default::default() })?
            .into_iter()
            .map(Message::from)
            .collect();
        Ok(out)
    }
}
