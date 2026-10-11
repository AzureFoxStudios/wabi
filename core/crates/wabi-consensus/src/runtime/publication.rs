//! Owned publication journal and same-operation restart reconciliation.
//! This records historical observations, never a Wabi writer permission.
use super::*;
use crate::availability_control::CheckpointObservationCommand;
use crate::material::MaterialKind;

const RECORD_BYTES: usize = 256 * 1024;
const JOURNAL_BYTES: u64 = 32 * 1024 * 1024;
const OPERATIONS: usize = 128;
const NONBLOCK: i32 = 0o4000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "phase",
    content = "payload",
    rename_all = "snake_case",
    deny_unknown_fields
)]
enum Payload {
    Capture(SignedSourceContext),
    Manifest(CheckpointManifest),
    Prepared {
        command: CheckpointObservationCommand,
        fingerprint: String,
    },
}
impl Payload {
    fn phase(&self) -> &'static str {
        match self {
            Self::Capture(_) => "capture",
            Self::Manifest(_) => "manifest",
            Self::Prepared { .. } => "prepared",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    schema_version: u8,
    binding: StoreBinding,
    roster_digest: String,
    operation_id: String,
    body: Payload,
}
#[derive(Default)]
struct Saved {
    stored_bytes: u64,
    capture: Option<SignedSourceContext>,
    manifest: Option<CheckpointManifest>,
    prepared: Option<CheckpointObservationCommand>,
}
fn operation_valid(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn filename(operation: &str, phase: &str) -> String {
    format!("publication-{operation}-{phase}.json")
}
fn parse_name(name: &str) -> Option<(&str, &str)> {
    let (id, phase) = name
        .strip_prefix("publication-")?
        .strip_suffix(".json")?
        .split_once('-')?;
    (operation_valid(id) && matches!(phase, "capture" | "manifest" | "prepared"))
        .then_some((id, phase))
}
fn context_valid(opened: &Opened, source: &SignedSourceContext) -> bool {
    source
        .verify(&opened.control.binding().community_id, &opened.source_node)
        .is_ok()
}
fn manifest_valid(opened: &Opened, manifest: &CheckpointManifest) -> bool {
    let mut total = 0u64;
    manifest.schema_version == 2
        && manifest.partition_id == opened.control.binding().partition_id
        && context_valid(opened, &manifest.source)
        && manifest.objects.len() <= 1024
        && manifest.objects.iter().all(|object| {
            total = total.saturating_add(object.bytes);
            object.kind == MaterialKind::CheckpointChunk
                && object.bytes > 0
                && object.bytes <= 64 * 1024
                && object.sha256.len() == 64
                && object
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        && total == manifest.source.claims.ciphertext_bytes
        && manifest.sha256().is_ok()
}
impl Record {
    fn valid(&self, opened: &Opened) -> bool {
        self.schema_version == 1
            && self.binding == *opened.control.binding()
            && self.roster_digest == opened.config.roster_digest()
            && operation_valid(&self.operation_id)
            && match &self.body {
                Payload::Capture(source) => context_valid(opened, source),
                Payload::Manifest(manifest) => manifest_valid(opened, manifest),
                Payload::Prepared {
                    command,
                    fingerprint,
                } => {
                    command.valid()
                        && command.config_matches(&opened.config)
                        && command.collector_node_id() == opened.config.node_id()
                        && command.operation_id() == self.operation_id
                        && context_valid(opened, &command.manifest().source)
                        && command.fingerprint().as_ref() == Some(fingerprint)
                }
            }
    }
}
fn identity(meta: &fs::Metadata) -> (u64, u64, u64, u32, u32, u64, i64, i64, i64, i64) {
    (
        meta.dev(),
        meta.ino(),
        meta.len(),
        meta.uid(),
        meta.mode(),
        meta.nlink(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec(),
    )
}
fn read(opened: &Opened, name: &str) -> Result<Record> {
    let root = &opened.lease.roots[0];
    opened.verify()?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(NOFOLLOW | NONBLOCK)
        .open(root.relative(name))
        .map_err(|_| RuntimeError::Ownership)?;
    root.check_file(name, &file)?;
    let before = file.metadata().map_err(|_| RuntimeError::Ownership)?;
    if !before.is_file() || before.len() > RECORD_BYTES as u64 {
        return Err(RuntimeError::Ownership);
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(RECORD_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| RuntimeError::Unavailable)?;
    root.check_file(name, &file)?;
    if identity(&before) != identity(&file.metadata().map_err(|_| RuntimeError::Ownership)?)
        || bytes.len() > RECORD_BYTES
    {
        return Err(RuntimeError::Ownership);
    }
    let record: Record = serde_json::from_slice(&bytes).map_err(|_| RuntimeError::Ownership)?;
    if !record.valid(opened)
        || serde_json::to_vec(&record).ok().as_deref() != Some(bytes.as_slice())
        || filename(&record.operation_id, record.body.phase()) != name
    {
        return Err(RuntimeError::Ownership);
    }
    opened.verify()?;
    Ok(record)
}
/// Scan is bounded even if unrelated files appear in this dedicated root.
/// Partial staging is retained and refuses admission for explicit inspection.
fn inventory(opened: &Opened) -> Result<BTreeMap<String, Saved>> {
    opened.verify()?;
    let root = &opened.lease.roots[0];
    let mut names = Vec::new();
    let mut all_entries = 0usize;
    let mut stored = 0u64;
    for entry in fs::read_dir(root.relative("")).map_err(|_| RuntimeError::Ownership)? {
        all_entries += 1;
        if all_entries > OPERATIONS * 3 + 8 {
            return Err(RuntimeError::Refused);
        }
        let entry = entry.map_err(|_| RuntimeError::Ownership)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| RuntimeError::Ownership)?;
        if name.starts_with(".publication-") {
            return Err(RuntimeError::Ownership);
        }
        if name.starts_with("publication-") {
            if parse_name(&name).is_none() {
                return Err(RuntimeError::Ownership);
            }
            let meta =
                fs::symlink_metadata(root.relative(&name)).map_err(|_| RuntimeError::Ownership)?;
            stored = stored
                .checked_add(meta.len())
                .ok_or(RuntimeError::Refused)?;
            if stored > JOURNAL_BYTES {
                return Err(RuntimeError::Refused);
            }
            names.push(name);
        }
    }
    let mut operations: BTreeMap<String, Saved> = BTreeMap::new();
    for name in names {
        let record = read(opened, &name)?;
        let encoded_bytes = serde_json::to_vec(&record)
            .map_err(|_| RuntimeError::Ownership)?
            .len() as u64;
        let saved = operations.entry(record.operation_id).or_default();
        saved.stored_bytes = saved
            .stored_bytes
            .checked_add(encoded_bytes)
            .ok_or(RuntimeError::Refused)?;
        match record.body {
            Payload::Capture(source) => saved.capture = Some(source),
            Payload::Manifest(manifest) => saved.manifest = Some(manifest),
            Payload::Prepared { command, .. } => saved.prepared = Some(command),
        }
    }
    if operations.len() > OPERATIONS {
        return Err(RuntimeError::Refused);
    }
    for saved in operations.values() {
        let capture = saved.capture.as_ref().ok_or(RuntimeError::Ownership)?;
        if let Some(manifest) = &saved.manifest {
            if &manifest.source != capture {
                return Err(RuntimeError::Ownership);
            }
        }
        if let Some(command) = &saved.prepared {
            if saved.manifest.as_ref() != Some(command.manifest()) {
                return Err(RuntimeError::Ownership);
            }
        }
    }
    opened.verify()?;
    Ok(operations)
}
pub(super) fn verify_existing(opened: &Opened) -> Result<()> {
    inventory(opened).map(drop)
}

/// Local pending inventory is an original-identity work list, never an
/// availability or writer grant. Exclude only an exact historical command
/// validated against actual applied control state; ambiguity refuses admission.
fn pending_originals(opened: &Opened, state: &ControlState,
    records: BTreeMap<String, Saved>) -> Result<Vec<PublicationOperation>>
{
    opened.verify()?;
    let mut pending = Vec::new();
    for (operation_id, saved) in records {
        if state.checkpoints.contains_key(&operation_id) {
            let command = saved.prepared.as_ref().ok_or(RuntimeError::Refused)?;
            CommittedCheckpointObservation::from_recorded(command, state,
                &opened.config, &opened.source_node).map_err(runtime_transport_error)?;
            continue;
        }
        if state.operations.contains_key(&operation_id) { return Err(RuntimeError::Refused); }
        let stage = if saved.prepared.is_some() { PublicationStage::Prepared }
            else if saved.manifest.is_some() { PublicationStage::Manifest }
            else { PublicationStage::Capture };
        pending.push(PublicationOperation { operation_id, stage });
    }
    opened.verify()?;
    Ok(pending)
}

/// Reconfirm existing original records without writing/recreating any name.
/// Hold all exact record descriptors through file and directory sync and
/// post-sync byte/identity checks. Historical receipt retries need no leader.
fn confirm_original_intent(opened: &Opened, operation: &str) -> Result<()> {
    use std::io::{Seek, SeekFrom};
    if !operation_valid(operation) { return Err(RuntimeError::Refused); }
    let mut operations = inventory(opened)?;
    let saved = operations.remove(operation).ok_or(RuntimeError::Refused)?;
    let mut payloads = vec![Payload::Capture(saved.capture.ok_or(RuntimeError::Ownership)?)];
    if let Some(manifest) = saved.manifest { payloads.push(Payload::Manifest(manifest)); }
    if let Some(command) = saved.prepared {
        let fingerprint = command.fingerprint().ok_or(RuntimeError::Ownership)?;
        payloads.push(Payload::Prepared { command, fingerprint });
    }
    let root = &opened.lease.roots[0];
    let mut held = Vec::new();
    for body in payloads {
        let name = filename(operation, body.phase());
        let record = Record { schema_version: 1, binding: opened.control.binding().clone(),
            roster_digest: opened.config.roster_digest(), operation_id: operation.into(), body };
        let expected = serde_json::to_vec(&record).map_err(|_| RuntimeError::Ownership)?;
        if expected.len() > RECORD_BYTES || !record.valid(opened) { return Err(RuntimeError::Ownership); }
        let mut file = OpenOptions::new().read(true).custom_flags(NOFOLLOW | NONBLOCK)
            .open(root.relative(&name)).map_err(|_| RuntimeError::Ownership)?;
        root.check_file(&name, &file)?;
        let before = file.metadata().map_err(|_| RuntimeError::Ownership)?;
        if !before.is_file() || before.len() != expected.len() as u64 { return Err(RuntimeError::Ownership); }
        let mut bytes = Vec::new();
        (&mut file).take(RECORD_BYTES as u64 + 1).read_to_end(&mut bytes)
            .map_err(|_| RuntimeError::Unavailable)?;
        root.check_file(&name, &file)?;
        if bytes != expected || identity(&before) != identity(&file.metadata().map_err(|_| RuntimeError::Ownership)?) {
            return Err(RuntimeError::Ownership);
        }
        held.push((name, file, before, expected));
    }
    for (_, file, _, _) in &held { file.sync_all().map_err(|_| RuntimeError::Unavailable)?; }
    root.directory.sync_all().map_err(|_| RuntimeError::Unavailable)?;
    for (name, mut file, before, expected) in held {
        root.check_file(&name, &file)?;
        if identity(&before) != identity(&file.metadata().map_err(|_| RuntimeError::Ownership)?) {
            return Err(RuntimeError::Ownership);
        }
        file.seek(SeekFrom::Start(0)).map_err(|_| RuntimeError::Unavailable)?;
        let mut bytes = Vec::new();
        (&mut file).take(RECORD_BYTES as u64 + 1).read_to_end(&mut bytes)
            .map_err(|_| RuntimeError::Unavailable)?;
        root.check_file(&name, &file)?;
        if bytes != expected || identity(&before) != identity(&file.metadata().map_err(|_| RuntimeError::Ownership)?) {
            return Err(RuntimeError::Ownership);
        }
    }
    opened.verify()
}

/// Append-only atomic records: never overwrite/reset a prepared operation.
/// Complete bytes and the parent directory sync precede the next phase.
fn publish(opened: &Opened, operation: &str, payload: Payload) -> Result<()> {
    let existing = inventory(opened)?;
    if !operation_valid(operation) {
        return Err(RuntimeError::Refused);
    }
    let root = &opened.lease.roots[0];
    let record = Record {
        schema_version: 1,
        binding: opened.control.binding().clone(),
        roster_digest: opened.config.roster_digest(),
        operation_id: operation.into(),
        body: payload,
    };
    if !record.valid(opened) {
        return Err(RuntimeError::Refused);
    }
    let bytes = serde_json::to_vec(&record).map_err(|_| RuntimeError::Refused)?;
    if bytes.len() > RECORD_BYTES {
        return Err(RuntimeError::Refused);
    }
    let final_name = filename(operation, record.body.phase());
    if fs::symlink_metadata(root.relative(&final_name)).is_ok() {
        if read(opened, &final_name)? != record {
            return Err(RuntimeError::Refused);
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(NOFOLLOW | NONBLOCK)
            .open(root.relative(&final_name))
            .map_err(|_| RuntimeError::Ownership)?;
        root.check_file(&final_name, &file)?;
        file.sync_all()
            .and_then(|_| root.directory.sync_all())
            .map_err(|_| RuntimeError::Unavailable)?;
        root.check_file(&final_name, &file)?;
        if read(opened, &final_name)? != record {
            return Err(RuntimeError::Ownership);
        }
        return Ok(());
    }
    let prior = existing.get(operation);
    match &record.body {
        Payload::Capture(_) if prior.is_some() => return Err(RuntimeError::Ownership),
        Payload::Manifest(manifest)
            if prior.and_then(|r| r.capture.as_ref()) != Some(&manifest.source) =>
        {
            return Err(RuntimeError::Refused)
        }
        Payload::Prepared { command, .. }
            if prior.and_then(|r| r.manifest.as_ref()) != Some(command.manifest()) =>
        {
            return Err(RuntimeError::Refused)
        }
        _ => (),
    }
    if prior.is_none() && existing.len() >= OPERATIONS {
        return Err(RuntimeError::Refused);
    }
    let used: u64 = existing.values().map(|saved| saved.stored_bytes).sum();
    if used.saturating_add(bytes.len() as u64) > JOURNAL_BYTES
        || fs4::available_space(root.relative("")).map_err(|_| RuntimeError::Unavailable)?
            < 64 * 1024 * 1024 + bytes.len() as u64
    {
        return Err(RuntimeError::Refused);
    }
    let stage = format!(".publication-{operation}-{}.pending", record.body.phase());
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(NOFOLLOW | NONBLOCK)
        .open(root.relative(&stage))
        .map_err(|_| RuntimeError::Ownership)?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| RuntimeError::Unavailable)?;
    root.check_file(&stage, &file)?;
    fs::hard_link(root.relative(&stage), root.relative(&final_name))
        .map_err(|_| RuntimeError::Unavailable)?;
    // No uncertain/error cleanup: preserve staging for explicit inspection.
    fs::remove_file(root.relative(&stage)).map_err(|_| RuntimeError::Unavailable)?;
    root.check_file(&final_name, &file)?;
    root.directory
        .sync_all()
        .map_err(|_| RuntimeError::Unavailable)?;
    if read(opened, &final_name)? != record {
        return Err(RuntimeError::Ownership);
    }
    Ok(())
}

fn remaining(deadline: Instant) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|v| !v.is_zero())
        .ok_or(RuntimeError::Deadline)
}
fn leader_only(inner: &Inner) -> Result<()> {
    inner.opened.verify()?;
    let metrics = inner.raft.metrics();
    let state = metrics.borrow();
    if state.current_leader != Some(inner.opened.config.node_id())
        || state.state != openraft::ServerState::Leader
        || !membership_matches(&state.membership_config, &inner.opened.peers)
    {
        return Err(RuntimeError::NotLeader);
    }
    Ok(())
}
async fn saved(inner: Arc<Inner>, operation: String) -> Result<Saved> {
    tokio::task::spawn_blocking(move || {
        let mut records = inventory(&inner.opened)?;
        records.remove(&operation).ok_or(RuntimeError::Refused)
    })
    .await
    .map_err(|_| RuntimeError::Closed)?
}
async fn save(inner: Arc<Inner>, operation: String, payload: Payload) -> Result<()> {
    tokio::task::spawn_blocking(move || publish(&inner.opened, &operation, payload))
        .await
        .map_err(|_| RuntimeError::Closed)?
}
/// Every local read owns the actual store and runtime through completion.
async fn distribute(
    inner: Arc<Inner>,
    manifest: &CheckpointManifest,
    deadline: Instant,
) -> Result<()> {
    let mut durable = 1usize;
    for node in inner.opened.peers.keys().copied() {
        if node == inner.opened.config.node_id() {
            continue;
        }
        match distribute_one(inner.clone(), manifest, deadline, node).await {
            Ok(()) => durable += 1,
            Err(RuntimeError::Refused | RuntimeError::Deadline) if Instant::now() < deadline => (),
            Err(error) => return Err(error),
        }
    }
    if durable < 2 {
        return Err(RuntimeError::Refused);
    }
    inner.opened.verify()?;
    Ok(())
}
async fn distribute_one(
    inner: Arc<Inner>,
    manifest: &CheckpointManifest,
    deadline: Instant,
    node: u64,
) -> Result<()> {
    use crate::transport::CheckpointClient;
    let digest = manifest.sha256().map_err(|_| RuntimeError::Refused)?;
    leader_only(&inner)?;
    let client = CheckpointClient::new(
        inner.opened.config.clone(),
        node,
        inner.opened.source_node.clone(),
    )
    .map_err(runtime_transport_error)?;
    for (index, expected) in manifest.objects.iter().enumerate() {
        remaining(deadline)?;
        let owner = inner.clone();
        let digest = digest.clone();
        let (object, bytes) = tokio::task::spawn_blocking(move || {
            owner.opened.verify()?;
            let value = owner
                .opened
                .material
                .read_checkpoint_object(&digest, &owner.opened.source_node, index)
                .map_err(|_| RuntimeError::Refused);
            owner.opened.verify()?;
            value
        })
        .await
        .map_err(|_| RuntimeError::Closed)??;
        if &object != expected {
            return Err(RuntimeError::Refused);
        }
        remaining(deadline)?;
        tokio::time::timeout_at(deadline.into(), client.put_object(object, &bytes))
            .await
            .map_err(|_| RuntimeError::Deadline)?
            .map_err(runtime_transport_error)?;
    }
    tokio::time::timeout_at(deadline.into(), client.certify(manifest))
        .await
        .map_err(|_| RuntimeError::Deadline)?
        .map_err(runtime_transport_error)?;
    inner.opened.verify()?;
    Ok(())
}
/// Check every runtime root even when the underlying control read failed.
/// A late or ownership-invalid read cannot become a historical success.
fn checked_control_read(
    inner: &Inner,
    deadline: Instant,
    value: std::result::Result<ControlState, crate::store::StoreError>,
) -> Result<ControlState> {
    inner.opened.verify()?;
    remaining(deadline)?;
    value.map_err(|_| RuntimeError::Unavailable)
}
async fn complete(
    inner: Arc<Inner>,
    operation: String,
    deadline: Instant,
) -> Result<CommittedCheckpointObservation> {
    let saved = saved(inner.clone(), operation.clone()).await?;
    let manifest = saved.manifest.ok_or(RuntimeError::CaptureRequired)?;
    let state = inner.opened.control.control_state().await;
    let state = checked_control_read(&inner, deadline, state)?;
    // Missing local state never proves a prior admission failed. Only the exact
    // original prepared command can be resubmitted to actual Raft below.
    if let Some(command) = &saved.prepared {
        if state.checkpoints.contains_key(&operation) {
            return CommittedCheckpointObservation::from_recorded(
                command,
                &state,
                &inner.opened.config,
                &inner.opened.source_node,
            )
            .map_err(runtime_transport_error);
        }
    } else if state.checkpoints.contains_key(&operation) {
        return Err(RuntimeError::Refused);
    }
    if state.operations.contains_key(&operation) {
        return Err(RuntimeError::Refused);
    }
    leader_only(&inner)?;
    // Read fresh local durable bytes first; a journal is not an availability ACK.
    let owner = inner.clone();
    let digest = manifest.sha256().map_err(|_| RuntimeError::Refused)?;
    tokio::task::spawn_blocking(move || {
        owner.opened.verify()?;
        let result = owner
            .opened
            .material
            .checkpoint_receipt(&digest, &owner.opened.source_node)
            .map_err(|_| RuntimeError::Refused);
        owner.opened.verify()?;
        result.map(drop)
    })
    .await
    .map_err(|_| RuntimeError::Closed)??;
    distribute(inner.clone(), &manifest, deadline).await?;
    let mut round = CheckpointAvailabilityRound::begin(
        inner.opened.config.clone(),
        inner.opened.control.clone(),
        &inner.service,
        operation.clone(),
        &manifest,
        remaining(deadline)?,
    )
    .await
    .map_err(runtime_transport_error)?;
    let prepared = match saved.prepared {
        Some(command) => round
            .prepare_exact_publication_retry(&command, &inner.raft)
            .await
            .map_err(runtime_transport_error)?,
        None => {
            round
                .refresh(inner.opened.config.node_id())
                .await
                .map_err(runtime_transport_error)?;
            for node in inner.opened.peers.keys().copied() {
                if node != inner.opened.config.node_id() {
                    if let Err(error) = round.refresh(node).await {
                        if Instant::now() >= deadline {
                            return Err(RuntimeError::Deadline);
                        }
                        if !matches!(
                            error,
                            transport::Error::Io
                                | transport::Error::Refused
                                | transport::Error::Deadline
                        ) {
                            return Err(runtime_transport_error(error));
                        }
                    }
                }
            }
            let prepared = round
                .prepare_for_publication(&inner.raft)
                .await
                .map_err(runtime_transport_error)?;
            let command = prepared.command().clone();
            let fingerprint = command.fingerprint().ok_or(RuntimeError::Refused)?;
            save(
                inner.clone(),
                operation.clone(),
                Payload::Prepared {
                    command,
                    fingerprint,
                },
            )
            .await?;
            prepared
        }
    };
    remaining(deadline)?;
    leader_only(&inner)?;
    let result = prepared
        .submit(&inner.raft)
        .await
        .map_err(runtime_transport_error);
    inner.opened.verify()?;
    result
}

impl RecoveryRuntime {
    /// Bounded local restart inventory. Phase names describe journal durability,
    /// never byte availability, metadata commitment, or a writer permission.
    pub async fn publication_operations(&self) -> Result<Vec<PublicationOperation>> {
        let inner = self.inner.clone();
        self.run_job(async move {
            tokio::task::spawn_blocking(move || {
                let records = inventory(&inner.opened)?;
                Ok(records
                    .into_iter()
                    .map(|(operation_id, saved)| PublicationOperation {
                        operation_id,
                        stage: if saved.prepared.is_some() {
                            PublicationStage::Prepared
                        } else if saved.manifest.is_some() {
                            PublicationStage::Manifest
                        } else {
                            PublicationStage::Capture
                        },
                    })
                    .collect())
            })
            .await
            .map_err(|_| RuntimeError::Closed)?
        })
        .await
    }
    /// Bounded restart work list from the original journal and actual applied
    /// local control state. This neither schedules work nor proves current
    /// quorum. A stale local read may leave an already committed original on
    /// this list; retry must preserve its exact operation/command.
    pub async fn pending_publication_operations(&self) -> Result<Vec<PublicationOperation>> {
        let inner = self.inner.clone();
        self.run_job(async move {
            let deadline = Instant::now().checked_add(inner.timeout).ok_or(RuntimeError::Configuration)?;
            let owner = inner.clone();
            let records = tokio::task::spawn_blocking(move || inventory(&owner.opened))
                .await.map_err(|_| RuntimeError::Closed)??;
            let actual = inner.opened.control.control_state().await;
            let actual = checked_control_read(&inner, deadline, actual)?;
            let result = pending_originals(&inner.opened, &actual, records)?;
            remaining(deadline)?;
            Ok(result)
        }).await
    }
    /// Resynchronize only the existing original journal prefix. No file
    /// creation, source reacquisition, peer bytes, metadata or writer grant.
    pub async fn confirm_publication_intent(&self, operation_id: String) -> Result<()> {
        if !operation_valid(&operation_id) { return Err(RuntimeError::Refused); }
        let inner = self.inner.clone();
        self.run_job(async move {
            let deadline = Instant::now().checked_add(inner.timeout).ok_or(RuntimeError::Configuration)?;
            let owner = inner.clone();
            tokio::task::spawn_blocking(move || confirm_original_intent(&owner.opened, &operation_id))
                .await.map_err(|_| RuntimeError::Closed)??;
            inner.opened.verify()?;
            remaining(deadline)?;
            Ok(())
        }).await
    }
    /// Persist the original signed capture intent before a caller reports
    /// durable admission. This owns journal IO through actual completion;
    /// cancellation of the waiter cannot cancel the admitted blocking write.
    /// No archive bytes, availability ACK, metadata command or writer grant
    /// are produced. The caller must retain/revalidate its original Ready
    /// source and await actual local job completion before admitting next work.
    pub async fn record_capture_intent(
        &self,
        operation_id: String,
        context: SignedSourceContext,
    ) -> Result<()> {
        if !operation_valid(&operation_id) {
            return Err(RuntimeError::Refused);
        }
        context
            .verify(
                &self.inner.opened.control.binding().community_id,
                &self.inner.opened.source_node,
            )
            .map_err(|_| RuntimeError::Refused)?;
        let inner = self.inner.clone();
        self.run_job(async move {
            let deadline = Instant::now()
                .checked_add(inner.timeout)
                .ok_or(RuntimeError::Configuration)?;
            leader_only(&inner)?;
            remaining(deadline)?;
            save(inner.clone(), operation_id, Payload::Capture(context)).await?;
            // A failure after the durable write is indeterminate to the
            // caller. Preserve the journal and never mint a replacement ID.
            inner.opened.verify()?;
            remaining(deadline)?;
            leader_only(&inner)?;
            Ok(())
        })
        .await
    }
    /// Trusted caller retains Ready/source admission and pinned directory/name
    /// ownership. Original intent precedes ALL local and peer byte publication.
    pub async fn publish_capture_file(
        &self,
        operation_id: String,
        input: File,
        context: SignedSourceContext,
    ) -> Result<CommittedCheckpointObservation> {
        if !operation_valid(&operation_id) {
            return Err(RuntimeError::Refused);
        }
        let source = context
            .verify(
                &self.inner.opened.control.binding().community_id,
                &self.inner.opened.source_node,
            )
            .map_err(|_| RuntimeError::Refused)?;
        let inner = self.inner.clone();
        self.run_job(async move {
            let deadline = Instant::now()
                .checked_add(inner.timeout)
                .ok_or(RuntimeError::Configuration)?;
            leader_only(&inner)?;
            save(
                inner.clone(),
                operation_id.clone(),
                Payload::Capture(context),
            )
            .await?;
            // On interruption before durable manifest, reoffer these exact
            // original signed bytes. No re-encryption or changed operation ID.
            let owner = inner.clone();
            let timeout = remaining(deadline)?;
            let manifest = tokio::task::spawn_blocking(move || {
                owner.opened.verify()?;
                let result = owner
                    .opened
                    .material
                    .ingest_checkpoint_file(input, &source, ChunkingLimits { timeout })
                    .map(|(manifest, _)| manifest)
                    .map_err(|_| RuntimeError::Refused);
                owner.opened.verify()?;
                result
            })
            .await
            .map_err(|_| RuntimeError::Closed)??;
            save(
                inner.clone(),
                operation_id.clone(),
                Payload::Manifest(manifest),
            )
            .await?;
            remaining(deadline)?;
            complete(inner, operation_id, deadline).await
        })
        .await
    }
    /// After durable manifest/preparation, resume actual retained bytes and the
    /// same command, or exact committed historical readback. Never mint a retry.
    pub async fn resume_publication(
        &self,
        operation_id: String,
    ) -> Result<CommittedCheckpointObservation> {
        if !operation_valid(&operation_id) {
            return Err(RuntimeError::Refused);
        }
        let inner = self.inner.clone();
        self.run_job(async move {
            let deadline = Instant::now()
                .checked_add(inner.timeout)
                .ok_or(RuntimeError::Configuration)?;
            complete(inner, operation_id, deadline).await
        })
        .await
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublicationStage {
    Capture,
    Manifest,
    Prepared,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationOperation {
    pub operation_id: String,
    pub stage: PublicationStage,
}

#[cfg(test)]
mod tests;
