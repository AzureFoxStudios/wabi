use crate::domain::UserDeleted;
use crate::engine::locks::ProjectionState;
use crate::error::Result;
use crate::format::versioned::{self, RecordFormat};
use crate::projections::handler::{DurableEvent, Projection};
use crate::projections::users::decode_record as decode_user;

/// Hard-delete tombstone for guest accounts.
///
/// WabiDB dispatches each event type to exactly ONE handler (duplicate
/// registration is a startup error), so this projection owns `user_deleted`
/// and cascades the removal across every index that keys rows by user:
///
/// - `users` — the account row itself.
/// - `channel_members` — memberships in every channel, in the SQLite read
///   model (scan + targeted remove; the key is `[len][channel_id][user_id LE]`
///   so it cannot be prefix-scanned by user). Startup replay skips this part
///   for commits the read model already holds, and a rebuild of the read
///   model applies only this part ([`Projection::apply_to_read_model`]).
/// - `dm_identities` — all per-device identity/prekey bundles (keyed
///   `[user_id BE][len][device_id]`, so a BE-user prefix scan finds them).
///
/// Messages authored by the deleted user are intentionally kept: the
/// frontend renders them via its guest fallback when the author row is
/// missing.
pub struct UserDeletionProjection;

impl Projection for UserDeletionProjection {
    fn event_type(&self) -> &str {
        "user_deleted"
    }

    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let user_id = decode_payload(&event.payload)?.user_id;

        // 1. The account row and 2. channel memberships across all
        // channels. Both live in the read model; during startup replay it may
        // already hold this commit.
        if event.commit_seq > state.read_model().replay_floor() {
            crate::projections::users::remove_while_applying(state, user_id)?;
            crate::projections::channel_members::remove_user_while_applying(state, user_id)?;
        }

        state.remove(crate::projections::game_profiles::INDEX, &user_id.to_be_bytes());

        // 3. DM identities: every device bundle under the BE user prefix.
        let prefix = user_id.to_be_bytes().to_vec();
        let mut identity_keys: Vec<Vec<u8>> = Vec::new();
        state.prefix_scan("dm_identities", &prefix, |key, _value| {
            identity_keys.push(key.to_vec());
        });
        for key in &identity_keys {
            state.remove("dm_identities", key);
        }

        Ok(())
    }

    /// A rebuild of the read model over a commit the snapshot covers: only
    /// the account row and the memberships, which live there. The game
    /// profile and the identities are in memory and already reflect the
    /// commit.
    fn apply_to_read_model(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        let user_id = decode_payload(&event.payload)?.user_id;
        crate::projections::users::remove_while_applying(state, user_id)?;
        crate::projections::channel_members::remove_user_while_applying(state, user_id)
    }
}

/// Versioned durable layout of the `user_deleted` payload; see
/// `format::versioned`. The first field is a `u64`, so legacy bytes never
/// start with the marker.
const FORMAT: RecordFormat = RecordFormat::new(*b"UDEL", "user_deletion projection");

/// Encode a `user_deleted` event payload. The adapter writes it with this.
pub fn encode_payload(payload: &UserDeleted) -> Vec<u8> {
    versioned::encode_v1(&FORMAT, payload)
}

/// Decode a `user_deleted` event payload, versioned or raw postcard.
pub fn decode_payload(buf: &[u8]) -> Result<UserDeleted> {
    versioned::decode_v1(&FORMAT, buf)
}

/// Re-exported so callers (tests, server sweep code) can verify a deletion
/// took effect without reaching into projection internals. As of the last
/// committed commit; a row that cannot be read counts as absent.
pub fn user_exists(state: &ProjectionState, user_id: u64) -> bool {
    crate::projections::users::stored_record(state, user_id)
        .ok()
        .flatten()
        .and_then(|bytes| decode_user(&bytes).ok())
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::projections::channel_members::{
        encode_key as encode_member_key, encode_record as encode_member,
        insert_raw_for_tests as insert_member, ChannelMemberRecord,
        ChannelMembersProjection as Members,
    };
    use crate::projections::dm_identities::{
        encode_key as encode_identity_key, encode_record as encode_identity,
        DmIdentityRecord,
    };
    use crate::projections::users::{encode_record as encode_user, UserRecord};

    fn deletion_event(user_id: u64) -> DurableEvent {
        DurableEvent {
            commit_seq: 100,
            stream_id: "users".into(),
            event_type: "user_deleted".into(),
            payload: encode_payload(&UserDeleted { user_id }),
        }
    }

    fn seed_user(state: &ProjectionState, user_id: u64, username: &str) {
        let now = 1_000_000i64;
        let record = UserRecord {
            user_id,
            username: username.into(),
            handle: None,
            color: "#98D8C8".into(),
            password_hash: String::new(), // guest marker
            is_registered: false,
            is_active: true,
            created_at_micros: now,
            last_seen_micros: now,
            profile_picture: None,
            username_font: None,
            bio: None,
            status_message: None,
        };
        crate::projections::users::insert_raw_for_tests(state, user_id, &encode_user(&record));
    }

    #[test]
    fn deletes_user_row() {
        let state = ProjectionState::new();
        seed_user(&state, 42, "Guest_abc");
        assert!(user_exists(&state, 42));

        UserDeletionProjection
            .apply(&deletion_event(42), &state)
            .unwrap();

        assert!(!user_exists(&state, 42));
    }

    #[test]
    fn keeps_other_users() {
        let state = ProjectionState::new();
        seed_user(&state, 42, "Guest_abc");
        seed_user(&state, 43, "ronin");

        UserDeletionProjection
            .apply(&deletion_event(42), &state)
            .unwrap();

        assert!(!user_exists(&state, 42));
        assert!(user_exists(&state, 43));
    }

    #[test]
    fn cascades_channel_memberships_across_channels() {
        let state = ProjectionState::new();
        seed_user(&state, 42, "Guest_abc");
        for channel in ["ch_a", "ch_b"] {
            let r = ChannelMemberRecord {
                channel_id: channel.into(),
                user_id: 42,
                joined_at_micros: 1_000_000,
                role: 0,
                nick: None,
            };
            insert_member(&state, &encode_member_key(channel, 42), &encode_member(&r));
        }
        // An unrelated member must survive.
        let keep = ChannelMemberRecord {
            channel_id: "ch_a".into(),
            user_id: 7,
            joined_at_micros: 1_000_000,
            role: 0,
            nick: None,
        };
        insert_member(&state, &encode_member_key("ch_a", 7), &encode_member(&keep));

        UserDeletionProjection
            .apply(&deletion_event(42), &state)
            .unwrap();

        assert!(Members::get_member(&state, "ch_a", 42).unwrap().is_none());
        assert!(Members::get_member(&state, "ch_b", 42).unwrap().is_none());
        assert!(Members::get_member(&state, "ch_a", 7).unwrap().is_some());
    }

    /// A rebuild of the read model over a commit the snapshot covers removes
    /// the account row and the memberships, which live in the read model, and
    /// leaves the in-memory rows alone: the snapshot already reflects the
    /// commit.
    #[test]
    fn a_read_model_rebuild_applies_only_the_read_model_cascade() {
        let state = ProjectionState::new();
        seed_user(&state, 42, "Guest_abc");
        let profile = serde_json::to_vec(&crate::projections::game_profiles::GameProfileRecord::empty(42)).unwrap();
        state.insert(crate::projections::game_profiles::INDEX, 42u64.to_be_bytes().to_vec(), profile, 1);
        let r = ChannelMemberRecord {
            channel_id: "ch_a".into(),
            user_id: 42,
            joined_at_micros: 1_000_000,
            role: 0,
            nick: None,
        };
        insert_member(&state, &encode_member_key("ch_a", 42), &encode_member(&r));

        UserDeletionProjection
            .apply_to_read_model(&deletion_event(42), &state)
            .unwrap();

        assert!(Members::get_member(&state, "ch_a", 42).unwrap().is_none());
        assert!(!user_exists(&state, 42), "the account row is in the read model");
        assert!(
            state.get(crate::projections::game_profiles::INDEX, &42u64.to_be_bytes()).is_some(),
            "the in-memory game profile was touched"
        );
    }

    #[test]
    fn cascades_dm_identities_for_all_devices() {
        let state = ProjectionState::new();
        seed_user(&state, 42, "Guest_abc");
        for device in ["dev_a", "dev_b"] {
            let r = DmIdentityRecord {
                user_id: 42,
                device_id: device.into(),
                identity_key: format!("idkey_{device}"),
                signed_pre_key: format!("spk_{device}"),
                signed_pre_key_signature: format!("sig_{device}"),
                one_time_prekeys: vec![],
                created_at_micros: 1_000_000,
                last_seen_micros: 1_000_000,
            };
            state.insert(
                "dm_identities",
                encode_identity_key(42, device),
                encode_identity(&r),
                5,
            );
        }
        // Another user's identity must survive.
        let keep = DmIdentityRecord {
            user_id: 9,
            device_id: "dev_a".into(),
            identity_key: "idkey_9".into(),
            signed_pre_key: "spk_9".into(),
            signed_pre_key_signature: "sig_9".into(),
            one_time_prekeys: vec![],
            created_at_micros: 1_000_000,
            last_seen_micros: 1_000_000,
        };
        state.insert(
            "dm_identities",
            encode_identity_key(9, "dev_a"),
            encode_identity(&keep),
            6,
        );

        UserDeletionProjection
            .apply(&deletion_event(42), &state)
            .unwrap();

        assert!(state.get("dm_identities", &encode_identity_key(42, "dev_a")).is_none());
        assert!(state.get("dm_identities", &encode_identity_key(42, "dev_b")).is_none());
        assert!(state.get("dm_identities", &encode_identity_key(9, "dev_a")).is_some());
    }

    #[test]
    fn deleting_unknown_user_is_a_noop() {
        let state = ProjectionState::new();
        UserDeletionProjection
            .apply(&deletion_event(12345), &state)
            .unwrap();
        assert!(!user_exists(&state, 12345));
    }

    #[test]
    fn corrupt_payload_is_an_error_not_a_panic() {
        let state = ProjectionState::new();
        // Empty payload cannot decode as UserDeleted (varint needs >= 1 byte).
        let event = DurableEvent {
            commit_seq: 1,
            stream_id: "users".into(),
            event_type: "user_deleted".into(),
            payload: Vec::new(),
        };
        assert!(UserDeletionProjection.apply(&event, &state).is_err());
    }
}
