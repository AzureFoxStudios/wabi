//! Canonical recovery-code issuance, consumption and legacy import.
use crate::{adapter::WdbAdapter, instance_operations::InstanceOperations, state::RevocationStore};
use anyhow::{bail, Context};
use serde::de::{MapAccess, Visitor};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fmt,
    path::Path,
    sync::Arc,
};
use tokio::sync::RwLock;
use wabidb::{
    engine::WabiDbEngine,
    error::{Result, WabiError},
    format::record::RecordKind,
    projections::recovery_codes::{self as projection, Delta, Operation, Value},
    sequencer::types::{CommandCommit, EventToWrite},
};

type Codes = Arc<RwLock<HashMap<String, i64>>>;
pub(crate) fn hash_code(code: &str) -> String {
    hex::encode(Sha256::digest(code.as_bytes()))
}
fn validation(reason: &str) -> WabiError {
    WabiError::Validation {
        command: "recovery_codes".into(),
        reason: reason.into(),
    }
}
fn join_error(error: tokio::task::JoinError) -> WabiError {
    WabiError::InternalInvariantViolated {
        invariant: format!(
            "recovery publication task failed; inspect canonical account state: {error}"
        ),
    }
}
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
    .map_err(|_| validation("recovery delta encoding failed"))?;
    projection::decode(&payload)?;
    engine.get_or_create_stream_key(projection::STREAM).await?;
    engine
        .run_command(CommandCommit {
            caller_user_id: 0,
            caller_device_id: "authority".into(),
            command_name: "recovery_codes".into(),
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
fn read(engine: &WabiDbEngine) -> Result<HashMap<String, i64>> {
    let mut codes = HashMap::new();
    let mut ready = false;
    let mut failure = None;
    engine
        .projection_state()
        .for_each(
            projection::INDEX,
            |key, bytes| match projection::decode_value(key, bytes) {
                Ok(Value::Code {
                    digest,
                    user_id,
                    consumed: false,
                }) => {
                    codes.insert(digest, user_id);
                }
                Ok(Value::Code { consumed: true, .. }) => {}
                Ok(Value::Initialized) => ready = true,
                Err(error) => failure = Some(error),
            },
        );
    if let Some(error) = failure {
        return Err(error);
    }
    if !ready {
        return Err(validation(
            "canonical recovery-code migration is incomplete",
        ));
    }
    Ok(codes)
}

struct LegacyCodes(BTreeMap<String, i64>);
impl<'de> serde::Deserialize<'de> for LegacyCodes {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct CodeVisitor;
        impl<'de> Visitor<'de> for CodeVisitor {
            type Value = LegacyCodes;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a map of unique recovery digests to positive account IDs")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut codes = BTreeMap::new();
                while let Some((digest, user_id)) = map.next_entry::<String, i64>()? {
                    if !projection::valid_digest(&digest)
                        || user_id <= 0
                        || codes.insert(digest, user_id).is_some()
                    {
                        return Err(serde::de::Error::custom(
                            "invalid or duplicate legacy recovery digest",
                        ));
                    }
                }
                Ok(LegacyCodes(codes))
            }
        }
        deserializer.deserialize_map(CodeVisitor)
    }
}
pub(crate) async fn open(
    data_dir: &str,
    engine: &WabiDbEngine,
) -> anyhow::Result<HashMap<String, i64>> {
    if engine
        .projection_state()
        .get(projection::INDEX, projection::READY)
        .is_some()
    {
        return Ok(read(engine)?);
    }
    let path = Path::new(data_dir).join("recovery_codes.json");
    let legacy = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > 64 * 1024 * 1024
            {
                bail!("legacy recovery codes path is not a bounded regular file");
            }
            serde_json::from_slice::<LegacyCodes>(
                &std::fs::read(&path).context("read legacy recovery codes")?,
            )
            .context("invalid legacy recovery codes; refusing to reset account recovery state")?
            .0
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
        Err(error) => return Err(error).context("inspect legacy recovery codes"),
    };
    let mut batch = Vec::with_capacity(projection::MAX_OPERATIONS);
    for (digest, user_id) in legacy {
        if batch.len() == projection::MAX_OPERATIONS {
            commit(engine, true, std::mem::take(&mut batch)).await?;
        }
        batch.push(Operation::Issue { digest, user_id });
    }
    if batch.len() == projection::MAX_OPERATIONS {
        commit(engine, true, std::mem::take(&mut batch)).await?;
    }
    batch.push(Operation::Initialize);
    commit(engine, true, batch).await?;
    Ok(read(engine)?)
}

/// An owned worker covers durability and auth-view publication even if the
/// HTTP request disappears. Plaintext is returned only after that boundary.
pub(crate) async fn issue(
    codes: Codes,
    wdb: Arc<WdbAdapter>,
    user_id: i64,
    count: usize,
    operations: InstanceOperations,
) -> Result<Vec<String>> {
    if !(1..=32).contains(&count) || user_id <= 0 {
        return Err(validation("invalid recovery-code issue count or account"));
    }
    operations
        .spawn(async move {
            let mut guard = codes.write_owned().await;
            let plaintext: Vec<_> = (0..count)
                .map(|_| uuid::Uuid::new_v4().simple().to_string())
                .collect();
            let digests: Vec<_> = plaintext.iter().map(|code| hash_code(code)).collect();
            commit(
                wdb.engine(),
                false,
                digests
                    .iter()
                    .map(|digest| Operation::Issue {
                        digest: digest.clone(),
                        user_id,
                    })
                    .collect(),
            )
            .await?;
            for digest in digests {
                guard.insert(digest, user_id);
            }
            Ok(plaintext)
        })
        .await
        .map_err(join_error)?
}
pub(crate) async fn consume(
    codes: Codes,
    wdb: Arc<WdbAdapter>,
    digest: String,
    user_id: i64,
    operations: InstanceOperations,
) -> Result<bool> {
    operations
        .spawn(async move {
            let mut guard = codes.write_owned().await;
            if guard.get(&digest) != Some(&user_id) {
                return Ok(false);
            }
            commit(
                wdb.engine(),
                false,
                vec![Operation::Consume {
                    digest: digest.clone(),
                    user_id,
                }],
            )
            .await?;
            guard.remove(&digest);
            Ok(true)
        })
        .await
        .map_err(join_error)?
}
pub(crate) async fn recover(
    codes: Codes,
    revocations: Arc<RwLock<RevocationStore>>,
    owner: Arc<RwLock<Option<i64>>>,
    wdb: Arc<WdbAdapter>,
    digest: String,
    user_id: i64,
    operations: InstanceOperations,
    io: Option<socketioxide::SocketIo>,
    secret: String,
) -> Result<bool> {
    operations
        .spawn(async move {
            // Fixed lock order: codes -> revocations -> owner. No other code path
            // acquires this set in reverse. Auth cannot observe partial publication.
            let mut codes = codes.write_owned().await;
            if codes.get(&digest) != Some(&user_id) {
                return Ok(false);
            }
            let revocation_state = revocations.clone();
            let mut revocations = revocations.write_owned().await;
            let mut owner = owner.write_owned().await;
            let base = (chrono::Utc::now().timestamp().max(0) as u64)
                .max(revocations.epoch)
                .max(
                    revocations
                        .user_iat_revoked
                        .values()
                        .copied()
                        .max()
                        .unwrap_or(0),
                );
            let epoch = base
                .checked_add(1)
                .ok_or_else(|| validation("recovery revocation floor exhausted"))?;
            commit(
                wdb.engine(),
                false,
                vec![Operation::Recover {
                    digest: digest.clone(),
                    user_id,
                    epoch,
                }],
            )
            .await?;
            codes.remove(&digest);
            revocations.epoch = epoch;
            *owner = Some(user_id);
            drop(owner);
            drop(revocations);
            drop(codes);
            if let Some(io) = io {
                crate::socketio::disconnect_revoked_sockets(&io, &secret, &revocation_state).await;
            }
            Ok(true)
        })
        .await
        .map_err(join_error)?
}
