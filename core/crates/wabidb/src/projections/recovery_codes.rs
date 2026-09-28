//! Ordered one-use code state and atomic owner/session recovery. Only SHA-256
//! digests enter this log. Consumed digests remain as reuse-prevention records.
use crate::{
    engine::locks::ProjectionState,
    error::{Result, WabiError},
    format::record::RecordKind,
    projections::{
        auth_revocations,
        handler::{DurableEvent, Projection},
        owner, users,
    },
    sequencer::types::EventToWrite,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const EVENT: &str = "recovery_codes_updated_v1";
pub const INDEX: &str = "recovery_codes_v1";
pub const STREAM: &str = "recovery-codes:v1";
pub const READY: &[u8] = b"ready";
pub const MAX_OPERATIONS: usize = 512;
const MAX_BYTES: usize = 256 * 1024;

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
    Issue {
        digest: String,
        user_id: i64,
    },
    Consume {
        digest: String,
        user_id: i64,
    },
    Recover {
        digest: String,
        user_id: i64,
        epoch: u64,
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
    Code {
        digest: String,
        user_id: i64,
        consumed: bool,
    },
    Initialized,
}

impl Value {
    pub fn key(&self) -> Vec<u8> {
        match self {
            Self::Code { digest, .. } => code_key(digest),
            Self::Initialized => READY.to_vec(),
        }
    }
}
pub fn code_key(digest: &str) -> Vec<u8> {
    format!("code:{digest}").into_bytes()
}
pub fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn bad(reason: &str) -> WabiError {
    WabiError::Validation {
        command: "recovery_codes".into(),
        reason: reason.into(),
    }
}
pub fn decode_value(key: &[u8], bytes: &[u8]) -> Result<Value> {
    if bytes.len() > 1024 {
        return Err(bad("oversized recovery code index value"));
    }
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| bad("invalid recovery code index value"))?;
    if value.key() != key
        || matches!(&value, Value::Code { digest, user_id, .. } if !valid_digest(digest) || *user_id <= 0)
    {
        return Err(bad("recovery code value does not match its key"));
    }
    Ok(value)
}
pub fn decode(bytes: &[u8]) -> Result<Delta> {
    if bytes.len() > MAX_BYTES {
        return Err(bad("oversized recovery code delta"));
    }
    let delta: Delta =
        serde_json::from_slice(bytes).map_err(|_| bad("invalid recovery code delta"))?;
    if delta.schema_version != 1
        || delta.operations.is_empty()
        || delta.operations.len() > MAX_OPERATIONS
    {
        return Err(bad("invalid recovery code schema or operation count"));
    }
    Ok(delta)
}

type Writes = Vec<(&'static str, Vec<u8>, Vec<u8>)>;
fn current(
    state: &ProjectionState,
    pending: &BTreeMap<Vec<u8>, Value>,
    key: &[u8],
) -> Result<Option<Value>> {
    if let Some(value) = pending.get(key) {
        return Ok(Some(value.clone()));
    }
    state
        .get(INDEX, key)
        .map(|bytes| decode_value(key, &bytes))
        .transpose()
}
fn require_user(state: &ProjectionState, user_id: i64) -> Result<()> {
    let bytes = state
        .get("users", &users::encode_key(user_id as u64))
        .ok_or_else(|| bad("recovery account does not exist"))?;
    if users::decode_record(&bytes)?.user_id != user_id as u64 {
        return Err(bad("recovery account does not match its key"));
    }
    Ok(())
}
fn plan(delta: &Delta, state: &ProjectionState) -> Result<Writes> {
    let initialized = state
        .get(INDEX, READY)
        .map(|b| decode_value(READY, &b))
        .transpose()?
        .is_some();
    if delta.migration == initialized {
        return Err(bad(
            "recovery migration readiness does not match canonical state",
        ));
    }
    let mut pending = BTreeMap::new();
    let mut writes = Vec::new();
    for (position, op) in delta.operations.iter().enumerate() {
        if let Operation::Initialize = op {
            if !delta.migration || position + 1 != delta.operations.len() {
                return Err(bad("initialization must end a recovery migration batch"));
            }
            pending.insert(READY.to_vec(), Value::Initialized);
            continue;
        }
        let (digest, user_id) = match op {
            Operation::Issue { digest, user_id }
            | Operation::Consume { digest, user_id }
            | Operation::Recover {
                digest, user_id, ..
            } => (digest, *user_id),
            Operation::Initialize => unreachable!(),
        };
        if !valid_digest(digest) || user_id <= 0 {
            return Err(bad("invalid recovery digest or account"));
        }
        let key = code_key(digest);
        match op {
            Operation::Issue { .. } => {
                let value = Value::Code {
                    digest: digest.clone(),
                    user_id,
                    consumed: false,
                };
                if let Some(old) = current(state, &pending, &key)? {
                    if !delta.migration || old != value {
                        return Err(bad("recovery digest was already issued or consumed"));
                    }
                }
                if !delta.migration {
                    require_user(state, user_id)?;
                    if owner::OwnerProjection::get_owner(state) != Some(user_id as u64) {
                        return Err(bad("only the current owner may issue recovery codes"));
                    }
                }
                pending.insert(key, value);
            }
            Operation::Consume { .. } | Operation::Recover { .. } => {
                if delta.migration {
                    return Err(bad("consumption is forbidden during recovery import"));
                }
                if current(state, &pending, &key)?
                    != Some(Value::Code {
                        digest: digest.clone(),
                        user_id,
                        consumed: false,
                    })
                {
                    return Err(bad(
                        "recovery code is unavailable or belongs to another account",
                    ));
                }
                if let Operation::Recover { epoch, .. } = op {
                    if delta.operations.len() != 1 {
                        return Err(bad("account recovery must be a single compound operation"));
                    }
                    require_user(state, user_id)?;
                    auth_revocations::validate_global_floor(state, *epoch)?;
                    writes.push((
                        auth_revocations::INDEX,
                        b"global".to_vec(),
                        serde_json::to_vec(&auth_revocations::Value::Global { epoch: *epoch })
                            .map_err(|_| bad("recovery floor encoding failed"))?,
                    ));
                    writes.push((
                        "server_meta",
                        owner::OWNER_KEY.to_vec(),
                        serde_json::to_vec(&owner::OwnerRecord {
                            owner_user_id: user_id as u64,
                        })
                        .map_err(|_| bad("recovery owner encoding failed"))?,
                    ));
                }
                pending.insert(
                    key,
                    Value::Code {
                        digest: digest.clone(),
                        user_id,
                        consumed: true,
                    },
                );
            }
            Operation::Initialize => unreachable!(),
        }
    }
    // Serialize every row before publication so an invalid later operation
    // cannot spend a code or publish only ownership/session state.
    for (key, value) in pending {
        writes.push((
            INDEX,
            key,
            serde_json::to_vec(&value).map_err(|_| bad("recovery code encoding failed"))?,
        ));
    }
    Ok(writes)
}
pub(crate) fn preflight(events: &[EventToWrite], state: &ProjectionState) -> Result<()> {
    let relevant: Vec<_> = events.iter().filter(|e| e.event_type == EVENT).collect();
    if relevant.is_empty() {
        return Ok(());
    }
    if relevant.len() != 1 || events.len() != 1 {
        return Err(bad("recovery delta must be a separate command"));
    }
    let event = relevant[0];
    if event.stream_id != STREAM || event.stream_kind != 6 || event.record_kind != RecordKind::Event
    {
        return Err(bad("invalid recovery stream or record kind"));
    }
    plan(&decode(&event.plaintext)?, state)?;
    Ok(())
}
pub struct RecoveryCodesProjection;
impl Projection for RecoveryCodesProjection {
    fn event_type(&self) -> &str {
        EVENT
    }
    fn apply(&self, event: &DurableEvent, state: &ProjectionState) -> Result<()> {
        if event.stream_id != STREAM {
            return Err(bad("invalid recovery replay stream"));
        }
        let writes = plan(&decode(&event.payload)?, state)?;
        for (index, key, value) in writes {
            state.insert(index, key, value, event.commit_seq);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sequencer::types::CommandCommit;

    fn digest(n: u64) -> String {
        format!("{n:064x}")
    }
    fn event(migration: bool, operations: Vec<Operation>) -> DurableEvent {
        DurableEvent {
            commit_seq: 10,
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
    fn user_record() -> users::UserRecord {
        users::UserRecord {
            user_id: 1,
            username: "fixture".into(),
            handle: None,
            color: "#123456".into(),
            password_hash: "fixture".into(),
            is_registered: true,
            is_active: true,
            created_at_micros: 1,
            last_seen_micros: 1,
            profile_picture: None,
            username_font: None,
            bio: None,
            status_message: None,
        }
    }
    fn initialized() -> ProjectionState {
        let state = ProjectionState::new();
        state.insert(
            "users",
            users::encode_key(1),
            users::encode_record(&user_record()),
            1,
        );
        auth_revocations::AuthRevocationsProjection
            .apply(
                &DurableEvent {
                    commit_seq: 2,
                    stream_id: auth_revocations::STREAM.into(),
                    event_type: auth_revocations::EVENT.into(),
                    payload: serde_json::to_vec(&auth_revocations::Delta {
                        schema_version: 1,
                        migration: true,
                        operations: vec![auth_revocations::Operation::Initialize],
                    })
                    .unwrap(),
                },
                &state,
            )
            .unwrap();
        RecoveryCodesProjection
            .apply(&event(true, vec![Operation::Initialize]), &state)
            .unwrap();
        state.insert(
            "server_meta",
            owner::OWNER_KEY.to_vec(),
            serde_json::to_vec(&owner::OwnerRecord { owner_user_id: 1 }).unwrap(),
            3,
        );
        state
    }
    fn issued(state: &ProjectionState, n: u64) {
        RecoveryCodesProjection
            .apply(
                &event(
                    false,
                    vec![Operation::Issue {
                        digest: digest(n),
                        user_id: 1,
                    }],
                ),
                state,
            )
            .unwrap();
    }

    #[test]
    fn consumption_is_bound_and_a_consumed_digest_cannot_be_reissued() {
        let state = initialized();
        issued(&state, 1);
        assert!(RecoveryCodesProjection
            .apply(
                &event(
                    false,
                    vec![Operation::Consume {
                        digest: digest(1),
                        user_id: 2
                    }]
                ),
                &state
            )
            .is_err());
        RecoveryCodesProjection
            .apply(
                &event(
                    false,
                    vec![Operation::Consume {
                        digest: digest(1),
                        user_id: 1,
                    }],
                ),
                &state,
            )
            .unwrap();
        assert_eq!(
            decode_value(
                &code_key(&digest(1)),
                &state.get(INDEX, &code_key(&digest(1))).unwrap()
            )
            .unwrap(),
            Value::Code {
                digest: digest(1),
                user_id: 1,
                consumed: true
            }
        );
        for op in [
            Operation::Consume {
                digest: digest(1),
                user_id: 1,
            },
            Operation::Issue {
                digest: digest(1),
                user_id: 1,
            },
        ] {
            assert!(RecoveryCodesProjection
                .apply(&event(false, vec![op]), &state)
                .is_err());
        }
    }

    #[test]
    fn invalid_later_operation_publishes_no_earlier_code_change() {
        let state = initialized();
        issued(&state, 1);
        assert!(RecoveryCodesProjection
            .apply(
                &event(
                    false,
                    vec![
                        Operation::Consume {
                            digest: digest(1),
                            user_id: 1
                        },
                        Operation::Issue {
                            digest: "plaintext-is-not-a-digest".into(),
                            user_id: 1
                        },
                    ]
                ),
                &state
            )
            .is_err());
        assert_eq!(
            decode_value(
                &code_key(&digest(1)),
                &state.get(INDEX, &code_key(&digest(1))).unwrap()
            )
            .unwrap(),
            Value::Code {
                digest: digest(1),
                user_id: 1,
                consumed: false
            }
        );
    }

    #[test]
    fn recovery_validates_account_and_floor_before_publishing_all_three_records() {
        let state = initialized();
        issued(&state, 1);
        state.insert(
            "server_meta",
            owner::OWNER_KEY.to_vec(),
            serde_json::to_vec(&owner::OwnerRecord { owner_user_id: 2 }).unwrap(),
            3,
        );
        state.insert(
            auth_revocations::INDEX,
            b"user:1".to_vec(),
            serde_json::to_vec(&auth_revocations::Value::User {
                user_id: 1,
                floor: 200,
                exempt_jtis: vec!["old-exemption".into()],
            })
            .unwrap(),
            3,
        );
        for epoch in [0, 199, 200] {
            assert!(RecoveryCodesProjection
                .apply(
                    &event(
                        false,
                        vec![Operation::Recover {
                            digest: digest(1),
                            user_id: 1,
                            epoch
                        }]
                    ),
                    &state
                )
                .is_err());
            assert_eq!(owner::OwnerProjection::get_owner(&state), Some(2));
            assert!(state.get(auth_revocations::INDEX, b"global").is_none());
            assert_eq!(
                decode_value(
                    &code_key(&digest(1)),
                    &state.get(INDEX, &code_key(&digest(1))).unwrap()
                )
                .unwrap(),
                Value::Code {
                    digest: digest(1),
                    user_id: 1,
                    consumed: false
                }
            );
        }
        state.remove("users", &users::encode_key(1));
        assert!(RecoveryCodesProjection
            .apply(
                &event(
                    false,
                    vec![Operation::Recover {
                        digest: digest(1),
                        user_id: 1,
                        epoch: 201
                    }]
                ),
                &state
            )
            .is_err());
        state.insert(
            "users",
            users::encode_key(1),
            users::encode_record(&user_record()),
            1,
        );
        RecoveryCodesProjection
            .apply(
                &event(
                    false,
                    vec![Operation::Recover {
                        digest: digest(1),
                        user_id: 1,
                        epoch: 201,
                    }],
                ),
                &state,
            )
            .unwrap();
        assert_eq!(owner::OwnerProjection::get_owner(&state), Some(1));
        assert_eq!(
            auth_revocations::decode_value(
                b"global",
                &state.get(auth_revocations::INDEX, b"global").unwrap()
            )
            .unwrap(),
            auth_revocations::Value::Global { epoch: 201 }
        );
        assert_eq!(
            decode_value(
                &code_key(&digest(1)),
                &state.get(INDEX, &code_key(&digest(1))).unwrap()
            )
            .unwrap(),
            Value::Code {
                digest: digest(1),
                user_id: 1,
                consumed: true
            }
        );
    }

    #[test]
    fn partial_migration_is_idempotent_but_cannot_consume_or_serve() {
        let state = ProjectionState::new();
        let issue = Operation::Issue {
            digest: digest(1),
            user_id: 1,
        };
        for _ in 0..2 {
            RecoveryCodesProjection
                .apply(&event(true, vec![issue.clone()]), &state)
                .unwrap();
        }
        assert!(state.get(INDEX, READY).is_none());
        assert!(RecoveryCodesProjection
            .apply(
                &event(
                    true,
                    vec![Operation::Consume {
                        digest: digest(1),
                        user_id: 1
                    }]
                ),
                &state
            )
            .is_err());
        assert!(RecoveryCodesProjection
            .apply(
                &event(
                    false,
                    vec![Operation::Consume {
                        digest: digest(1),
                        user_id: 1
                    }]
                ),
                &state
            )
            .is_err());
        RecoveryCodesProjection
            .apply(
                &event(true, vec![issue.clone(), Operation::Initialize]),
                &state,
            )
            .unwrap();
        assert!(RecoveryCodesProjection
            .apply(&event(true, vec![issue]), &state)
            .is_err());
    }

    #[test]
    fn schema_bounds_stream_and_mixed_commands_are_refused() {
        let state = initialized();
        assert!(decode(b"{}").is_err());
        assert!(decode(&vec![b' '; MAX_BYTES + 1]).is_err());
        assert!(
            decode(&event(false, vec![Operation::Initialize; MAX_OPERATIONS + 1]).payload).is_err()
        );
        let mut cmd = command(
            false,
            vec![Operation::Issue {
                digest: digest(1),
                user_id: 1,
            }],
        );
        preflight(&cmd.events, &state).unwrap();
        cmd.events[0].stream_id = "wrong".into();
        assert!(preflight(&cmd.events, &state).is_err());
        cmd.events[0].stream_id = STREAM.into();
        cmd.events[0].stream_kind = 1;
        assert!(preflight(&cmd.events, &state).is_err());
        cmd.events[0].stream_kind = 6;
        cmd.events[0].record_kind = RecordKind::Snapshot;
        assert!(preflight(&cmd.events, &state).is_err());
        cmd.events[0].record_kind = RecordKind::Event;
        cmd.events.push(EventToWrite {
            stream_id: "probe".into(),
            event_type: "probe".into(),
            stream_kind: 6,
            record_kind: RecordKind::Event,
            plaintext: vec![],
        });
        assert!(preflight(&cmd.events, &state).is_err());
        assert!(RecoveryCodesProjection
            .apply(
                &event(
                    false,
                    vec![
                        Operation::Recover {
                            digest: digest(1),
                            user_id: 1,
                            epoch: 5
                        },
                        Operation::Initialize,
                    ]
                ),
                &state
            )
            .is_err());
    }

    fn config(path: &std::path::Path) -> crate::engine::WabiDbConfig {
        let mut config = crate::engine::WabiDbConfig::new(
            path.into(),
            crate::crypto::bootstrap::BootstrapSource::Provided([0xC9; 32]),
        );
        config.allow_init = true;
        config
    }
    fn raw_command(stream: &str, event_type: &str, payload: Vec<u8>) -> CommandCommit {
        CommandCommit {
            caller_user_id: 0,
            caller_device_id: "recovery-fixture".into(),
            command_name: "recovery-fixture".into(),
            idempotency_key: None,
            room_owner_precondition: None,
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
            events: vec![EventToWrite {
                stream_id: stream.into(),
                event_type: event_type.into(),
                stream_kind: 6,
                record_kind: RecordKind::Event,
                plaintext: payload,
            }],
        }
    }
    fn command(migration: bool, operations: Vec<Operation>) -> CommandCommit {
        raw_command(STREAM, EVENT, event(migration, operations).payload)
    }
    async fn engine(path: &std::path::Path) -> (crate::engine::WabiDbEngine, i64) {
        let engine = crate::engine::WabiDbEngine::open(config(path))
            .await
            .unwrap();
        for stream in [STREAM, auth_revocations::STREAM, "users", "server_meta"] {
            engine.get_or_create_stream_key(stream).await.unwrap();
        }
        engine
            .run_command(raw_command(
                auth_revocations::STREAM,
                auth_revocations::EVENT,
                serde_json::to_vec(&auth_revocations::Delta {
                    schema_version: 1,
                    migration: true,
                    operations: vec![auth_revocations::Operation::Initialize],
                })
                .unwrap(),
            ))
            .await
            .unwrap();
        engine
            .run_command(command(true, vec![Operation::Initialize]))
            .await
            .unwrap();
        let user = engine
            .run_command(raw_command(
                "users",
                "user_registered",
                users::encode_record(&user_record()),
            ))
            .await
            .unwrap()
            .commit_seq as i64;
        engine
            .run_command(raw_command(
                "server_meta",
                "owner_claimed",
                serde_json::to_vec(&owner::OwnerRecord {
                    owner_user_id: user as u64,
                })
                .unwrap(),
            ))
            .await
            .unwrap();
        (engine, user)
    }

    #[tokio::test]
    async fn queued_code_reuse_is_refused_before_commit_and_replay_keeps_the_whole_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let (engine, user_id) = engine(dir.path()).await;
        engine
            .run_command(command(
                false,
                vec![Operation::Issue {
                    digest: digest(1),
                    user_id,
                }],
            ))
            .await
            .unwrap();
        let before =
            crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
                .unwrap()
                .len();
        let mut responses = vec![];
        for epoch in [100, 101, 102] {
            let (tx, rx) = tokio::sync::oneshot::channel();
            let mut cmd = command(
                false,
                vec![Operation::Recover {
                    digest: digest(1),
                    user_id,
                    epoch,
                }],
            );
            cmd.response_tx = tx;
            engine.sequencer().unwrap().sender().try_send(cmd).unwrap();
            responses.push(rx);
        }
        let accepted = responses.remove(0).await.unwrap().unwrap();
        for response in responses {
            assert!(response.await.unwrap().is_err());
        }
        assert_eq!(engine.barrier().current(), accepted.commit_seq);
        assert_eq!(
            crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
                .unwrap()
                .len(),
            before + 1
        );
        drop(engine);
        std::fs::remove_file(dir.path().join("projections/snapshot.json")).unwrap();
        let reopened = crate::engine::WabiDbEngine::open(config(dir.path()))
            .await
            .unwrap();
        assert_eq!(reopened.barrier().current(), accepted.commit_seq);
        assert_eq!(
            owner::OwnerProjection::get_owner(&reopened.projection_state()),
            Some(user_id as u64)
        );
        assert_eq!(
            auth_revocations::decode_value(
                b"global",
                &reopened
                    .projection_state()
                    .get(auth_revocations::INDEX, b"global")
                    .unwrap()
            )
            .unwrap(),
            auth_revocations::Value::Global { epoch: 100 }
        );
        assert_eq!(
            decode_value(
                &code_key(&digest(1)),
                &reopened
                    .projection_state()
                    .get(INDEX, &code_key(&digest(1)))
                    .unwrap()
            )
            .unwrap(),
            Value::Code {
                digest: digest(1),
                user_id,
                consumed: true
            }
        );
        assert!(reopened
            .run_command(command(
                false,
                vec![Operation::Recover {
                    digest: digest(1),
                    user_id,
                    epoch: 103
                }]
            ))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn queued_issuance_rechecks_a_preceding_owner_change_before_commit() {
        let dir = tempfile::tempdir().unwrap();
        let (engine, original) = engine(dir.path()).await;
        let other = engine
            .run_command(raw_command(
                "users",
                "user_registered",
                users::encode_record(&user_record()),
            ))
            .await
            .unwrap()
            .commit_seq;
        let before =
            crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
                .unwrap()
                .len();
        let (owner_tx, owner_rx) = tokio::sync::oneshot::channel();
        let mut change = raw_command(
            "server_meta",
            "owner_claimed",
            serde_json::to_vec(&owner::OwnerRecord {
                owner_user_id: other,
            })
            .unwrap(),
        );
        change.response_tx = owner_tx;
        engine
            .sequencer()
            .unwrap()
            .sender()
            .try_send(change)
            .unwrap();
        let (issue_tx, issue_rx) = tokio::sync::oneshot::channel();
        let mut issue = command(
            false,
            vec![Operation::Issue {
                digest: digest(9),
                user_id: original,
            }],
        );
        issue.response_tx = issue_tx;
        engine
            .sequencer()
            .unwrap()
            .sender()
            .try_send(issue)
            .unwrap();
        let accepted = owner_rx.await.unwrap().unwrap();
        assert!(issue_rx.await.unwrap().is_err());
        assert_eq!(engine.barrier().current(), accepted.commit_seq);
        assert!(engine
            .projection_state()
            .get(INDEX, &code_key(&digest(9)))
            .is_none());
        assert_eq!(
            crate::commit_index::batcher::read_all_entries(&dir.path().join("global/commit-index"))
                .unwrap()
                .len(),
            before + 1
        );
        engine
            .run_command(command(
                false,
                vec![Operation::Issue {
                    digest: digest(10),
                    user_id: other as i64,
                }],
            ))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_fenced_receiver_applies_and_replays_the_compound_recovery() {
        let source_dir = tempfile::tempdir().unwrap();
        let receiver_dir = tempfile::tempdir().unwrap();
        let (source, user_id) = engine(source_dir.path()).await;
        source
            .run_command(command(
                false,
                vec![Operation::Issue {
                    digest: digest(1),
                    user_id,
                }],
            ))
            .await
            .unwrap();
        let accepted = source
            .run_command(command(
                false,
                vec![Operation::Recover {
                    digest: digest(1),
                    user_id,
                    epoch: 100,
                }],
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
        let streams = [
            auth_revocations::STREAM,
            STREAM,
            "users",
            "server_meta",
            STREAM,
            STREAM,
        ];
        assert_eq!(entries.len(), streams.len());
        for (entry, stream) in entries.into_iter().zip(streams) {
            assert_eq!(entry.event_refs.len(), 1);
            let reference = &entry.event_refs[0];
            let end = reference.offset as usize + reference.length as usize;
            let segment = std::fs::read(
                source_dir
                    .path()
                    .join(format!("streams/other/{stream}/events/00000001.wseg")),
            )
            .unwrap();
            receiver
                .ingest_replicated_commit(
                    entry,
                    vec![(stream.into(), 6, 1, segment[..end].to_vec())],
                )
                .await
                .unwrap();
        }
        let compare = |state: &ProjectionState| {
            let mut records = BTreeMap::new();
            for index in [INDEX, auth_revocations::INDEX, "server_meta", "users"] {
                state.for_each(index, |key, bytes| {
                    records.insert((index, key.to_vec()), bytes.to_vec());
                });
            }
            records
        };
        let expected = compare(&source.projection_state());
        assert_eq!(compare(&receiver.projection_state()), expected);
        assert_eq!(receiver.barrier().current(), accepted.commit_seq);
        assert!(receiver
            .run_command(command(
                false,
                vec![Operation::Issue {
                    digest: digest(2),
                    user_id
                }]
            ))
            .await
            .is_err());
        drop(receiver);
        std::fs::remove_file(receiver_dir.path().join("projections/snapshot.json")).unwrap();
        let reopened = crate::engine::WabiDbEngine::open(config(receiver_dir.path()))
            .await
            .unwrap();
        assert!(reopened.local_writer_fenced().await);
        assert_eq!(compare(&reopened.projection_state()), expected);
    }

    #[cfg(feature = "test-harness")]
    #[tokio::test]
    #[ignore = "subprocess-only crash fixture"]
    async fn account_recovery_crash_child() {
        let path = std::env::var_os("WABI_ACCOUNT_RECOVERY_CRASH_DIR").unwrap();
        let user_id = std::env::var("WABI_ACCOUNT_RECOVERY_CRASH_USER")
            .unwrap()
            .parse()
            .unwrap();
        let engine = crate::engine::WabiDbEngine::open(config(std::path::Path::new(&path)))
            .await
            .unwrap();
        engine
            .run_command(command(
                false,
                vec![Operation::Recover {
                    digest: digest(1),
                    user_id,
                    epoch: 100,
                }],
            ))
            .await
            .unwrap();
        panic!("recovery crash boundary did not fire");
    }

    #[cfg(feature = "test-harness")]
    #[tokio::test]
    async fn process_crashes_keep_code_owner_and_session_recovery_together() {
        for (boundary, committed) in [
            ("crash_before_any_write", false),
            ("crash_mid_stream_write", false),
            ("crash_before_index_fsync", false),
            ("crash_after_index_fsync", true),
            ("crash_after_projection_update", true),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let (source, original) = engine(dir.path()).await;
            source
                .run_command(command(
                    false,
                    vec![Operation::Issue {
                        digest: digest(1),
                        user_id: original,
                    }],
                ))
                .await
                .unwrap();
            let other = source
                .run_command(raw_command(
                    "users",
                    "user_registered",
                    users::encode_record(&user_record()),
                ))
                .await
                .unwrap()
                .commit_seq;
            source
                .run_command(raw_command(
                    "server_meta",
                    "owner_claimed",
                    serde_json::to_vec(&owner::OwnerRecord {
                        owner_user_id: other,
                    })
                    .unwrap(),
                ))
                .await
                .unwrap();
            let before = source.barrier().current();
            let before_entries = crate::commit_index::batcher::read_all_entries(
                &dir.path().join("global/commit-index"),
            )
            .unwrap()
            .len();
            drop(source);
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "projections::recovery_codes::tests::account_recovery_crash_child",
                    "--ignored",
                    "--nocapture",
                ])
                .env("WABI_ACCOUNT_RECOVERY_CRASH_DIR", dir.path())
                .env("WABI_ACCOUNT_RECOVERY_CRASH_USER", original.to_string())
                .env("WABIDB_CRASH_AT", boundary)
                .output()
                .unwrap();
            assert_eq!(
                output.status.code(),
                Some(1),
                "{boundary}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            // Force actual log replay and require automatic reclamation of the
            // dead child's engine lock; no manual lock deletion is allowed.
            std::fs::remove_file(dir.path().join("projections/snapshot.json")).unwrap();
            let recovered = crate::engine::WabiDbEngine::open(config(dir.path()))
                .await
                .unwrap();
            let state = recovered.projection_state();
            let key = code_key(&digest(1));
            assert_eq!(
                decode_value(&key, &state.get(INDEX, &key).unwrap()).unwrap(),
                Value::Code {
                    digest: digest(1),
                    user_id: original,
                    consumed: committed
                },
                "{boundary}"
            );
            assert_eq!(
                owner::OwnerProjection::get_owner(&state),
                Some(if committed { original as u64 } else { other }),
                "{boundary}"
            );
            assert_eq!(
                state
                    .get(auth_revocations::INDEX, b"global")
                    .map(|bytes| auth_revocations::decode_value(b"global", &bytes).unwrap()),
                committed.then_some(auth_revocations::Value::Global { epoch: 100 }),
                "{boundary}"
            );
            assert_eq!(
                recovered.barrier().current(),
                before + u64::from(committed),
                "{boundary}"
            );
            assert_eq!(
                crate::commit_index::batcher::read_all_entries(
                    &dir.path().join("global/commit-index")
                )
                .unwrap()
                .len(),
                before_entries + usize::from(committed),
                "{boundary}"
            );
            let current_owner = if committed { original } else { other as i64 };
            recovered
                .run_command(command(
                    false,
                    vec![Operation::Issue {
                        digest: digest(2),
                        user_id: current_owner,
                    }],
                ))
                .await
                .unwrap();
        }
    }
}
