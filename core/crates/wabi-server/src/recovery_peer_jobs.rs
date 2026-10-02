//! Owned, bounded verification of an approved peer's encrypted core capture.
//! Runtime job status is deliberately not a durable recovery/activation record.
//! No recipient key, plaintext tree or writer permission is sent to a peer.
use crate::{
    config::ServerConfig,
    instance_archive::{
        restore_inactive_with_limits, verify_inactive_live, InactiveVerificationReceipt,
        LiveArchiveReceipt, RestoreLimits,
    },
};
use age::secrecy::{ExposeSecret, SecretString};
use anyhow::{ensure, Context, Result};
use fs4::fs_std::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::fd::AsRawFd,
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    task::JoinHandle,
};
use wabi_consensus::{
    material::{CheckpointManifest, MaterialKind},
    model::{RecoveryPeer, StoreBinding},
    source_context::SignedSourceContext,
    transport::{CheckpointClient, Config, Identity, Limits},
};

const HISTORY: usize = 16;
const MAX_CIPHERTEXT: u64 = 64 * 1024 * 1024;
// The supported checkpoint/Noise contract uses complete 64 KiB objects.
const MAX_OBJECT_BYTES: u64 = 64 * 1024;

/// Private operator startup input, never accepted from an HTTP request.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerVerificationPolicy {
    pub schema_version: u8,
    pub binding: StoreBinding,
    #[serde(deserialize_with = "unique_roster")]
    pub peers: BTreeMap<u64, RecoveryPeer>,
    pub identity_directory: PathBuf,
    pub recipient_identity_file: PathBuf,
    pub scratch_directory: PathBuf,
    pub candidate_directory: PathBuf,
    pub max_candidates: usize,
    pub max_candidate_bytes: u64,
    pub max_ciphertext_bytes: u64,
    pub max_plaintext_bytes: u64,
    pub max_entries: u64,
    pub min_free_bytes: u64,
    pub timeout_seconds: u64,
}

fn unique_roster<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<BTreeMap<u64, RecoveryPeer>, D::Error> {
    struct Roster;
    impl<'de> serde::de::Visitor<'de> for Roster {
        type Value = BTreeMap<u64, RecoveryPeer>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("exactly three canonical distinct peer IDs")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> std::result::Result<Self::Value, M::Error> {
            let mut peers = BTreeMap::new();
            while let Some((key, peer)) = map.next_entry::<String, RecoveryPeer>()? {
                let id = key
                    .parse::<u64>()
                    .map_err(|_| serde::de::Error::custom("invalid peer ID"))?;
                if id == 0
                    || key != id.to_string()
                    || peers.len() >= 3
                    || peers.insert(id, peer).is_some()
                {
                    return Err(serde::de::Error::custom("duplicate/noncanonical peer ID"));
                }
            }
            if peers.len() != 3 {
                return Err(serde::de::Error::custom("three peers required"));
            }
            Ok(peers)
        }
    }
    deserializer.deserialize_map(Roster)
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PeerVerificationPhase {
    Queued,
    Downloading,
    Verifying,
    CoreVerified,
    Failed,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerVerificationJob {
    pub schema_version: u8,
    pub id: String,
    pub capture_job_id: String,
    pub manifest_sha256: String,
    pub peer_node_id: u64,
    pub phase: PeerVerificationPhase,
    pub started_at_unix_ms: u64,
    pub finished_at_unix_ms: Option<u64>,
    pub receipt: Option<InactiveVerificationReceipt>,
    pub candidate_id: Option<String>,
    pub failure_code: Option<String>,
    pub full_instance_ready: bool,
    pub canonical_writer_permitted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerVerificationStatus {
    pub enabled: bool,
    pub accepting: bool,
    pub status_lifetime: &'static str,
    pub full_instance_ready: bool,
    pub canonical_writer_permitted: bool,
    pub jobs: Vec<PeerVerificationJob>,
}
impl PeerVerificationStatus {
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            accepting: false,
            status_lifetime: "current_process",
            full_instance_ready: false,
            canonical_writer_permitted: false,
            jobs: vec![],
        }
    }
}

#[derive(Debug)]
pub enum StartError {
    Busy,
    Closed,
    Refused,
}

#[derive(Default)]
struct Jobs {
    closed: bool,
    history: VecDeque<PeerVerificationJob>,
    worker: Option<JoinHandle<()>>,
}
struct Inner {
    policy: PeerVerificationPolicy,
    root: File,
    recipient: SecretString,
    transport: Arc<Config>,
    source_node: String,
    candidates: CandidateStore,
    admission: Arc<Semaphore>,
    jobs: Mutex<Jobs>,
}
#[derive(Clone)]
pub struct PeerVerificationJobs(Arc<Inner>);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn no_symlink_ancestors(path: &Path) -> Result<()> {
    ensure!(
        path.is_absolute(),
        "peer verification path must be absolute"
    );
    for path in path.ancestors() {
        ensure!(
            !fs::symlink_metadata(path)?.file_type().is_symlink(),
            "symlink input refused"
        );
    }
    Ok(())
}
fn private_directory(path: &Path) -> Result<File> {
    no_symlink_ancestors(path)?;
    let named = fs::symlink_metadata(path)?;
    ensure!(
        named.is_dir()
            && named.uid() == fs::metadata("/proc/self")?.uid()
            && named.mode() & 0o077 == 0,
        "private owned directory required"
    );
    let file = File::open(path)?;
    let held = file.metadata()?;
    ensure!(
        (held.dev(), held.ino()) == (named.dev(), named.ino()),
        "directory changed"
    );
    Ok(file)
}
fn read_private(path: &Path, limit: u64) -> Result<String> {
    no_symlink_ancestors(path)?;
    let named = fs::symlink_metadata(path)?;
    ensure!(
        named.is_file()
            && named.uid() == fs::metadata("/proc/self")?.uid()
            && named.mode() & 0o077 == 0
            && named.nlink() == 1
            && named.len() <= limit,
        "private bounded input required"
    );
    let mut file = File::open(path)?;
    let held = file.metadata()?;
    ensure!(
        (
            held.dev(),
            held.ino(),
            held.len(),
            held.mode(),
            held.uid(),
            held.nlink()
        ) == (
            named.dev(),
            named.ino(),
            named.len(),
            named.mode(),
            named.uid(),
            named.nlink()
        ),
        "private input changed"
    );
    let mut value = String::new();
    (&mut file).take(limit + 1).read_to_string(&mut value)?;
    ensure!(
        value.len() as u64 <= limit && file.metadata()?.len() == held.len(),
        "input oversized"
    );
    Ok(value)
}

struct CandidateStore {
    root: File,
    lock: File,
}
impl CandidateStore {
    fn alias(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.root.as_raw_fd()))
    }
    fn open(policy: &PeerVerificationPolicy, scratch: &File) -> Result<Self> {
        let root = private_directory(&policy.candidate_directory)?;
        ensure!(
            root.metadata()?.dev() == scratch.metadata()?.dev(),
            "candidate and scratch roots must share a filesystem"
        );
        let path = policy.candidate_directory.join(".lock");
        let before = match fs::symlink_metadata(&path) {
            Ok(m) => {
                ensure!(
                    m.is_file()
                        && m.nlink() == 1
                        && m.mode() & 0o077 == 0
                        && m.uid() == root.metadata()?.uid(),
                    "candidate lock refused"
                );
                Some(m)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.into()),
        };
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(&path)?;
        let held = lock.metadata()?;
        let named = fs::symlink_metadata(&path)?;
        ensure!(
            named.is_file()
                && named.nlink() == 1
                && named.mode() & 0o077 == 0
                && named.uid() == root.metadata()?.uid()
                && (named.dev(), named.ino()) == (held.dev(), held.ino()),
            "candidate lock changed"
        );
        if let Some(before) = before {
            ensure!(
                (before.dev(), before.ino()) == (held.dev(), held.ino()),
                "candidate lock replaced"
            );
        }
        ensure!(
            FileExt::try_lock_exclusive(&lock)?,
            "candidate store already owned"
        );
        let store = Self { root, lock };
        store.reserve(policy)?;
        Ok(store)
    }
    fn verify(&self, policy: &PeerVerificationPolicy) -> Result<()> {
        let named = fs::symlink_metadata(&policy.candidate_directory)?;
        let held = self.root.metadata()?;
        ensure!(
            named.is_dir()
                && !named.file_type().is_symlink()
                && named.mode() & 0o077 == 0
                && named.uid() == held.uid()
                && (named.dev(), named.ino()) == (held.dev(), held.ino()),
            "candidate root changed"
        );
        let named = fs::symlink_metadata(self.alias().join(".lock"))?;
        let held = self.lock.metadata()?;
        ensure!(
            named.is_file()
                && named.nlink() == 1
                && named.mode() & 0o077 == 0
                && (named.dev(), named.ino()) == (held.dev(), held.ino()),
            "candidate lock changed"
        );
        Ok(())
    }
    fn usage(&self, policy: &PeerVerificationPolicy) -> Result<(usize, u64)> {
        self.verify(policy)?;
        let mut count = 0usize;
        let mut bytes = 0u64;
        let mut entries = 0u64;
        for item in fs::read_dir(self.alias())? {
            let item = item?;
            let name = item.file_name();
            let name = name.to_str().context("invalid candidate name")?;
            if name == ".lock" {
                continue;
            }
            let id = name.strip_prefix(".staging-").unwrap_or(name);
            ensure!(
                id.len() == 32
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
                "foreign candidate entry"
            );
            count += 1;
            ensure!(count <= policy.max_candidates, "candidate count exhausted");
            let mut pending = vec![item.path()];
            while let Some(path) = pending.pop() {
                entries = entries.checked_add(1).context("candidate entry overflow")?;
                ensure!(
                    entries <= (policy.max_entries + 16) * policy.max_candidates as u64,
                    "candidate scan budget exhausted"
                );
                let m = fs::symlink_metadata(&path)?;
                ensure!(
                    !m.file_type().is_symlink()
                        && m.uid() == self.root.metadata()?.uid()
                        && m.mode() & 0o077 == 0,
                    "candidate private shape changed"
                );
                if m.is_dir() {
                    for item in fs::read_dir(path)? {
                        pending.push(item?.path());
                    }
                } else {
                    ensure!(
                        m.is_file() && m.nlink() == 1,
                        "candidate file shape refused"
                    );
                    bytes = bytes
                        .checked_add(m.len())
                        .context("candidate bytes overflow")?;
                    ensure!(
                        bytes <= policy.max_candidate_bytes,
                        "candidate storage exhausted"
                    );
                }
            }
        }
        Ok((count, bytes))
    }
    fn reserve(&self, policy: &PeerVerificationPolicy) -> Result<()> {
        let (count, used) = self.usage(policy)?;
        let reserve = policy
            .max_ciphertext_bytes
            .checked_add(policy.max_plaintext_bytes)
            .and_then(|n| n.checked_add(2 * 1024 * 1024))
            .context("candidate reserve overflow")?;
        ensure!(
            count < policy.max_candidates
                && used
                    .checked_add(reserve)
                    .is_some_and(|n| n <= policy.max_candidate_bytes),
            "candidate reserve exhausted"
        );
        ensure!(
            fs4::available_space(self.alias())?
                >= reserve
                    .checked_add(policy.min_free_bytes)
                    .context("candidate free-space reserve overflow")?,
            "candidate disk headroom"
        );
        Ok(())
    }
    fn publish(
        &self,
        policy: &PeerVerificationPolicy,
        job: &PeerVerificationJob,
        scratch: &Scratch,
        manifest: &CheckpointManifest,
        source: &LiveArchiveReceipt,
        receipt: &InactiveVerificationReceipt,
    ) -> Result<()> {
        self.reserve(policy)?;
        let root = self.alias();
        let stage = root.join(format!(".staging-{}", job.id));
        let target = root.join(&job.id);
        ensure!(
            fs::symlink_metadata(&target).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
            "candidate ID already exists"
        );
        fs::create_dir(&stage)?;
        fs::set_permissions(&stage, fs::Permissions::from_mode(0o700))?;
        // Partial publication stays private, fenced, quota-charged and visible
        // as staging. It is never silently deleted or treated as a ready writer.
        fs::rename(scratch.path("inactive"), stage.join("inactive"))?;
        fs::rename(scratch.path("peer.age"), stage.join("capture.age"))?;
        let record = serde_json::to_vec_pretty(&serde_json::json!({
            "schemaVersion":1,"scope":"historical_inactive_core_candidate",
            "candidateId":job.id,"captureJobId":job.capture_job_id,"peerNodeId":job.peer_node_id,
            "manifestSha256":job.manifest_sha256,"manifest":manifest,"sourceReceipt":source,
            "verification":receipt,"fullInstanceReady":false,"canonicalWriterPermitted":false
        }))?;
        ensure!(record.len() <= 256 * 1024, "candidate record oversized");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(stage.join("candidate.json"))?;
        file.write_all(&record)?;
        file.sync_all()?;
        // Sync every retained file/directory before publishing the candidate ID.
        let mut pending = vec![stage.clone()];
        let mut directories = vec![];
        while let Some(path) = pending.pop() {
            let m = fs::symlink_metadata(&path)?;
            ensure!(!m.file_type().is_symlink(), "candidate sync shape changed");
            if m.is_dir() {
                directories.push(path.clone());
                for item in fs::read_dir(path)? {
                    pending.push(item?.path());
                }
            } else {
                ensure!(m.is_file(), "candidate sync file refused");
                File::open(path)?.sync_all()?;
            }
        }
        for directory in directories.into_iter().rev() {
            File::open(directory)?.sync_all()?;
        }
        self.usage(policy)?;
        fs::rename(stage, &target)?;
        self.root.sync_all()?;
        self.verify(policy)?;
        Ok(())
    }
}

impl PeerVerificationJobs {
    pub fn from_environment(config: &ServerConfig, source_enabled: bool) -> Result<Option<Self>> {
        let Some(path) = std::env::var_os("WABI_CHECKPOINT_PEER_VERIFY_CONFIG") else {
            return Ok(None);
        };
        ensure!(
            source_enabled,
            "peer verification requires signed checkpoint sources"
        );
        let policy = serde_json::from_str(&read_private(Path::new(&path), 64 * 1024)?)?;
        Ok(Some(Self::open(policy, config)?))
    }

    pub fn open(mut policy: PeerVerificationPolicy, config: &ServerConfig) -> Result<Self> {
        ensure!(
            policy.schema_version == 1
                && policy.max_ciphertext_bytes > 0
                && policy.max_ciphertext_bytes <= MAX_CIPHERTEXT
                && policy.max_plaintext_bytes > 0
                && policy.max_plaintext_bytes <= MAX_CIPHERTEXT
                && (4..=10_000).contains(&policy.max_entries)
                && policy.min_free_bytes > 0
                && (1..=128).contains(&policy.max_candidates)
                && policy.max_candidate_bytes > 0
                && policy.max_candidate_bytes <= 1024 * 1024 * 1024
                && (1..=300).contains(&policy.timeout_seconds),
            "invalid peer verification bounds"
        );
        let root = private_directory(&policy.scratch_directory)?;
        policy.scratch_directory = fs::canonicalize(&policy.scratch_directory)?;
        // Never silently adopt/delete leftovers from an interrupted owner.
        ensure!(
            fs::read_dir(&policy.scratch_directory)?.next().is_none(),
            "unresolved scratch entries require operator inspection"
        );
        private_directory(&policy.candidate_directory)?;
        policy.candidate_directory = fs::canonicalize(&policy.candidate_directory)?;
        ensure!(
            !policy
                .scratch_directory
                .starts_with(&policy.candidate_directory)
                && !policy
                    .candidate_directory
                    .starts_with(&policy.scratch_directory),
            "candidate/scratch overlap"
        );
        for protected in [&config.data_dir, &config.uploads_dir] {
            let protected = fs::canonicalize(protected)?;
            ensure!(
                !policy.scratch_directory.starts_with(&protected)
                    && !protected.starts_with(&policy.scratch_directory)
                    && !policy.candidate_directory.starts_with(&protected)
                    && !protected.starts_with(&policy.candidate_directory),
                "scratch overlaps live state"
            );
        }
        // Explicit preexisting Noise identity; never derive a peer key from a member token.
        private_directory(&policy.identity_directory)?;
        let identity = Arc::new(
            Identity::load(&policy.identity_directory)
                .map_err(|_| anyhow::anyhow!("peer identity unavailable"))?,
        );
        let transport = Arc::new(
            Config::new(
                policy.binding.clone(),
                policy.peers.clone(),
                identity,
                Limits::default(),
            )
            .map_err(|_| anyhow::anyhow!("approved three-peer roster refused"))?,
        );
        let recipient: SecretString = read_private(&policy.recipient_identity_file, 4096)?.into();
        recipient
            .expose_secret()
            .trim()
            .parse::<age::x25519::Identity>()
            .map_err(|_| anyhow::anyhow!("recipient identity unavailable"))?;
        ensure!(
            wabi_consensus::model::identifier_valid(&config.node_id),
            "invalid source node"
        );
        let candidates = CandidateStore::open(&policy, &root)?;
        Ok(Self(Arc::new(Inner {
            policy,
            root,
            recipient,
            transport,
            source_node: config.node_id.clone(),
            candidates,
            admission: Arc::new(Semaphore::new(1)),
            jobs: Mutex::new(Jobs::default()),
        })))
    }

    pub fn status(&self) -> PeerVerificationStatus {
        let jobs = self.0.jobs.lock().unwrap_or_else(|e| e.into_inner());
        PeerVerificationStatus {
            enabled: true,
            accepting: !jobs.closed,
            status_lifetime: "current_process",
            full_instance_ready: false,
            canonical_writer_permitted: false,
            jobs: jobs.history.iter().cloned().collect(),
        }
    }

    /// Called only after CheckpointJobs verifies the persisted ready capture.
    /// A request selects an enrolled peer and digest, never a path, key or ACK.
    pub(crate) fn start(
        &self,
        capture_job_id: String,
        peer_node_id: u64,
        manifest_sha256: String,
        context: SignedSourceContext,
        source: LiveArchiveReceipt,
        actual_community: &str,
    ) -> std::result::Result<PeerVerificationJob, StartError> {
        if actual_community != self.0.policy.binding.community_id
            || !digest_valid(&manifest_sha256)
            || context
                .verify(actual_community, &self.0.source_node)
                .is_err()
            || !source_matches(&context, &source, &self.0.policy)
        {
            return Err(StartError::Refused);
        }
        let peer = CheckpointClient::new(
            self.0.transport.clone(),
            peer_node_id,
            self.0.source_node.clone(),
        )
        .map_err(|_| StartError::Refused)?;
        let mut jobs = self.0.jobs.lock().unwrap_or_else(|e| e.into_inner());
        if jobs.closed {
            return Err(StartError::Closed);
        }
        if jobs
            .worker
            .as_ref()
            .is_some_and(|worker| !worker.is_finished())
        {
            return Err(StartError::Busy);
        }
        let permit = self
            .0
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| StartError::Busy)?;
        let job = PeerVerificationJob {
            schema_version: 1,
            id: uuid::Uuid::new_v4().simple().to_string(),
            capture_job_id,
            manifest_sha256,
            peer_node_id,
            phase: PeerVerificationPhase::Queued,
            started_at_unix_ms: now_ms(),
            finished_at_unix_ms: None,
            receipt: None,
            candidate_id: None,
            failure_code: None,
            full_instance_ready: false,
            canonical_writer_permitted: false,
        };
        if jobs.history.len() == HISTORY {
            jobs.history.pop_front();
        }
        jobs.history.push_back(job.clone());
        let manager = self.clone();
        let running = job.clone();
        // The caller does not own this task. Started blocking work also owns
        // its scratch/admission until completion; shutdown drains both layers.
        jobs.worker = Some(tokio::spawn(async move {
            let worker_manager = manager.clone();
            let worker_job = running.clone();
            let result = tokio::spawn(async move {
                execute(worker_manager, worker_job, peer, context, source, permit).await
            })
            .await;
            let outcome = match result {
                Ok(result) => result,
                Err(_) => Err("worker_interrupted"),
            };
            let mut jobs = manager.0.jobs.lock().unwrap_or_else(|e| e.into_inner());
            if matches!(
                outcome,
                Err("scratch_unavailable"
                    | "scratch_cleanup_failed"
                    | "scratch_owner_still_active"
                    | "worker_interrupted")
            ) {
                jobs.closed = true;
            }
            if let Some(job) = jobs.history.iter_mut().find(|job| job.id == running.id) {
                job.finished_at_unix_ms = Some(now_ms());
                match outcome {
                    Ok(receipt) => {
                        job.phase = PeerVerificationPhase::CoreVerified;
                        job.receipt = Some(receipt);
                        job.candidate_id = Some(job.id.clone());
                    }
                    Err(code) => {
                        job.phase = PeerVerificationPhase::Failed;
                        job.failure_code = Some(code.into());
                    }
                }
            }
        }));
        Ok(job)
    }

    pub async fn shutdown(&self) {
        let worker = {
            let mut jobs = self.0.jobs.lock().unwrap_or_else(|e| e.into_inner());
            jobs.closed = true;
            jobs.worker.take()
        };
        if let Some(worker) = worker {
            let _ = worker.await;
        }
        // Also drain an IO owner surviving an interrupted async worker. Closing
        // the semaphore would make this check return before its permit is free.
        if let Ok(permit) = self.0.admission.clone().acquire_owned().await {
            drop(permit);
        }
    }
    fn phase(&self, id: &str, phase: PeerVerificationPhase) {
        if let Some(job) = self
            .0
            .jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .history
            .iter_mut()
            .find(|job| job.id == id)
        {
            job.phase = phase;
        }
    }
}

fn source_matches(
    context: &SignedSourceContext,
    source: &LiveArchiveReceipt,
    policy: &PeerVerificationPolicy,
) -> bool {
    let c = &context.claims;
    source.schema_version == 1
        && !source.full_instance_ready
        && source.ciphertext_bytes > 0
        && source.ciphertext_bytes <= policy.max_ciphertext_bytes
        && source.plaintext_file_bytes <= policy.max_plaintext_bytes
        && source.file_count.saturating_add(source.directory_count) <= policy.max_entries
        && source.encrypted_archive_sha256 == c.archive_sha256
        && source.inventory_sha256 == c.inventory_sha256
        && source.ciphertext_bytes == c.ciphertext_bytes
        && source.applied_commit_seq == c.applied_commit_seq
        && source.commit_prefix_fingerprint == c.commit_prefix_fingerprint
}
fn validate_manifest(
    manifest: &CheckpointManifest,
    context: &SignedSourceContext,
    policy: &PeerVerificationPolicy,
) -> bool {
    manifest.schema_version == 2
        && &manifest.source == context
        && manifest.partition_id == policy.binding.partition_id
        && !manifest.objects.is_empty()
        && manifest.objects.len() <= 1024
        && manifest.objects.iter().all(|o| {
            o.kind == MaterialKind::CheckpointChunk
                && o.bytes > 0
                && o.bytes <= MAX_OBJECT_BYTES
                && digest_valid(&o.sha256)
        })
        && manifest
            .objects
            .iter()
            .try_fold(0u64, |n, o| n.checked_add(o.bytes))
            == Some(context.claims.ciphertext_bytes)
}
struct Scratch {
    directory: tempfile::TempDir,
    _permit: OwnedSemaphorePermit,
    _root: File,
}
impl Scratch {
    fn close(self) -> Result<()> {
        // Capture/consume the whole owner. With disjoint closure captures,
        // moving only `directory` could drop its descriptor alias before close.
        let Self {
            directory,
            _permit,
            _root,
        } = self;
        let path = directory.path().to_path_buf();
        directory.close()?;
        ensure!(!path.exists(), "scratch retained");
        drop(_root);
        drop(_permit);
        Ok(())
    }
    fn path(&self, name: &str) -> PathBuf {
        self.directory.path().join(name)
    }
    fn create(manager: &Inner, permit: OwnedSemaphorePermit) -> Result<Self> {
        let named = fs::symlink_metadata(&manager.policy.scratch_directory)?;
        let held = manager.root.metadata()?;
        ensure!(
            named.is_dir()
                && !named.file_type().is_symlink()
                && named.mode() & 0o077 == 0
                && named.uid() == held.uid()
                && (named.dev(), named.ino()) == (held.dev(), held.ino()),
            "scratch changed"
        );
        let reserve = manager
            .policy
            .max_ciphertext_bytes
            .checked_add(manager.policy.max_plaintext_bytes)
            .and_then(|n| n.checked_add(manager.policy.min_free_bytes))
            .context("reserve overflow")?;
        ensure!(
            fs4::available_space(&manager.policy.scratch_directory)? >= reserve,
            "scratch disk budget"
        );
        manager.candidates.reserve(&manager.policy)?;
        // Keep a descriptor alias alive through cleanup so a renamed/replaced
        // configured path cannot redirect temporary files into live state.
        let root = manager.root.try_clone()?;
        let pinned = PathBuf::from(format!("/proc/self/fd/{}", root.as_raw_fd()));
        let directory = tempfile::Builder::new()
            .prefix("wabi-peer-verify-")
            .tempdir_in(&pinned)?;
        let scratch = Self {
            directory,
            _permit: permit,
            _root: root,
        };
        let construction = (|| -> Result<()> {
            fs::set_permissions(scratch.directory.path(), fs::Permissions::from_mode(0o700))?;
            for (name, bytes) in [
                ("peer.age", b"".as_slice()),
                (
                    "recipient.txt",
                    manager.recipient.expose_secret().as_bytes(),
                ),
            ] {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(scratch.path(name))?;
                file.write_all(bytes)?;
                file.sync_all()?;
            }
            Ok(())
        })();
        if let Err(error) = construction {
            // Attempt and verify rollback while the descriptor/permit remain
            // owned. A construction failure still poisons admission; startup
            // refuses any remaining entry rather than blindly deleting it.
            scratch
                .close()
                .context("scratch construction cleanup failed")?;
            return Err(error);
        }
        Ok(scratch)
    }
}

async fn allocate_scratch(
    manager: Arc<Inner>,
    permit: OwnedSemaphorePermit,
    deadline: tokio::time::Instant,
) -> std::result::Result<Arc<Scratch>, &'static str> {
    if tokio::time::Instant::now() >= deadline {
        return Err("verification_deadline");
    }
    let mut worker = tokio::task::spawn_blocking(move || Scratch::create(&manager, permit));
    let (result, expired) = match tokio::time::timeout_at(deadline, &mut worker).await {
        Ok(result) => (result, false),
        // Retain the actual returned owner: dropping a late Scratch value
        // would make implicit TempDir cleanup failures unobservable.
        Err(_) => (worker.await, true),
    };
    let scratch = result
        .map_err(|_| "worker_interrupted")?
        .map_err(|_| "scratch_unavailable")?;
    if expired || tokio::time::Instant::now() >= deadline {
        let cleanup = tokio::task::spawn_blocking(move || scratch.close()).await;
        if !matches!(cleanup, Ok(Ok(()))) {
            return Err("scratch_cleanup_failed");
        }
        return Err("verification_deadline");
    }
    Ok(Arc::new(scratch))
}
async fn blocking<T: Send + 'static>(
    deadline: tokio::time::Instant,
    work: impl FnOnce() -> Result<T> + Send + 'static,
    code: &'static str,
) -> std::result::Result<T, &'static str> {
    let mut handle = tokio::task::spawn_blocking(work);
    match tokio::time::timeout_at(deadline, &mut handle).await {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(_) => Err(code),
        Err(_) => {
            let _ = handle.await;
            Err("verification_deadline")
        }
    }
}
async fn execute(
    manager: PeerVerificationJobs,
    job: PeerVerificationJob,
    peer: CheckpointClient,
    context: SignedSourceContext,
    source: LiveArchiveReceipt,
    permit: OwnedSemaphorePermit,
) -> std::result::Result<InactiveVerificationReceipt, &'static str> {
    let deadline =
        tokio::time::Instant::now() + Duration::from_secs(manager.0.policy.timeout_seconds);
    manager.phase(&job.id, PeerVerificationPhase::Downloading);
    let manifest = tokio::time::timeout_at(deadline, peer.read_manifest(&job.manifest_sha256))
        .await
        .map_err(|_| "verification_deadline")?
        .map_err(|_| "peer_manifest_unavailable")?;
    if !validate_manifest(&manifest, &context, &manager.0.policy) {
        return Err("peer_source_mismatch");
    }
    let ack = tokio::time::timeout_at(deadline, peer.fresh_receipt(&manifest))
        .await
        .map_err(|_| "verification_deadline")?
        .map_err(|_| "peer_bytes_unavailable")?;
    if ack.target_node_id() != job.peer_node_id {
        return Err("peer_identity_mismatch");
    }
    let scratch = allocate_scratch(manager.0.clone(), permit, deadline).await?;
    let outcome = download_and_verify(
        &manager,
        &job,
        &peer,
        &context,
        &manifest,
        source.clone(),
        &scratch,
        deadline,
    )
    .await;
    let outcome = match outcome {
        Ok(receipt) => {
            let publisher = manager.0.clone();
            let owner = scratch.clone();
            let published_job = job.clone();
            let published_receipt = receipt.clone();
            let manifest = manifest.clone();
            blocking(
                deadline,
                move || {
                    fs::remove_file(owner.path("recipient.txt"))?;
                    publisher.candidates.publish(
                        &publisher.policy,
                        &published_job,
                        &owner,
                        &manifest,
                        &source,
                        &published_receipt,
                    )?;
                    Ok(published_receipt)
                },
                "candidate_publication_indeterminate",
            )
            .await
        }
        Err(code) => Err(code),
    };
    let scratch = Arc::try_unwrap(scratch).map_err(|_| "scratch_owner_still_active")?;
    // Cleanup runs after negative outcomes too. Its owned worker must finish,
    // even after the transfer deadline, before admission can be reused.
    let cleanup = tokio::task::spawn_blocking(move || scratch.close()).await;
    if !matches!(cleanup, Ok(Ok(()))) {
        return Err("scratch_cleanup_failed");
    }
    if tokio::time::Instant::now() >= deadline {
        return Err("verification_deadline");
    }
    outcome
}

async fn download_and_verify(
    manager: &PeerVerificationJobs,
    job: &PeerVerificationJob,
    peer: &CheckpointClient,
    context: &SignedSourceContext,
    manifest: &CheckpointManifest,
    source: LiveArchiveReceipt,
    scratch: &Arc<Scratch>,
    deadline: tokio::time::Instant,
) -> std::result::Result<InactiveVerificationReceipt, &'static str> {
    let mut hash = Sha256::new();
    let mut downloaded = 0u64;
    // Keep the same authenticated manifest through download and publication.
    for index in 0..manifest.objects.len() {
        let bytes = tokio::time::timeout_at(deadline, peer.read_object(manifest, index))
            .await
            .map_err(|_| "verification_deadline")?
            .map_err(|_| "peer_object_unavailable")?;
        downloaded = downloaded
            .checked_add(bytes.len() as u64)
            .ok_or("peer_bytes_oversized")?;
        if downloaded > context.claims.ciphertext_bytes {
            return Err("peer_bytes_oversized");
        }
        hash.update(&bytes);
        let owner = scratch.clone();
        blocking(
            deadline,
            move || {
                let mut file = OpenOptions::new()
                    .append(true)
                    .open(owner.path("peer.age"))?;
                file.write_all(&bytes)?;
                Ok(())
            },
            "scratch_write_failed",
        )
        .await?;
    }
    if downloaded != context.claims.ciphertext_bytes
        || hex::encode(hash.finalize()) != context.claims.archive_sha256
    {
        return Err("peer_archive_mismatch");
    }
    manager.phase(&job.id, PeerVerificationPhase::Verifying);
    let owner = scratch.clone();
    let policy = manager.0.policy.clone();
    let receipt = blocking(
        deadline,
        move || {
            File::open(owner.path("peer.age"))?.sync_all()?;
            let remaining = || deadline.saturating_duration_since(tokio::time::Instant::now());
            ensure!(!remaining().is_zero(), "verification deadline");
            let archive = owner.path("peer.age");
            let identity = owner.path("recipient.txt");
            let inactive = owner.path("inactive");
            restore_inactive_with_limits(
                &archive,
                &identity,
                &inactive,
                RestoreLimits {
                    max_entries: policy.max_entries,
                    max_plaintext_bytes: policy.max_plaintext_bytes,
                    max_path_bytes: 1024 * 1024,
                    timeout: remaining(),
                },
                Some(&source.encrypted_archive_sha256),
            )?;
            // Live capture intentionally omits the process lock. Create only
            // this newly restored, owned inactive lock with private mode before
            // the ordinary stopped verifier can create it with its default mode.
            // Existing/symlink/replaced locks refuse; never unlink or chmod one.
            let lock_path = inactive.join("data/wabidb/.lock");
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&lock_path)?;
            lock.sync_all()?;
            File::open(lock_path.parent().context("inactive lock parent")?)?.sync_all()?;
            let lock_identity = lock.metadata()?;
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let receipt = runtime.block_on(verify_inactive_live(
                &inactive,
                &source,
                &archive,
                &identity,
                wabidb::engine::offline_inspect::InspectionLimits {
                    max_entries: policy.max_entries,
                    max_file_bytes: policy.max_plaintext_bytes,
                    timeout: remaining(),
                    ..Default::default()
                },
            ))?;
            let lock_after = fs::symlink_metadata(&lock_path)?;
            ensure!(
                lock_after.is_file()
                    && lock_after.nlink() == 1
                    && lock_after.mode() & 0o077 == 0
                    && (lock_after.dev(), lock_after.ino())
                        == (lock_identity.dev(), lock_identity.ino()),
                "inactive lock changed during verification"
            );
            ensure!(
                receipt.result == "PASS"
                    && receipt.support_profile == "inactive-live-core-complete-history-v1"
                    && receipt.source_receipt_matched
                    && receipt.inactive_guards_preserved
                    && receipt.active_bundle_keys_match
                    && !receipt.full_instance_ready
                    && !receipt.external_state_verified,
                "inactive core verification refused"
            );
            Ok(receipt)
        },
        "inactive_verification_refused",
    )
    .await?;
    Ok(receipt)
}
