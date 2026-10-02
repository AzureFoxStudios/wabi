//! Ordered account/session denial state. New commands validate the whole
//! bounded delta before encryption; replay applies the same transition rules.
use crate::{
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    format::record::RecordKind,
    projections::handler::{DurableEvent, Projection},
    sequencer::types::EventToWrite,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const EVENT: &str = "auth_revocations_updated_v1";
pub const INDEX: &str = "auth_revocations_v1";
pub const STREAM: &str = "auth-revocations:v1";
pub const READY: &[u8] = b"ready";
pub const MAX_OPERATIONS: usize = 512;
const MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Delta {
    pub schema_version: u8,
    pub migration: bool,
    pub operations: Vec<Operation>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    GlobalFloor {
        epoch: u64,
    },
    UserFloor {
        user_id: i64,
        floor: u64,
        exempt_jtis: Vec<String>,
        clear_legacy: bool,
    },
    Token {
        jti: String,
        expires_at: u64,
    },
    LegacyUser {
        user_id: i64,
    },
    ClearLegacyUser {
        user_id: i64,
    },
    PruneToken {
        jti: String,
        expires_at: u64,
        cutoff: u64,
    },
    Initialize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Value {
    Global {
        epoch: u64,
    },
    User {
        user_id: i64,
        floor: u64,
        exempt_jtis: Vec<String>,
    },
    Token {
        jti: String,
        expires_at: u64,
    },
    LegacyUser {
        user_id: i64,
    },
    Initialized,
}

impl Value {
    pub fn key(&self) -> Vec<u8> {
        match self {
            Self::Global { .. } => b"global".to_vec(),
            Self::User { user_id, .. } => format!("user:{user_id}").into_bytes(),
            Self::Token { jti, .. } => token_key(jti),
            Self::LegacyUser { user_id } => legacy_key(*user_id),
            Self::Initialized => READY.to_vec(),
        }
    }
}

fn token_key(jti: &str) -> Vec<u8> {
    format!("token:{jti}").into_bytes()
}
fn legacy_key(user: i64) -> Vec<u8> {
    format!("legacy:{user}").into_bytes()
}
fn bad(reason: &str) -> WabiError {
    WabiError::Validation {
        command: "auth_revocations".into(),
        reason: reason.into(),
    }
}
fn valid_jti(jti: &str) -> bool {
    !jti.is_empty() && jti.len() <= 4096 && !jti.chars().any(char::is_control)
}
fn valid_exemptions(jtis: &[String]) -> bool {
    jtis.len() <= 64
        && jtis.iter().all(|s| valid_jti(s))
        && jtis.windows(2).all(|pair| pair[0] < pair[1])
}

pub fn decode_value(key: &[u8], bytes: &[u8]) -> Result<Value> {
    if bytes.len() > 300 * 1024 {
        return Err(bad("oversized revocation index value"));
    }
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| bad("invalid revocation index value"))?;
    let valid = match &value {
        Value::Token { jti, .. } => valid_jti(jti),
        Value::User { exempt_jtis, .. } => valid_exemptions(exempt_jtis),
        _ => true,
    };
    if !valid || value.key() != key {
        return Err(bad("revocation value does not match its key"));
    }
    Ok(value)
}

pub fn decode(bytes: &[u8]) -> Result<Delta> {
    if bytes.len() > MAX_BYTES {
        return Err(bad("oversized revocation delta"));
    }
    let delta: Delta =
        serde_json::from_slice(bytes).map_err(|_| bad("invalid revocation delta"))?;
    if delta.schema_version != 1
        || delta.operations.is_empty()
        || delta.operations.len() > MAX_OPERATIONS
    {
        return Err(bad("invalid revocation schema or operation count"));
    }
    Ok(delta)
}

type Changes = BTreeMap<Vec<u8>, Option<Value>>;
fn current(state: &ProjectionState, changes: &Changes, key: &[u8]) -> Result<Option<Value>> {
    if let Some(value) = changes.get(key) {
        return Ok(value.clone());
    }
    state
        .get(INDEX, key)
        .map(|bytes| decode_value(key, &bytes))
        .transpose()
}
fn put(changes: &mut Changes, value: Value) {
    changes.insert(value.key(), Some(value));
}

fn plan(delta: &Delta, state: &ProjectionState, now: Option<u64>) -> Result<Changes> {
    let mut changes = Changes::new();
    let initialized = state
        .get(INDEX, READY)
        .map(|b| decode_value(READY, &b))
        .transpose()?
        .is_some();
    if delta.migration == initialized {
        return Err(bad("migration readiness does not match canonical state"));
    }
    for (position, op) in delta.operations.iter().enumerate() {
        match op {
            Operation::GlobalFloor { epoch } => {
                let previous = match current(state, &changes, b"global")? {
                    Some(Value::Global { epoch }) => epoch,
                    None => 0,
                    _ => return Err(bad("invalid global revocation state")),
                };
                if *epoch < previous || (!delta.migration && *epoch == previous) {
                    return Err(bad("global revocation floor must advance"));
                }
                put(&mut changes, Value::Global { epoch: *epoch });
            }
            Operation::UserFloor {
                user_id,
                floor,
                exempt_jtis,
                clear_legacy,
            } => {
                if !valid_exemptions(exempt_jtis) {
                    return Err(bad("invalid revocation exemptions"));
                }
                let value = Value::User {
                    user_id: *user_id,
                    floor: *floor,
                    exempt_jtis: exempt_jtis.clone(),
                };
                if let Some(previous) = current(state, &changes, &value.key())? {
                    match previous {
                        Value::User { floor: old, .. } if *floor > old => {}
                        old if delta.migration && old == value => {}
                        _ => return Err(bad("user revocation floor must advance")),
                    }
                }
                if !delta.migration && *floor == 0 {
                    return Err(bad("invalid user revocation floor"));
                }
                put(&mut changes, value);
                if *clear_legacy {
                    changes.insert(legacy_key(*user_id), None);
                }
            }
            Operation::Token { jti, expires_at } => {
                if !valid_jti(jti) {
                    return Err(bad("invalid revoked token ID"));
                }
                let old = match current(state, &changes, &token_key(jti))? {
                    Some(Value::Token { expires_at, .. }) => expires_at,
                    None => 0,
                    _ => return Err(bad("invalid revoked token state")),
                };
                put(
                    &mut changes,
                    Value::Token {
                        jti: jti.clone(),
                        expires_at: old.max(*expires_at),
                    },
                );
            }
            Operation::LegacyUser { user_id } => {
                if !delta.migration {
                    return Err(bad("legacy user import after initialization"));
                }
                put(&mut changes, Value::LegacyUser { user_id: *user_id });
            }
            Operation::ClearLegacyUser { user_id } => {
                changes.insert(legacy_key(*user_id), None);
            }
            Operation::PruneToken {
                jti,
                expires_at,
                cutoff,
            } => {
                if !valid_jti(jti)
                    || *expires_at > *cutoff
                    || now.is_some_and(|now| *cutoff > now.saturating_sub(3600))
                {
                    return Err(bad("token prune has not passed its retention window"));
                }
                if let Some(Value::Token {
                    expires_at: old, ..
                }) = current(state, &changes, &token_key(jti))?
                {
                    // An updated expiration must not be deleted by a stale prune.
                    if old == *expires_at {
                        changes.insert(token_key(jti), None);
                    }
                }
            }
            Operation::Initialize => {
                if !delta.migration || position + 1 != delta.operations.len() {
                    return Err(bad("initialization must end a migration batch"));
                }
                put(&mut changes, Value::Initialized);
            }
        }
    }
    Ok(changes)
}

/// Shared validation for the compound account-recovery event. Publication of
/// its global floor is owned by that event's handler at the same commit.
pub(crate) fn validate_global_floor(state: &ProjectionState, epoch: u64) -> Result<()> {
    plan(
        &Delta {
            schema_version: 1,
            migration: false,
            operations: vec![Operation::GlobalFloor { epoch }],
        },
        state,
        None,
    )?;
    let mut failure = None;
    state.for_each(INDEX, |key, bytes| match decode_value(key, bytes) {
        Ok(Value::User { floor, .. }) if floor >= epoch => {
            failure = Some(bad("recovery floor must exceed every account floor"));
        }
        Err(error) => failure = Some(error),
        _ => {}
    });
    failure.map_or(Ok(()), Err)
}

pub(crate) fn preflight(events: &[EventToWrite], state: &ProjectionState, now: u64) -> Result<()> {
    let relevant: Vec<_> = events.iter().filter(|e| e.event_type == EVENT).collect();
    if relevant.is_empty() {
        return Ok(());
    }
    if relevant.len() != 1 {
        return Err(bad("one revocation delta is required per command"));
    }
    let event = relevant[0];
    if event.stream_id != STREAM || event.stream_kind != 6 || event.record_kind != RecordKind::Event
    {
        return Err(bad("invalid revocation stream or record kind"));
    }
    let delta = decode(&event.plaintext)?;
    if events.len() != 1 {
        validate_credential_command(events, &delta, state)?;
    }
    plan(&delta, state, Some(now))?;
    Ok(())
}

/// Only the Authority's two existing-format account transactions may join a
/// denial delta. Arbitrary mixed writes, migrations and additional operations
/// remain forbidden. The sequencer isolates these controls and validates all
/// events before writing, then the dispatcher applies the whole commit.
fn validate_credential_command(
    events: &[EventToWrite],
    delta: &Delta,
    state: &ProjectionState,
) -> Result<()> {
    if delta.migration || events.last().map(|event| event.event_type.as_str()) != Some(EVENT) {
        return Err(bad("credential denial must end a non-migration command"));
    }
    let [Operation::UserFloor {
        user_id,
        exempt_jtis,
        clear_legacy,
        ..
    }] = delta.operations.as_slice()
    else {
        return Err(bad(
            "credential command requires one account revocation floor",
        ));
    };
    if *user_id <= 0
        || events[..events.len() - 1]
            .iter()
            .any(|event| event.stream_kind != 6 || event.record_kind != RecordKind::Event)
    {
        return Err(bad("invalid credential stream or record kind"));
    }
    match events[0].event_type.as_str() {
        "user_updated" if events.len() == 2 => {
            let record = super::users::decode_record(&events[0].plaintext)?;
            let current = state
                .get("users", &super::users::encode_key(*user_id as u64))
                .map(|bytes| super::users::decode_record(&bytes))
                .transpose()?
                .ok_or_else(|| bad("credential account no longer exists"))?;
            if events[0].stream_id != format!("user:{user_id}")
                || record.user_id != *user_id as u64
                || !current.is_active
                || current.password_hash.is_empty()
                || record.password_hash.is_empty()
                || !record.username.is_empty()
                || !record.color.is_empty()
                || record.handle != current.handle
                || record.is_active != current.is_active
                || record.is_registered != current.is_registered
                || record.created_at_micros != current.created_at_micros
                || record.last_seen_micros != current.last_seen_micros
                || record.profile_picture.is_some()
                || record.username_font.is_some()
                || record.bio.is_some()
                || record.status_message.is_some()
                || exempt_jtis.len() > 1
                || (*clear_legacy && !exempt_jtis.is_empty())
            {
                return Err(bad("invalid credential-only account update"));
            }
        }
        "owner_claimed" if matches!(events.len(), 2 | 3) => {
            let owner_bytes = state
                .get("server_meta", super::owner::OWNER_KEY)
                .ok_or_else(|| bad("ownership transfer requires a current owner"))?;
            let previous: super::owner::OwnerRecord = serde_json::from_slice(&owner_bytes)
                .map_err(|_| bad("invalid current owner state"))?;
            let target: super::owner::OwnerRecord = serde_json::from_slice(&events[0].plaintext)
                .map_err(|_| bad("invalid ownership transfer"))?;
            let payload: serde_json::Value = serde_json::from_slice(&events[0].plaintext)
                .map_err(|_| bad("invalid ownership transfer"))?;
            if events[0].stream_id != "server_meta"
                || previous.owner_user_id != *user_id as u64
                || target.owner_user_id == 0
                || target.owner_user_id == previous.owner_user_id
                || payload != serde_json::json!({"owner_user_id":target.owner_user_id})
                || !*clear_legacy
                || !exempt_jtis.is_empty()
            {
                return Err(bad("ownership transfer must revoke the current owner"));
            }
            let removes_owner = super::audit::AuditProjection::get_role(
                state,
                "default-workspace",
                previous.owner_user_id,
            )
            .as_deref()
                == Some("Owner");
            if removes_owner != (events.len() == 3) {
                return Err(bad(
                    "ownership transfer must remove only the prior Owner role",
                ));
            }
            if removes_owner {
                let role = &events[1];
                let payload: serde_json::Value = serde_json::from_slice(&role.plaintext)
                    .map_err(|_| bad("invalid transferred owner role removal"))?;
                if role.event_type != "role_removed"
                    || role.stream_id != "rbac:default-workspace"
                    || payload
                        != serde_json::json!({"user_id":previous.owner_user_id,
                        "workspace_id":"default-workspace", "role":"Owner",
                        "assigned_by":previous.owner_user_id})
                {
                    return Err(bad("invalid transferred owner role removal"));
                }
            }
        }
        _ => {
            return Err(bad(
                "revocation delta must be standalone or an account credential command",
            ))
        }
    }
    Ok(())
}

pub struct AuthRevocationsProjection;
impl Projection for AuthRevocationsProjection {
    fn event_type(&self) -> &str {
        EVENT
    }
    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        if event.stream_id != STREAM {
            return Err(bad("invalid revocation replay stream"));
        }
        let changes = plan(&decode(&event.payload)?, state, None)?;
        // Everything was validated before any index mutation, including replay.
        for (key, value) in changes {
            match value {
                Some(value) => state.insert(
                    INDEX,
                    key,
                    serde_json::to_vec(&value).map_err(|_| bad("revocation encoding failed"))?,
                    event.commit_seq,
                ),
                None => {
                    state.remove(INDEX, &key);
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(migration: bool, operations: Vec<Operation>) -> DurableEvent {
        DurableEvent {
            commit_seq: 1,
            stream_id: STREAM.into(),
            event_type: EVENT.into(),
            payload: serde_json::to_vec(&Delta {
                schema_version: 1,
                migration,
                operations,
            })
            .unwrap(),
        }
    }
    fn initialized() -> ProjectionState {
        let state = ProjectionState::new();
        AuthRevocationsProjection
            .apply(&event(true, vec![Operation::Initialize]), &state)
            .unwrap();
        state
    }

    fn user(id: u64, name: &str, password: &str) -> super::super::users::UserRecord {
        super::super::users::UserRecord {
            user_id: id,
            username: name.into(),
            handle: None,
            color: "blue".into(),
            password_hash: password.into(),
            is_registered: true,
            is_active: true,
            created_at_micros: 1,
            last_seen_micros: 2,
            profile_picture: None,
            username_font: None,
            bio: None,
            status_message: None,
        }
    }
    fn write(stream: &str, kind: &str, plaintext: Vec<u8>) -> EventToWrite {
        EventToWrite {
            stream_id: stream.into(),
            event_type: kind.into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext,
        }
    }
    fn test_copy(events: &[EventToWrite]) -> Vec<EventToWrite> {
        events
            .iter()
            .map(|event| EventToWrite {
                stream_id: event.stream_id.clone(),
                event_type: event.event_type.clone(),
                stream_kind: event.stream_kind,
                record_kind: event.record_kind,
                plaintext: event.plaintext.clone(),
            })
            .collect()
    }
    fn password_command(id: u64, hash: &str, floor: u64) -> Vec<EventToWrite> {
        let mut record = user(id, "", hash);
        record.color.clear();
        let delta = command(
            false,
            vec![Operation::UserFloor {
                user_id: id as i64,
                floor,
                exempt_jtis: vec!["own".into()],
                clear_legacy: false,
            }],
        );
        vec![
            write(
                &format!("user:{id}"),
                "user_updated",
                super::super::users::encode_record(&record),
            ),
            delta.events.into_iter().next().unwrap(),
        ]
    }
    fn owner_command(from: u64, to: u64, floor: u64) -> Vec<EventToWrite> {
        let delta = command(
            false,
            vec![Operation::UserFloor {
                user_id: from as i64,
                floor,
                exempt_jtis: vec![],
                clear_legacy: true,
            }],
        );
        vec![
            write(
                "server_meta",
                "owner_claimed",
                serde_json::json!({"owner_user_id":to})
                    .to_string()
                    .into_bytes(),
            ),
            delta.events.into_iter().next().unwrap(),
        ]
    }
    fn remove_owner(id: u64) -> EventToWrite {
        write(
            "rbac:default-workspace",
            "role_removed",
            serde_json::json!({"user_id":id,
            "workspace_id":"default-workspace", "role":"Owner", "assigned_by":id})
            .to_string()
            .into_bytes(),
        )
    }

    #[test]
    fn only_exact_atomic_credential_shapes_admit_and_denials_still_advance() {
        let state = initialized();
        state.insert(
            "users",
            super::super::users::encode_key(8),
            super::super::users::encode_record(&user(8, "old-owner", "old-hash")),
            1,
        );
        state.insert(
            "server_meta",
            super::super::owner::OWNER_KEY.to_vec(),
            serde_json::json!({"owner_user_id":8})
                .to_string()
                .into_bytes(),
            1,
        );
        let password = password_command(8, "new-hash", 100);
        preflight(&password, &state, 10_000).unwrap();
        let transfer = owner_command(8, 9, 101);
        preflight(&transfer, &state, 10_000).unwrap();
        // An otherwise canonical denial cannot smuggle an unrelated write.
        let mut invalid = test_copy(&password);
        invalid.insert(1, write("other", "probe", vec![]));
        assert!(preflight(&invalid, &state, 10_000).is_err());
        let mut invalid = test_copy(&password);
        invalid[0].stream_id = "user:9".into();
        assert!(preflight(&invalid, &state, 10_000).is_err());
        let mut invalid = test_copy(&password);
        let mut patch = super::super::users::decode_record(&invalid[0].plaintext).unwrap();
        patch.username = "renamed-in-credential-command".into();
        invalid[0].plaintext = super::super::users::encode_record(&patch);
        assert!(preflight(&invalid, &state, 10_000).is_err());
        let mut invalid = test_copy(&password);
        invalid.reverse();
        assert!(preflight(&invalid, &state, 10_000).is_err());
        let mut invalid = test_copy(&password);
        let mut delta = decode(&invalid[1].plaintext).unwrap();
        delta.operations.push(Operation::Token {
            jti: "extra".into(),
            expires_at: 100,
        });
        invalid[1].plaintext = serde_json::to_vec(&delta).unwrap();
        assert!(preflight(&invalid, &state, 10_000).is_err());
        let mut invalid = test_copy(&password);
        let mut delta = decode(&invalid[1].plaintext).unwrap();
        delta.migration = true;
        invalid[1].plaintext = serde_json::to_vec(&delta).unwrap();
        assert!(preflight(&invalid, &state, 10_000).is_err());
        assert!(preflight(&owner_command(9, 10, 100), &state, 10_000).is_err());
        assert!(preflight(&owner_command(8, 8, 100), &state, 10_000).is_err());
        let mut invalid = test_copy(&transfer);
        invalid.insert(1, remove_owner(8));
        assert!(preflight(&invalid, &state, 10_000).is_err());
        super::super::audit::AuditProjection.apply(&DurableEvent { commit_seq: 2,
            stream_id: "rbac:default-workspace".into(), event_type: "role_assigned".into(),
            payload: serde_json::json!({"user_id":8,"workspace_id":"default-workspace","role":"Owner"}).to_string().into_bytes() }, &state).unwrap();
        assert!(preflight(&transfer, &state, 10_000).is_err());
        let mut transfer = transfer;
        transfer.insert(1, remove_owner(8));
        preflight(&transfer, &state, 10_000).unwrap();
        let mut invalid = test_copy(&transfer);
        invalid[1] = remove_owner(9);
        assert!(preflight(&invalid, &state, 10_000).is_err());
        AuthRevocationsProjection
            .apply(
                &DurableEvent {
                    commit_seq: 3,
                    stream_id: STREAM.into(),
                    event_type: EVENT.into(),
                    payload: password[1].plaintext.clone(),
                },
                &state,
            )
            .unwrap();
        assert!(preflight(&password, &state, 10_000).is_err());
        preflight(&transfer, &state, 10_000).unwrap();
    }
    fn preflight_event(event: &DurableEvent, state: &ProjectionState, now: u64) -> Result<()> {
        preflight(
            &[EventToWrite {
                stream_id: event.stream_id.clone(),
                event_type: EVENT.into(),
                stream_kind: 6,
                record_kind: RecordKind::Event,
                plaintext: event.payload.clone(),
            }],
            state,
            now,
        )
    }

    #[test]
    fn migration_and_floor_changes_are_ordered_and_monotonic() {
        let state = ProjectionState::new();
        let import = event(
            true,
            vec![
                Operation::GlobalFloor { epoch: 4 },
                Operation::UserFloor {
                    user_id: 8,
                    floor: 9,
                    exempt_jtis: vec!["own".into()],
                    clear_legacy: false,
                },
                Operation::LegacyUser { user_id: 8 },
                Operation::Initialize,
            ],
        );
        AuthRevocationsProjection.apply(&import, &state).unwrap();
        assert!(preflight_event(&import, &state, 10_000).is_err());
        let stale = event(
            false,
            vec![Operation::UserFloor {
                user_id: 8,
                floor: 9,
                exempt_jtis: vec!["different".into()],
                clear_legacy: true,
            }],
        );
        assert!(preflight_event(&stale, &state, 10_000).is_err());
        let next = event(
            false,
            vec![Operation::UserFloor {
                user_id: 8,
                floor: 10,
                exempt_jtis: vec![],
                clear_legacy: true,
            }],
        );
        AuthRevocationsProjection.apply(&next, &state).unwrap();
        assert!(state.get(INDEX, &legacy_key(8)).is_none());
        assert_eq!(
            decode_value(b"user:8", &state.get(INDEX, b"user:8").unwrap()).unwrap(),
            Value::User {
                user_id: 8,
                floor: 10,
                exempt_jtis: vec![]
            }
        );
        assert!(preflight_event(
            &event(false, vec![Operation::GlobalFloor { epoch: 3 }]),
            &state,
            10_000
        )
        .is_err());
    }

    #[test]
    fn a_later_invalid_operation_cannot_partially_mutate_replay_or_local_admission() {
        let state = initialized();
        let delta = event(
            false,
            vec![
                Operation::Token {
                    jti: "must-not-appear".into(),
                    expires_at: 100,
                },
                Operation::UserFloor {
                    user_id: 1,
                    floor: 0,
                    exempt_jtis: vec![],
                    clear_legacy: false,
                },
            ],
        );
        assert!(preflight_event(&delta, &state, 10_000).is_err());
        assert!(AuthRevocationsProjection.apply(&delta, &state).is_err());
        assert!(state.get(INDEX, &token_key("must-not-appear")).is_none());
    }

    #[test]
    fn token_retention_cannot_shorten_or_prune_an_updated_expiration() {
        let state = initialized();
        for expires_at in [10_000, 100] {
            AuthRevocationsProjection
                .apply(
                    &event(
                        false,
                        vec![Operation::Token {
                            jti: "stolen".into(),
                            expires_at,
                        }],
                    ),
                    &state,
                )
                .unwrap();
        }
        let early = event(
            false,
            vec![Operation::PruneToken {
                jti: "stolen".into(),
                expires_at: 10_000,
                cutoff: 10_000,
            }],
        );
        assert!(preflight_event(&early, &state, 13_599).is_err());
        let stale = event(
            false,
            vec![Operation::PruneToken {
                jti: "stolen".into(),
                expires_at: 100,
                cutoff: 10_000,
            }],
        );
        AuthRevocationsProjection.apply(&stale, &state).unwrap();
        assert!(state.get(INDEX, &token_key("stolen")).is_some());
        preflight_event(&early, &state, 13_600).unwrap();
        AuthRevocationsProjection.apply(&early, &state).unwrap();
        assert!(state.get(INDEX, &token_key("stolen")).is_none());
    }

    #[test]
    fn schema_stream_kind_size_and_readiness_are_checked_before_writing() {
        let state = initialized();
        assert!(decode(b"{}").is_err());
        assert!(decode(&vec![b' '; MAX_BYTES + 1]).is_err());
        let over_count = event(
            false,
            vec![
                Operation::Token {
                    jti: "x".into(),
                    expires_at: 100
                };
                MAX_OPERATIONS + 1
            ],
        );
        assert!(decode(&over_count.payload).is_err());
        let valid = event(
            false,
            vec![Operation::Token {
                jti: "valid".into(),
                expires_at: 100,
            }],
        );
        for (stream_kind, record_kind) in [
            (1, RecordKind::Event),
            (6, RecordKind::Snapshot),
            (6, RecordKind::Tombstone),
            (6, RecordKind::Checkpoint),
        ] {
            let record = EventToWrite {
                stream_id: STREAM.into(),
                event_type: EVENT.into(),
                stream_kind,
                record_kind,
                plaintext: valid.payload.clone(),
            };
            assert!(preflight(&[record], &state, 10_000).is_err());
        }
        let mut mixed = command(
            false,
            vec![Operation::Token {
                jti: "valid".into(),
                expires_at: 100,
            }],
        );
        mixed.events.push(EventToWrite {
            stream_id: "other-stream".into(),
            event_type: "probe".into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: vec![],
        });
        assert!(preflight(&mixed.events, &state, 10_000).is_err());
        let mut delta = event(
            false,
            vec![Operation::Token {
                jti: "valid".into(),
                expires_at: 100,
            }],
        );
        delta.stream_id = "unrelated".into();
        assert!(preflight_event(&delta, &state, 10_000).is_err());
        let delta = event(
            false,
            vec![Operation::Token {
                jti: "bad\nID".into(),
                expires_at: 100,
            }],
        );
        assert!(preflight_event(&delta, &state, 10_000).is_err());
        assert!(
            preflight_event(&event(false, vec![Operation::Initialize]), &state, 10_000).is_err()
        );
        assert!(preflight_event(
            &event(
                true,
                vec![Operation::Token {
                    jti: "x".into(),
                    expires_at: 100
                }]
            ),
            &state,
            10_000
        )
        .is_err());
        assert!(preflight_event(
            &event(
                false,
                vec![Operation::Token {
                    jti: "x".into(),
                    expires_at: 100
                }]
            ),
            &ProjectionState::new(),
            10_000
        )
        .is_err());
    }

    fn config(path: &std::path::Path) -> crate::engine::WabiDbConfig {
        let mut config = crate::engine::WabiDbConfig::new(
            path.into(),
            crate::crypto::bootstrap::BootstrapSource::Provided([0xD2; 32]),
        );
        config.allow_init = true;
        config
    }
    fn command(
        migration: bool,
        operations: Vec<Operation>,
    ) -> crate::sequencer::types::CommandCommit {
        crate::sequencer::types::CommandCommit {
            caller_user_id: 0,
            caller_device_id: "auth-revocation-test".into(),
            command_name: "auth_revocations_test".into(),
            idempotency_key: None,
            room_owner_precondition: None,
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
            events: vec![EventToWrite {
                stream_id: STREAM.into(),
                event_type: EVENT.into(),
                stream_kind: 6,
                record_kind: RecordKind::Event,
                plaintext: event(migration, operations).payload,
            }],
        }
    }
    async fn engine(path: &std::path::Path) -> crate::engine::WabiDbEngine {
        let engine = crate::engine::WabiDbEngine::open(config(path))
            .await
            .unwrap();
        engine.get_or_create_stream_key(STREAM).await.unwrap();
        engine
    }

    #[tokio::test]
    async fn real_engine_refuses_a_stale_delta_without_a_commit_and_keeps_working() {
        let directory = tempfile::tempdir().unwrap();
        let engine = engine(directory.path()).await;
        engine
            .run_command(command(true, vec![Operation::Initialize]))
            .await
            .unwrap();
        let accepted = engine
            .run_command(command(
                false,
                vec![Operation::UserFloor {
                    user_id: 8,
                    floor: 100,
                    exempt_jtis: vec![],
                    clear_legacy: true,
                }],
            ))
            .await
            .unwrap();
        let before = crate::commit_index::batcher::read_all_entries(
            &directory.path().join("global/commit-index"),
        )
        .unwrap();
        assert!(engine
            .run_command(command(
                false,
                vec![
                    Operation::Token {
                        jti: "partial".into(),
                        expires_at: u64::MAX
                    },
                    Operation::UserFloor {
                        user_id: 8,
                        floor: 99,
                        exempt_jtis: vec![],
                        clear_legacy: true
                    }
                ]
            ))
            .await
            .is_err());
        assert_eq!(engine.barrier().current(), accepted.commit_seq);
        assert!(engine
            .projection_state()
            .get(INDEX, &token_key("partial"))
            .is_none());
        assert_eq!(
            crate::commit_index::batcher::read_all_entries(
                &directory.path().join("global/commit-index")
            )
            .unwrap()
            .len(),
            before.len()
        );
        engine
            .run_command(command(
                false,
                vec![Operation::UserFloor {
                    user_id: 8,
                    floor: 101,
                    exempt_jtis: vec![],
                    clear_legacy: true,
                }],
            ))
            .await
            .unwrap();
        drop(engine);
        let stopped = crate::tests::wait_for_stopped_engine(directory.path()).await;
        std::fs::remove_file(directory.path().join("projections/snapshot.json")).unwrap();
        drop(stopped);
        let reopened = crate::tests::reopen_after_drop(config(directory.path()), None)
            .await
            .unwrap();
        assert_eq!(
            decode_value(
                b"user:8",
                &reopened.projection_state().get(INDEX, b"user:8").unwrap()
            )
            .unwrap(),
            Value::User {
                user_id: 8,
                floor: 101,
                exempt_jtis: vec![]
            }
        );
        assert!(reopened
            .projection_state()
            .get(INDEX, &token_key("partial"))
            .is_none());
    }

    #[tokio::test]
    async fn atomic_password_and_transfer_commits_replay_and_stale_floor_writes_neither_half() {
        let directory = tempfile::tempdir().unwrap();
        let engine = engine(directory.path()).await;
        engine
            .run_command(command(true, vec![Operation::Initialize]))
            .await
            .unwrap();
        for name in ["old-owner", "new-owner"] {
            let mut cmd = command(
                false,
                vec![Operation::Token {
                    jti: "unused".into(),
                    expires_at: 1,
                }],
            );
            cmd.events = vec![write(
                "users",
                "user_registered",
                super::super::users::encode_record(&user(0, name, "old-hash")),
            )];
            engine.get_or_create_stream_key("users").await.unwrap();
            engine.run_command(cmd).await.unwrap();
        }
        let mut cmd = command(
            false,
            vec![Operation::Token {
                jti: "unused".into(),
                expires_at: 1,
            }],
        );
        cmd.events = vec![write(
            "server_meta",
            "owner_claimed",
            serde_json::json!({"owner_user_id":2})
                .to_string()
                .into_bytes(),
        )];
        engine
            .get_or_create_stream_key("server_meta")
            .await
            .unwrap();
        engine.run_command(cmd).await.unwrap();
        engine.get_or_create_stream_key("user:2").await.unwrap();
        let mut cmd = command(
            false,
            vec![Operation::Token {
                jti: "unused".into(),
                expires_at: 1,
            }],
        );
        cmd.events = password_command(2, "new-hash", 100);
        let accepted = engine.run_command(cmd).await.unwrap();
        let before = crate::commit_index::batcher::read_all_entries(
            &directory.path().join("global/commit-index"),
        )
        .unwrap()
        .len();
        let mut cmd = command(
            false,
            vec![Operation::Token {
                jti: "unused".into(),
                expires_at: 1,
            }],
        );
        cmd.events = password_command(2, "must-not-publish", 99);
        assert!(engine.run_command(cmd).await.is_err());
        assert_eq!(engine.barrier().current(), accepted.commit_seq);
        assert_eq!(
            crate::commit_index::batcher::read_all_entries(
                &directory.path().join("global/commit-index")
            )
            .unwrap()
            .len(),
            before
        );
        let record = super::super::users::decode_record(
            &engine
                .projection_state()
                .get("users", &super::super::users::encode_key(2))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(record.password_hash, "new-hash");
        let mut cmd = command(
            false,
            vec![Operation::Token {
                jti: "unused".into(),
                expires_at: 1,
            }],
        );
        cmd.events = owner_command(2, 3, 101);
        engine.run_command(cmd).await.unwrap();
        drop(engine);
        let stopped = crate::tests::wait_for_stopped_engine(directory.path()).await;
        std::fs::remove_file(directory.path().join("projections/snapshot.json")).unwrap();
        drop(stopped);
        let reopened = crate::tests::reopen_after_drop(config(directory.path()), None)
            .await
            .unwrap();
        let state = reopened.projection_state();
        assert_eq!(
            super::super::owner::OwnerProjection::get_owner(&state),
            Some(3)
        );
        assert_eq!(
            super::super::users::decode_record(
                &state
                    .get("users", &super::super::users::encode_key(2))
                    .unwrap()
            )
            .unwrap()
            .password_hash,
            "new-hash"
        );
        assert_eq!(
            decode_value(b"user:2", &state.get(INDEX, b"user:2").unwrap()).unwrap(),
            Value::User {
                user_id: 2,
                floor: 101,
                exempt_jtis: vec![]
            }
        );
    }

    #[tokio::test]
    async fn a_fenced_receiver_applies_denials_and_retains_them_after_event_replay() {
        let source_dir = tempfile::tempdir().unwrap();
        let receiver_dir = tempfile::tempdir().unwrap();
        let source = engine(source_dir.path()).await;
        source
            .run_command(command(true, vec![Operation::Initialize]))
            .await
            .unwrap();
        source
            .run_command(command(
                false,
                vec![
                    Operation::Token {
                        jti: "stolen".into(),
                        expires_at: u64::MAX,
                    },
                    Operation::UserFloor {
                        user_id: 8,
                        floor: 200,
                        exempt_jtis: vec!["own".into()],
                        clear_legacy: true,
                    },
                    Operation::GlobalFloor { epoch: 100 },
                ],
            ))
            .await
            .unwrap();
        std::fs::write(receiver_dir.path().join("writer-fenced-v1"), b"fenced\n").unwrap();
        let receiver = crate::engine::WabiDbEngine::open(config(receiver_dir.path()))
            .await
            .unwrap();
        let entries = crate::commit_index::batcher::read_all_entries(
            &source_dir.path().join("global/commit-index"),
        )
        .unwrap();
        let segment = std::fs::read(
            source_dir
                .path()
                .join("streams/other/auth-revocations:v1/events/00000001.wseg"),
        )
        .unwrap();
        for entry in entries {
            let end = entry
                .event_refs
                .iter()
                .map(|r| r.offset as usize + r.length as usize)
                .max()
                .unwrap();
            receiver
                .ingest_replicated_commit(
                    entry,
                    vec![(STREAM.into(), 6, 1, segment[..end].to_vec())],
                )
                .await
                .unwrap();
        }
        let compare = |state: &ProjectionState| {
            let mut records = BTreeMap::new();
            state.for_each(INDEX, |k, v| {
                records.insert(k.to_vec(), v.to_vec());
            });
            records
        };
        let expected = compare(&source.projection_state());
        assert_eq!(compare(&receiver.projection_state()), expected);
        assert!(receiver
            .run_command(command(false, vec![Operation::GlobalFloor { epoch: 500 }]))
            .await
            .is_err());
        drop(receiver);
        let stopped = crate::tests::wait_for_stopped_engine(receiver_dir.path()).await;
        std::fs::remove_file(receiver_dir.path().join("projections/snapshot.json")).unwrap();
        drop(stopped);
        let reopened = crate::tests::reopen_after_drop(config(receiver_dir.path()), None)
            .await
            .unwrap();
        assert!(reopened.local_writer_fenced().await);
        assert_eq!(compare(&reopened.projection_state()), expected);
    }

    #[tokio::test]
    async fn queued_controls_recheck_the_preceding_applied_floor() {
        let directory = tempfile::tempdir().unwrap();
        let engine = engine(directory.path()).await;
        engine
            .run_command(command(true, vec![Operation::Initialize]))
            .await
            .unwrap();
        let mut responses = vec![];
        for floor in [100, 99, 101] {
            let (tx, rx) = tokio::sync::oneshot::channel();
            let mut command = command(
                false,
                vec![Operation::UserFloor {
                    user_id: 8,
                    floor,
                    exempt_jtis: vec![],
                    clear_legacy: true,
                }],
            );
            command.response_tx = tx;
            engine
                .sequencer()
                .unwrap()
                .sender()
                .try_send(command)
                .unwrap();
            responses.push(rx);
        }
        let mut responses = responses.into_iter();
        assert!(responses.next().unwrap().await.unwrap().is_ok());
        assert!(responses.next().unwrap().await.unwrap().is_err());
        let accepted = responses.next().unwrap().await.unwrap().unwrap();
        assert_eq!(engine.barrier().current(), accepted.commit_seq);
        assert_eq!(
            crate::commit_index::batcher::read_all_entries(
                &directory.path().join("global/commit-index")
            )
            .unwrap()
            .len(),
            3
        );
        assert_eq!(
            decode_value(
                b"user:8",
                &engine.projection_state().get(INDEX, b"user:8").unwrap()
            )
            .unwrap(),
            Value::User {
                user_id: 8,
                floor: 101,
                exempt_jtis: vec![]
            }
        );
    }
}
