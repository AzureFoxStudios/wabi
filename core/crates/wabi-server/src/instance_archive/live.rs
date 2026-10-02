//! Frozen core-instance archive lane. All file I/O is owned by the checkpoint
//! blocking task. This is not a promotion certificate or external-store backup.
use super::*;
use std::time::{Duration, Instant};

pub(super) const LIVE_MAGIC: &[u8] = b"WABI-INSTANCE-SNAPSHOT-V2\n";
const MAX_HEADER_BYTES: usize = 1024 * 1024;
const FOOTER_MAGIC: &[u8] = b"WABI-CHECKPOINT-INVENTORY-V1\n";
pub(super) const LIVE_MARKER: &str = wabidb::engine::LIVE_CHECKPOINT_MARKER;
const LEGACY_RUNTIME_PATHS: &[&str] = &["data/.lock", "data/wabidb/.lock", "data/tailcat/addr.txt"];
pub(crate) const LIVE_RUNTIME_PATHS: &[&str] = &[
    "data/.lock",
    "data/wabidb/.lock",
    "data/.wabi-secret-publication.lock",
    "data/wabidb/.wabi-secret-publication.lock",
    "data/tailcat/addr.txt",
];
const SKIPPED: &[&str] = &[
    "data/.lock",
    "data/wabidb/.lock",
    "data/.wabi-secret-publication.lock",
    "data/wabidb/.wabi-secret-publication.lock",
    "data/tailcat/addr.txt",
    "data/jwt_secret",
    "data/wabidb/root_key",
];

// Configuration includes secrets: never derive Debug or return this through
// a diagnostic/status endpoint. It exists only in the encrypted archive and
// the private inactive restore directory.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveCheckpointMetadata {
    pub schema_version: u8,
    pub captured_at_unix_ms: u64,
    pub applied_commit_seq: u64,
    pub commit_prefix_fingerprint: String,
    pub bootstrap_fingerprint: String,
    pub node_id: String,
    pub server_config: serde_json::Value,
    pub excluded_runtime_paths: Vec<String>,
    pub active_key_substitutions: Vec<String>,
    pub external_state_verified: bool,
    pub full_instance_ready: bool,
}

#[derive(Clone, Debug)]
pub struct LiveExportLimits {
    pub max_entries: u64,
    pub max_plaintext_bytes: u64,
    pub max_inventory_path_bytes: u64,
    pub copy_timeout: Duration,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LiveArchiveReceipt {
    pub schema_version: u8,
    pub applied_commit_seq: u64,
    pub commit_prefix_fingerprint: String,
    pub file_count: u64,
    pub directory_count: u64,
    pub plaintext_file_bytes: u64,
    pub ciphertext_bytes: u64,
    pub inventory_sha256: String,
    pub encrypted_archive_sha256: String,
    pub full_instance_ready: bool,
}

pub(crate) struct FrozenExport<'a> {
    pub data: &'a Path,
    pub uploads: &'a Path,
    pub jwt_secret: &'a str,
    pub root_key: &'a [u8; 32],
    pub metadata: LiveCheckpointMetadata,
}

struct Budget {
    deadline: Instant,
    limits: LiveExportLimits,
}
impl Budget {
    fn new(limits: LiveExportLimits) -> Result<Self> {
        if limits.copy_timeout.is_zero()
            || limits.max_entries < 4
            || limits.max_entries > MAX_ENTRIES
            || limits.max_plaintext_bytes == 0
            || limits.max_inventory_path_bytes == 0
        {
            bail!("invalid live checkpoint resource limits");
        }
        let deadline = Instant::now()
            .checked_add(limits.copy_timeout)
            .context("live checkpoint copy timeout is out of range")?;
        Ok(Self { deadline, limits })
    }
    fn check(&self) -> Result<()> {
        if Instant::now() >= self.deadline {
            bail!("live checkpoint copy deadline elapsed");
        }
        Ok(())
    }
}

struct PrivateOutput {
    temporary: PathBuf,
    output: PathBuf,
    created: bool,
    published: bool,
    complete: bool,
}
impl Drop for PrivateOutput {
    fn drop(&mut self) {
        if self.created {
            let _ = fs::remove_file(&self.temporary);
        }
        if self.published && !self.complete {
            let _ = fs::remove_file(&self.output);
            let _ = sync_parent(&self.output);
        }
    }
}

struct CiphertextWriter<'a> {
    file: &'a mut File,
    hash: Sha256,
    bytes: u64,
}
impl Write for CiphertextWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let count = self.file.write(bytes)?;
        self.hash.update(&bytes[..count]);
        self.bytes += count as u64;
        Ok(count)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

#[derive(Default)]
pub(super) struct Inventory {
    hash: Sha256,
    files: u64,
    directories: u64,
    bytes: u64,
}
impl Inventory {
    pub(super) fn entry(&mut self, name: &str, directory: bool, size: u64, digest: &[u8; 32]) {
        self.hash.update([if directory { 0 } else { 1 }]);
        self.hash.update((name.len() as u64).to_le_bytes());
        self.hash.update(name.as_bytes());
        self.hash.update(size.to_le_bytes());
        self.hash.update(digest);
        if directory {
            self.directories += 1;
        } else {
            self.files += 1;
            self.bytes += size;
        }
    }
    fn footer(&self) -> Vec<u8> {
        let mut bytes = FOOTER_MAGIC.to_vec();
        bytes.extend_from_slice(&self.files.to_le_bytes());
        bytes.extend_from_slice(&self.directories.to_le_bytes());
        bytes.extend_from_slice(&self.bytes.to_le_bytes());
        bytes.extend_from_slice(&self.hash.clone().finalize());
        bytes
    }
    pub(super) fn verify_footer(&self, reader: &mut impl Read) -> Result<()> {
        let expected = self.footer();
        let mut actual = vec![0u8; expected.len()];
        reader.read_exact(&mut actual)?;
        if actual != expected {
            bail!("live checkpoint inventory footer mismatch");
        }
        Ok(())
    }

    fn matches_receipt(&self, receipt: &LiveArchiveReceipt) -> bool {
        self.files == receipt.file_count
            && self.directories == receipt.directory_count
            && self.bytes == receipt.plaintext_file_bytes
            && hex::encode(self.hash.clone().finalize()) == receipt.inventory_sha256
    }
}

/// Reconstruct the exact V2 source inventory after inactive restore. Runtime
/// files, the two new destination guards and root-level inspection metadata do
/// not belong to the archived roots. Active keys retain their final export order.
pub(super) fn verify_source_inventory(
    data: &Path,
    uploads: &Path,
    receipt: &LiveArchiveReceipt,
    limits: LiveExportLimits,
) -> Result<()> {
    let budget = Budget::new(limits)?;
    let mut inventory = Inventory::default();
    for entry in collect(data, uploads, uploads.starts_with(data), &budget)? {
        if matches!(entry.archive_path.as_str(),
            "data/wabidb/writer-fenced-v1" | "data/wabidb/live-checkpoint-v1") {
            continue;
        }
        let digest = if entry.is_dir { [0u8; 32] } else {
            file_digest(&entry, None, &budget)?
        };
        inventory.entry(&entry.archive_path, entry.is_dir, entry.size, &digest);
    }
    for (name, path) in [
        ("data/jwt_secret", data.join("jwt_secret")),
        ("data/wabidb/root_key", data.join("wabidb/root_key")),
    ] {
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            bail!("source inventory active key is not a regular file");
        }
        let entry = Entry { archive_path: name.into(), source_path: path,
            is_dir: false, size: metadata.len(), modified: metadata.modified().ok() };
        let digest = file_digest(&entry, None, &budget)?;
        inventory.entry(name, false, entry.size, &digest);
    }
    if !inventory.matches_receipt(receipt) {
        bail!("inactive restore differs from the authenticated source inventory");
    }
    Ok(())
}

fn collect(data: &Path, uploads: &Path, embedded: bool, budget: &Budget) -> Result<Vec<Entry>> {
    let mut pending = vec![(data.to_owned(), "data".to_owned())];
    if !embedded {
        pending.push((uploads.to_owned(), "uploads".to_owned()));
    }
    let mut entries = Vec::new();
    let mut path_bytes = pending
        .iter()
        .map(|(_, name)| name.len() as u64)
        .sum::<u64>()
        + "data/jwt_secret".len() as u64
        + "data/wabidb/root_key".len() as u64;
    if path_bytes > budget.limits.max_inventory_path_bytes {
        bail!("live checkpoint inventory path budget exceeded");
    }
    let mut file_bytes = 0u64;
    while let Some((path, name)) = pending.pop() {
        budget.check()?;
        if SKIPPED.contains(&name.as_str()) {
            continue;
        }
        validate_relative(&name, !embedded)?;
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
            bail!(
                "live checkpoint source contains an unsupported file: {}",
                path.display()
            );
        }
        if !metadata.is_dir() {
            file_bytes = file_bytes
                .checked_add(metadata.len())
                .context("file size overflow")?;
            if file_bytes > budget.limits.max_plaintext_bytes {
                bail!("live checkpoint plaintext byte budget exceeded");
            }
        }
        if entries.len() as u64 >= budget.limits.max_entries {
            bail!("live checkpoint entry budget exceeded");
        }
        if metadata.is_dir() {
            for child in fs::read_dir(&path)? {
                budget.check()?;
                let child = child?;
                let file_name = child
                    .file_name()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("checkpoint path is not UTF-8"))?;
                let child_name = format!("{name}/{file_name}");
                if SKIPPED.contains(&child_name.as_str()) {
                    continue;
                }
                validate_relative(&child_name, !embedded)?;
                path_bytes = path_bytes
                    .checked_add(child_name.len() as u64)
                    .context("inventory size overflow")?;
                if path_bytes > budget.limits.max_inventory_path_bytes {
                    bail!("live checkpoint inventory path budget exceeded");
                }
                // Current node, next child and the two active key entries are
                // included before growing the pending queue.
                if (entries.len() + pending.len() + 4) as u64 > budget.limits.max_entries {
                    bail!("live checkpoint entry budget exceeded");
                }
                pending.push((child.path(), child_name));
            }
        }
        entries.push(Entry {
            archive_path: name,
            source_path: path,
            is_dir: metadata.is_dir(),
            size: if metadata.is_dir() { 0 } else { metadata.len() },
            modified: if metadata.is_dir() {
                None
            } else {
                metadata.modified().ok()
            },
        });
    }
    entries.sort_by(|a, b| a.archive_path.cmp(&b.archive_path));
    Ok(entries)
}

fn file_digest(
    entry: &Entry,
    mut output: Option<&mut dyn Write>,
    budget: &Budget,
) -> Result<[u8; 32]> {
    budget.check()?;
    let before = fs::symlink_metadata(&entry.source_path)?;
    if !before.is_file()
        || before.file_type().is_symlink()
        || before.len() != entry.size
        || before.modified().ok() != entry.modified
    {
        bail!("live checkpoint source changed before reading");
    }
    let mut file = File::open(&entry.source_path)?;
    let mut remaining = entry.size;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        budget.check()?;
        let want = remaining.min(buffer.len() as u64) as usize;
        let count = file.read(&mut buffer[..want])?;
        if count == 0 {
            bail!("live checkpoint source ended early");
        }
        hash.update(&buffer[..count]);
        if let Some(writer) = output.as_mut() {
            writer.write_all(&buffer[..count])?;
        }
        remaining -= count as u64;
    }
    let after = fs::symlink_metadata(&entry.source_path)?;
    if !after.is_file()
        || after.file_type().is_symlink()
        || after.len() != entry.size
        || after.modified().ok() != entry.modified
    {
        bail!("live checkpoint source changed during reading");
    }
    budget.check()?;
    Ok(hash.finalize().into())
}

pub(crate) fn export_frozen(
    input: FrozenExport<'_>,
    recipient_text: &str,
    output: &Path,
    limits: LiveExportLimits,
) -> Result<LiveArchiveReceipt> {
    let budget = Budget::new(limits)?;
    validate_metadata(&input.metadata)?;
    anyhow::ensure!(
        input.metadata.excluded_runtime_paths == LIVE_RUNTIME_PATHS,
        "new checkpoint metadata must declare current runtime exclusions"
    );
    if input.jwt_secret.is_empty()
        || input.jwt_secret.trim() != input.jwt_secret
        || input.jwt_secret.len() > 64 * 1024
    {
        bail!("active signing secret cannot round-trip the persisted resolver");
    }
    if input.metadata.bootstrap_fingerprint
        != wabidb::replication::replica_fingerprint(input.root_key)
        || input
            .metadata
            .server_config
            .get("jwt_secret")
            .and_then(|v| v.as_str())
            != Some(input.jwt_secret)
    {
        bail!("live checkpoint metadata does not match active keys");
    }
    let data = canonical_directory(input.data)?;
    let uploads = canonical_directory(input.uploads)?;
    if data == uploads || data.starts_with(&uploads) {
        bail!("uploads overlaps the data root");
    }
    let parent = canonical_directory(
        output
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?;
    let output = parent.join(output.file_name().context("output needs a file name")?);
    if output.starts_with(&data) || output.starts_with(&uploads) {
        bail!("archive output must be outside source roots");
    }
    if fs::symlink_metadata(&output).is_ok() {
        bail!("archive output already exists");
    }
    let embedded = uploads.starts_with(&data);
    let embedded_name = if embedded {
        uploads
            .strip_prefix(&data)?
            .to_str()
            .context("uploads path is not UTF-8")?
            .replace('\\', "/")
    } else {
        String::new()
    };
    let entries = collect(&data, &uploads, embedded, &budget)?;
    if entries.len() as u64 + 2 > budget.limits.max_entries {
        bail!("live checkpoint entry budget exceeded");
    }
    let header = serde_json::to_vec(&input.metadata)?;
    if header.len() > MAX_HEADER_BYTES {
        bail!("live checkpoint header exceeds limit");
    }
    let root_bytes = format!("{}\n", hex::encode(input.root_key));
    let virtual_files = [
        ("data/jwt_secret", input.jwt_secret.as_bytes()),
        ("data/wabidb/root_key", root_bytes.as_bytes()),
    ];
    let total_bytes = entries
        .iter()
        .try_fold(0u64, |sum, entry| {
            sum.checked_add(entry.size).context("file size overflow")
        })?
        .checked_add(input.jwt_secret.len() as u64)
        .and_then(|n| n.checked_add(root_bytes.len() as u64))
        .context("file size overflow")?;
    if total_bytes > budget.limits.max_plaintext_bytes {
        bail!("live checkpoint plaintext byte budget exceeded");
    }
    let recipient = recipient_text
        .parse::<age::x25519::Recipient>()
        .map_err(|e| anyhow::anyhow!("invalid age recipient: {e}"))?;
    let mut owned = PrivateOutput {
        temporary: parent.join(format!(".wabi-live-{}.tmp", uuid::Uuid::new_v4())),
        output,
        created: false,
        published: false,
        complete: false,
    };
    let mut file = private_new_file(&owned.temporary)?;
    owned.created = true;
    let mut inventory = Inventory::default();
    let mut transmitted = Vec::with_capacity(entries.len());
    let (ciphertext_hash, ciphertext_bytes) = {
        let mut sink = CiphertextWriter {
            file: &mut file,
            hash: Sha256::new(),
            bytes: 0,
        };
        let encryptor =
            Encryptor::with_recipients(std::iter::once(&recipient as &dyn age::Recipient))?;
        let mut writer = encryptor.wrap_output(&mut sink)?;
        writer.write_all(LIVE_MAGIC)?;
        writer.write_all(&(header.len() as u32).to_le_bytes())?;
        writer.write_all(&header)?;
        write_string(&mut writer, &embedded_name)?;
        writer.write_all(&(entries.len() as u64 + 2).to_le_bytes())?;
        for entry in &entries {
            budget.check()?;
            writer.write_all(&[if entry.is_dir { 0 } else { 1 }])?;
            write_string(&mut writer, &entry.archive_path)?;
            let digest = if entry.is_dir {
                [0u8; 32]
            } else {
                writer.write_all(&entry.size.to_le_bytes())?;
                let digest = file_digest(entry, Some(&mut writer), &budget)?;
                writer.write_all(&digest)?;
                digest
            };
            inventory.entry(&entry.archive_path, entry.is_dir, entry.size, &digest);
            transmitted.push(digest);
        }
        for (name, bytes) in virtual_files {
            budget.check()?;
            writer.write_all(&[1])?;
            write_string(&mut writer, name)?;
            writer.write_all(&(bytes.len() as u64).to_le_bytes())?;
            writer.write_all(bytes)?;
            let digest: [u8; 32] = Sha256::digest(bytes).into();
            writer.write_all(&digest)?;
            inventory.entry(name, false, bytes.len() as u64, &digest);
        }
        writer.write_all(&inventory.footer())?;
        writer.finish()?;
        (hex::encode(sink.hash.finalize()), sink.bytes)
    };
    file.sync_all()?;
    // Re-enumerate and hash every copied file before publishing. Changes to
    // excluded runtime files or stale key files do not affect this inventory.
    if collect(&data, &uploads, embedded, &budget)? != entries {
        bail!("source inventory changed during live checkpoint");
    }
    for (entry, sent) in entries.iter().zip(&transmitted) {
        if !entry.is_dir && file_digest(entry, None, &budget)? != *sent {
            bail!("source bytes changed during live checkpoint");
        }
    }
    budget.check()?;
    fs::hard_link(&owned.temporary, &owned.output)?;
    owned.published = true;
    sync_parent(&owned.output)?;
    budget.check()?;
    owned.complete = true;
    Ok(LiveArchiveReceipt {
        schema_version: 1,
        applied_commit_seq: input.metadata.applied_commit_seq,
        commit_prefix_fingerprint: input.metadata.commit_prefix_fingerprint,
        file_count: inventory.files,
        directory_count: inventory.directories,
        plaintext_file_bytes: inventory.bytes,
        ciphertext_bytes,
        inventory_sha256: hex::encode(inventory.hash.finalize()),
        encrypted_archive_sha256: ciphertext_hash,
        full_instance_ready: false,
    })
}

pub(super) fn validate_metadata(metadata: &LiveCheckpointMetadata) -> Result<()> {
    let digest = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
    if metadata.schema_version != 1
        || metadata.full_instance_ready
        || metadata.external_state_verified
        || !digest(&metadata.commit_prefix_fingerprint)
        || !digest(&metadata.bootstrap_fingerprint)
        || !wabidb::engine::node_identity::valid_node_id(&metadata.node_id)
        || metadata
            .server_config
            .get("node_id")
            .and_then(|v| v.as_str())
            != Some(metadata.node_id.as_str())
        || metadata
            .server_config
            .get("server_role")
            .and_then(|v| v.as_str())
            != Some("authority")
        || (metadata.excluded_runtime_paths != LIVE_RUNTIME_PATHS
            && metadata.excluded_runtime_paths != LEGACY_RUNTIME_PATHS)
        || metadata.active_key_substitutions != ["data/jwt_secret", "data/wabidb/root_key"]
    {
        bail!("invalid live checkpoint metadata or unsupported readiness claim");
    }
    Ok(())
}

#[cfg(test)]
mod tests;

pub(super) fn read_metadata(reader: &mut impl Read) -> Result<LiveCheckpointMetadata> {
    let mut length = [0u8; 4];
    reader.read_exact(&mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    if length > MAX_HEADER_BYTES {
        bail!("live checkpoint header exceeds limit");
    }
    let mut bytes = vec![0u8; length];
    reader.read_exact(&mut bytes)?;
    let metadata = serde_json::from_slice(&bytes)?;
    validate_metadata(&metadata)?;
    Ok(metadata)
}

pub(super) fn seal_inactive_restore(stage: &Path, metadata: &LiveCheckpointMetadata) -> Result<()> {
    let data = stage.join("data");
    let entries =
        wabidb::commit_index::batcher::read_all_entries(&data.join("wabidb/global/commit-index"))?;
    let position = entries.last().map(|e| e.commit_seq).unwrap_or(0);
    let (watermark, _) = canonical_projection_snapshot(&data)?;
    if position != metadata.applied_commit_seq
        || watermark != position
        || wabidb::replication::commit_prefix_fingerprint(&entries, position)
            != metadata.commit_prefix_fingerprint
    {
        bail!("restored live checkpoint position/prefix disagrees with metadata");
    }
    let root = fs::read_to_string(data.join("wabidb/root_key"))?;
    let root: [u8; 32] = hex::decode(root.trim())?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid restored root key"))?;
    if wabidb::replication::replica_fingerprint(&root) != metadata.bootstrap_fingerprint
        || metadata
            .server_config
            .get("jwt_secret")
            .and_then(|v| v.as_str())
            != Some(fs::read_to_string(data.join("jwt_secret"))?.as_str())
    {
        bail!("restored live checkpoint active keys disagree with metadata");
    }
    let marker = data.join("wabidb").join(LIVE_MARKER);
    let mut file = private_new_file(&marker)?;
    file.write_all(b"inactive live checkpoint; promotion requires a separate verified protocol\n")?;
    file.sync_all()?;
    let fence = data.join("wabidb").join(WRITER_FENCE_MARKER);
    let mut file = private_new_file(&fence)?;
    file.write_all(b"fenced\n")?;
    file.sync_all()?;
    let mut file = private_new_file(&stage.join("live-checkpoint.json"))?;
    file.write_all(&serde_json::to_vec_pretty(metadata)?)?;
    file.sync_all()?;
    Ok(())
}
