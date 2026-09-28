//! Canonical revocation deltas and one-time legacy sidecar import.
use crate::state::{AppState, RevocationStore};
use anyhow::{bail, Context};
use std::{collections::HashSet, path::Path};
use wabidb::{
    engine::WabiDbEngine,
    error::Result,
    format::record::RecordKind,
    projections::auth_revocations::{self as projection, Delta, Operation, Value},
    sequencer::types::{CommandCommit, EventToWrite},
};

pub(crate) async fn commit(
    engine: &WabiDbEngine,
    migration: bool,
    operations: Vec<Operation>,
) -> Result<()> {
    let payload = serde_json::to_vec(&Delta {
        schema_version: 1,
        migration,
        operations,
    })
    .map_err(|error| wabidb::error::WabiError::Validation {
        command: "auth_revocations".into(),
        reason: error.to_string(),
    })?;
    // The shared decoder enforces payload bounds before touching the stream.
    projection::decode(&payload)?;
    engine.get_or_create_stream_key(projection::STREAM).await?;
    engine
        .run_command(CommandCommit {
            caller_user_id: 0,
            caller_device_id: "authority".into(),
            command_name: "auth_revocations".into(),
            idempotency_key: None,
            room_owner_precondition: None,
            essential: true,
            response_tx: tokio::sync::oneshot::channel().0,
            events: vec![EventToWrite {
                stream_id: projection::STREAM.into(),
                event_type: projection::EVENT.into(),
                stream_kind: 6,
                record_kind: RecordKind::Event,
                plaintext: payload,
            }],
        })
        .await?;
    Ok(())
}

pub(crate) fn read(engine: &WabiDbEngine) -> Result<RevocationStore> {
    let state = engine.projection_state();
    let mut result = RevocationStore::default();
    let mut failure = None;
    let mut ready = false;
    state.for_each(
        projection::INDEX,
        |key, bytes| match projection::decode_value(key, bytes) {
            Ok(Value::Global { epoch }) => result.epoch = epoch,
            Ok(Value::User {
                user_id,
                floor,
                exempt_jtis,
            }) => {
                result.user_iat_revoked.insert(user_id, floor);
                if !exempt_jtis.is_empty() {
                    result
                        .user_jti_exemptions
                        .insert(user_id, exempt_jtis.into_iter().collect::<HashSet<_>>());
                }
            }
            Ok(Value::Token { jti, expires_at }) => {
                result.jtis.insert(jti, expires_at);
            }
            Ok(Value::LegacyUser { user_id }) => {
                result.users.insert(user_id);
            }
            Ok(Value::Initialized) => ready = true,
            Err(error) => failure = Some(error),
        },
    );
    if let Some(error) = failure {
        return Err(error);
    }
    if !ready {
        return Err(wabidb::error::WabiError::Validation {
            command: "auth_revocations".into(),
            reason: "canonical revocation migration is incomplete".into(),
        });
    }
    Ok(result)
}

pub(crate) async fn open(data_dir: &str, engine: &WabiDbEngine) -> anyhow::Result<RevocationStore> {
    if engine
        .projection_state()
        .get(projection::INDEX, projection::READY)
        .is_some()
    {
        return Ok(read(engine)?);
    }
    let path = Path::new(data_dir).join("revocations.json");
    let mut legacy = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                bail!("legacy revocations path is not a regular file");
            }
            AppState::decode_legacy_revocations_str(
                &std::fs::read_to_string(&path).context("read legacy session revocations")?,
            )
            .context("invalid legacy session revocations; refusing to reset denial state")?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => RevocationStore::default(),
        Err(error) => return Err(error).context("inspect legacy session revocations"),
    };
    legacy.prune_expired_jtis(chrono::Utc::now().timestamp().max(0) as u64);
    // Migration is bounded per command and idempotent before READY. A crash
    // mid-import cannot publish an Authority with only part of the denials.
    let mut batch = Vec::with_capacity(projection::MAX_OPERATIONS);
    let mut batch_bytes = 0;
    push_import(
        engine,
        &mut batch,
        &mut batch_bytes,
        Operation::GlobalFloor {
            epoch: legacy.epoch,
        },
    )
    .await?;
    for (jti, expires_at) in legacy.jtis {
        push_import(
            engine,
            &mut batch,
            &mut batch_bytes,
            Operation::Token { jti, expires_at },
        )
        .await?;
    }
    for user_id in legacy.users {
        push_import(
            engine,
            &mut batch,
            &mut batch_bytes,
            Operation::LegacyUser { user_id },
        )
        .await?;
    }
    for (user_id, floor) in legacy.user_iat_revoked {
        let mut exempt_jtis: Vec<_> = legacy
            .user_jti_exemptions
            .remove(&user_id)
            .unwrap_or_default()
            .into_iter()
            .collect();
        exempt_jtis.sort();
        push_import(
            engine,
            &mut batch,
            &mut batch_bytes,
            Operation::UserFloor {
                user_id,
                floor,
                exempt_jtis,
                clear_legacy: false,
            },
        )
        .await?;
    }
    push_import(engine, &mut batch, &mut batch_bytes, Operation::Initialize).await?;
    commit(engine, true, batch).await?;
    Ok(read(engine)?)
}

async fn push_import(
    engine: &WabiDbEngine,
    batch: &mut Vec<Operation>,
    bytes: &mut usize,
    operation: Operation,
) -> anyhow::Result<()> {
    let size = serde_json::to_vec(&operation)?.len();
    if batch.len() == projection::MAX_OPERATIONS || *bytes + size > 3 * 1024 * 1024 {
        commit(engine, true, std::mem::take(batch)).await?;
        *bytes = 0;
    }
    batch.push(operation);
    *bytes += size;
    Ok(())
}
