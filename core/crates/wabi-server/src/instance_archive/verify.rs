//! Inactive live-core verification, not readiness certification or promotion.
use super::*;
use std::time::{Duration, Instant};
use wabidb::engine::offline_inspect::{inspect_frozen_locked, InspectionLimits, InspectionReceipt};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InactiveVerificationReceipt {
    pub schema_version: u8,
    pub result: &'static str,
    pub support_profile: &'static str,
    pub source_archive_sha256: String,
    pub source_receipt_matched: bool,
    pub database: InspectionReceipt,
    pub file_count: u64,
    pub directory_count: u64,
    pub file_bytes: u64,
    pub tree_sha256: String,
    pub active_bundle_keys_match: bool,
    pub inactive_guards_preserved: bool,
    pub published_uploads_checked: u64,
    pub upload_denials_checked: u64,
    pub external_state_verified: bool,
    pub full_instance_ready: bool,
}

fn bounded_read(path: &Path, maximum: u64) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > maximum {
        bail!("invalid bounded verification input");
    }
    let mut bytes = Vec::new();
    File::open(path)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        bail!("bounded verification input changed");
    }
    Ok(bytes)
}

pub(super) fn read_source_receipt(path: &Path) -> Result<LiveArchiveReceipt> {
    Ok(serde_json::from_slice(&bounded_read(path, 16 * 1024)?)?)
}

struct AuthenticatedInput {
    file: File,
    hash: Sha256,
    bytes: u64,
    maximum: u64,
    deadline: Instant,
}
impl Read for AuthenticatedInput {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if Instant::now() >= self.deadline {
            return Err(std::io::Error::other("verification deadline elapsed"));
        }
        let available = self.maximum.saturating_sub(self.bytes).saturating_add(1);
        let size = buffer.len().min(available as usize);
        let count = self.file.read(&mut buffer[..size])?;
        self.bytes += count as u64;
        if self.bytes > self.maximum {
            return Err(std::io::Error::other(
                "verification ciphertext budget exceeded",
            ));
        }
        self.hash.update(&buffer[..count]);
        Ok(count)
    }
}

// Inventory fingerprints do not cover the private header. Authenticate that
// header against the source ciphertext too, without extracting another tree or
// retaining the ciphertext in memory. Read-ahead is hashed by the same reader.
fn authenticated_metadata(
    archive: &Path,
    identity_file: &Path,
    source: &LiveArchiveReceipt,
    limits: &InspectionLimits,
    deadline: Instant,
) -> Result<LiveCheckpointMetadata> {
    let maximum = limits
        .max_file_bytes
        .checked_add(2 * 1024 * 1024)
        .context("ciphertext budget overflow")?;
    let file_metadata = fs::symlink_metadata(archive)?;
    if !file_metadata.is_file()
        || file_metadata.file_type().is_symlink()
        || file_metadata.len() != source.ciphertext_bytes
        || file_metadata.len() > maximum
    {
        bail!("invalid authenticated checkpoint input");
    }
    let identity_bytes = bounded_read(identity_file, 16 * 1024)?;
    let identity = std::str::from_utf8(&identity_bytes)?
        .trim()
        .parse::<age::x25519::Identity>()
        .map_err(|_| anyhow::anyhow!("invalid private verification identity"))?;
    let mut input = AuthenticatedInput {
        file: File::open(archive)?,
        hash: Sha256::new(),
        bytes: 0,
        maximum,
        deadline,
    };
    let metadata = {
        let decryptor = Decryptor::new(&mut input)?;
        if decryptor.is_scrypt() {
            bail!("passphrase checkpoints are unsupported");
        }
        let mut reader = decryptor.decrypt(std::iter::once(&identity as &dyn age::Identity))?;
        let mut magic = vec![0u8; live::LIVE_MAGIC.len()];
        reader.read_exact(&mut magic)?;
        if magic != live::LIVE_MAGIC {
            bail!("inactive verifier requires a live V2 checkpoint");
        }
        live::read_metadata(&mut reader)?
    };
    let mut buffer = [0u8; 65536];
    while input.read(&mut buffer)? != 0 {}
    if input.bytes != source.ciphertext_bytes
        || hex::encode(input.hash.finalize()) != source.encrypted_archive_sha256
    {
        bail!("checkpoint ciphertext differs from authenticated source receipt");
    }
    Ok(metadata)
}

#[derive(PartialEq, Eq)]
struct WholeTree {
    files: u64,
    directories: u64,
    bytes: u64,
    digest: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryView {
    #[serde(deserialize_with = "unique_registry_files")]
    files: std::collections::BTreeMap<String, crate::upload_registry::UploadMeta>,
    #[serde(default)]
    revoked: std::collections::HashSet<String>,
}

fn unique_registry_files<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<
    std::collections::BTreeMap<String, crate::upload_registry::UploadMeta>,
    D::Error,
> {
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = std::collections::BTreeMap<String, crate::upload_registry::UploadMeta>;
        fn expecting(&self, out: &mut std::fmt::Formatter) -> std::fmt::Result {
            out.write_str("unique upload registry entries")
        }
        fn visit_map<A: serde::de::MapAccess<'de>>(
            self,
            mut access: A,
        ) -> std::result::Result<Self::Value, A::Error> {
            let mut files = Self::Value::new();
            while let Some((key, value)) = access.next_entry()? {
                if files.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom("duplicate upload registry entry"));
                }
            }
            Ok(files)
        }
    }
    deserializer.deserialize_map(Visitor)
}

fn verify_uploads(
    data: &Path,
    uploads: &Path,
    state: &wabidb::engine::locks::ProjectionState,
    limits: &InspectionLimits,
    deadline: Instant,
) -> Result<(u64, u64)> {
    use wabidb::projections::{upload_assets as assets, upload_revocations as denials};
    let path = data.join("upload_registry.json");
    let registry: RegistryView = match fs::symlink_metadata(&path) {
        Ok(_) => serde_json::from_slice(&bounded_read(&path, 4 * 1024 * 1024)?)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => RegistryView {
            files: Default::default(),
            revoked: Default::default(),
        },
        Err(error) => return Err(error.into()),
    };
    if registry.files.len() as u64 > limits.max_entries
        || registry.revoked.len() as u64 > limits.max_entries
    {
        bail!("upload registry budget exceeded");
    }
    let mut published = std::collections::BTreeMap::new();
    let mut revoked = std::collections::HashSet::new();
    let mut invalid = false;
    state.for_each(assets::INDEX, |key, value| match assets::decode(value) {
        Ok(record) if key == record.filename.as_bytes() => {
            published.insert(record.filename.clone(), record);
        }
        _ => invalid = true,
    });
    state.for_each(denials::INDEX, |key, value| match denials::decode(value) {
        Ok(record) if key == record.filename.as_bytes() => {
            revoked.insert(record.filename);
        }
        _ => invalid = true,
    });
    if invalid || revoked != registry.revoked {
        bail!("upload denial state differs from canonical history");
    }
    for (name, meta) in &registry.files {
        if name != &meta.filename || !denials::valid_filename(name) {
            bail!("invalid upload registry identity");
        }
        // Revoked legacy uploads may have no canonical publication hash. Their
        // denial must still be canonical. Never authorize or resurrect them.
        if !published.contains_key(name) && !revoked.contains(name) {
            bail!("unverified legacy upload needs stopped canonical backfill");
        }
    }
    let mut checked = 0u64;
    let mut buffer = [0u8; 65536];
    for record in published.values() {
        if Instant::now() >= deadline {
            bail!("upload verification deadline elapsed");
        }
        let meta = registry
            .files
            .get(&record.filename)
            .context("canonical upload metadata missing")?;
        if meta.filename != record.filename
            || meta.original_name != record.original_name
            || meta.channel_id != record.channel_id
            || meta.uploader_id != record.uploader_id
            || meta.kind.as_str() != record.kind
            || meta.size != record.size
            || meta.created_at.timestamp_micros() != record.created_at_micros
        {
            bail!("upload metadata differs from canonical publication");
        }
        if revoked.contains(&record.filename) {
            continue;
        }
        let path = uploads.join(&record.filename);
        let metadata = fs::symlink_metadata(&path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != record.size
        {
            bail!("published upload is missing or has wrong size");
        }
        let mut file = File::open(path)?;
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        loop {
            if Instant::now() >= deadline {
                bail!("upload verification deadline elapsed");
            }
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            bytes += count as u64;
            if bytes > record.size {
                bail!("published upload changed");
            }
            hash.update(&buffer[..count]);
        }
        if bytes != record.size
            || !hex::encode(hash.finalize()).eq_ignore_ascii_case(&record.sha256)
        {
            bail!("published upload differs from canonical digest");
        }
        checked += 1;
    }
    Ok((checked, revoked.len() as u64))
}

fn whole_tree(root: &Path, limits: &InspectionLimits, deadline: Instant) -> Result<WholeTree> {
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    let mut records = std::collections::BTreeMap::new();
    let mut files = 0u64;
    let mut directories = 0u64;
    let mut bytes = 0u64;
    let mut paths = 0u64;
    let mut buffer = [0u8; 65536];
    while let Some((directory, depth)) = pending.pop() {
        if Instant::now() >= deadline || depth > 64 {
            bail!("whole-tree verification deadline/depth exceeded");
        }
        for item in fs::read_dir(directory)? {
            if Instant::now() >= deadline {
                bail!("whole-tree verification deadline elapsed");
            }
            let path = item?.path();
            let relative = path.strip_prefix(root)?;
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
                bail!("unsupported whole-tree verification input");
            }
            if relative == Path::new("data/wabidb/.lock") {
                if !metadata.is_file() {
                    bail!("invalid verification lock");
                }
                continue;
            }
            paths = paths
                .checked_add(relative.as_os_str().len() as u64)
                .context("path budget overflow")?;
            if records.len() as u64 >= limits.max_entries || paths > 4 * 1024 * 1024 {
                bail!("whole-tree verification inventory budget exceeded");
            }
            if metadata.is_dir() {
                directories += 1;
                records.insert(relative.to_path_buf(), (0u8, 0u64, [0u8; 32]));
                pending.push((path, depth + 1));
            } else {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if metadata.nlink() != 1 {
                        bail!("linked whole-tree verification input");
                    }
                }
                files += 1;
                bytes = bytes
                    .checked_add(metadata.len())
                    .context("byte budget overflow")?;
                if bytes > limits.max_file_bytes {
                    bail!("whole-tree verification byte budget exceeded");
                }
                let mut file = File::open(&path)?;
                let mut hash = Sha256::new();
                let mut read_bytes = 0u64;
                loop {
                    if Instant::now() >= deadline {
                        bail!("whole-tree verification deadline elapsed");
                    }
                    let count = file.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    read_bytes += count as u64;
                    if read_bytes > metadata.len() {
                        bail!("whole-tree verification input changed");
                    }
                    hash.update(&buffer[..count]);
                }
                if read_bytes != metadata.len() {
                    bail!("whole-tree verification input changed");
                }
                records.insert(
                    relative.to_path_buf(),
                    (1u8, read_bytes, hash.finalize().into()),
                );
            }
        }
    }
    let mut hash = Sha256::new();
    hash.update(b"wabi/inactive-live-tree/v1\0");
    for (path, (kind, size, digest)) in records {
        let path = path.to_str().context("non-UTF8 whole-tree path")?;
        hash.update(&(path.len() as u64).to_le_bytes());
        hash.update(path.as_bytes());
        hash.update(&[kind]);
        hash.update(&size.to_le_bytes());
        hash.update(&digest);
    }
    Ok(WholeTree {
        files,
        directories,
        bytes,
        digest: hex::encode(hash.finalize()),
    })
}

/// Keeps the whole-instance writer lock across metadata, key, upload and full
/// database replay checks. Every live guard remains intact. This is a bounded
/// complete-history core support profile; enabled external state is refused.
pub async fn verify_inactive_live(
    target: &Path,
    source: &LiveArchiveReceipt,
    source_archive: &Path,
    identity_file: &Path,
    limits: InspectionLimits,
) -> Result<InactiveVerificationReceipt> {
    if limits.max_entries == 0
        || limits.max_entries > 100_000
        || limits.max_file_bytes == 0
        || limits.max_file_bytes > 256 * 1024 * 1024
        || limits.max_snapshot_bytes == 0
        || limits.max_snapshot_bytes > 16 * 1024 * 1024
        || limits.timeout.is_zero()
        || limits.timeout > Duration::from_secs(300)
    {
        bail!("invalid inactive verification limits");
    }
    let deadline = Instant::now()
        .checked_add(limits.timeout)
        .context("invalid verification deadline")?;
    let root = canonical_directory(target)?;
    let data = canonical_directory(&root.join("data"))?;
    let stopped = ensure_stopped(&data)?;
    require_writer_fence(&data)?;
    if bounded_read(&data.join("wabidb/live-checkpoint-v1"), 256)?
        != b"inactive live checkpoint; promotion requires a separate verified protocol\n"
    {
        bail!("inactive live guard is invalid");
    }
    let metadata: LiveCheckpointMetadata = serde_json::from_slice(&bounded_read(
        &root.join("live-checkpoint.json"),
        1024 * 1024,
    )?)?;
    live::validate_metadata(&metadata)?;
    let digest = |value: &str| value.len() == 64 && hex::decode(value).is_ok();
    if source.schema_version != 1
        || source.full_instance_ready
        || source.ciphertext_bytes == 0
        || !digest(&source.encrypted_archive_sha256)
        || !digest(&source.inventory_sha256)
        || source.applied_commit_seq != metadata.applied_commit_seq
        || source.commit_prefix_fingerprint != metadata.commit_prefix_fingerprint
    {
        bail!("source receipt differs from the restored checkpoint");
    }
    let authenticated =
        authenticated_metadata(source_archive, identity_file, source, &limits, deadline)?;
    if serde_json::to_value(&metadata)? != serde_json::to_value(&authenticated)? {
        bail!("restored private metadata differs from the authenticated source");
    }
    let config: crate::config::ServerConfig =
        serde_json::from_value(metadata.server_config.clone())?;
    if config.lore.enabled || config.mesh_enabled {
        bail!("enabled external topology needs a coordinated support profile");
    }
    match fs::symlink_metadata(data.join("addons.json")) {
        Ok(_) => {
            let switches: crate::addon_switches::AddonSwitches =
                serde_json::from_slice(&bounded_read(&data.join("addons.json"), 64 * 1024)?)?;
            // Do not consult the verifier computer's environment. The restored
            // switch would enable an external store after environment loss.
            if switches.get("lore") == Some(true) {
                bail!("persisted Lore switch needs an external-store participant");
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    // Runtime plugins and non-core stores cannot be certified by an operator
    // acknowledgment. Unknown bundled files are still counted and preserved.
    if root.join("plugins").exists() || data.join("plugins").exists() {
        bail!("plugin inventory is not supported by this core profile");
    }
    let blacklist = Path::new(&config.blacklist_file);
    let original_data = Path::new(&config.data_dir);
    let original_uploads = Path::new(&config.uploads_dir);
    if original_data.as_os_str().is_empty()
        || original_uploads.as_os_str().is_empty()
        || (!blacklist.starts_with(original_data) && !blacklist.starts_with(original_uploads))
        || [blacklist, original_data, original_uploads]
            .iter()
            .any(|path| {
                path.components()
                    .any(|component| matches!(component, std::path::Component::ParentDir))
            })
    {
        bail!("external blacklist needs a coordinated support profile");
    }
    let jwt = bounded_read(&data.join("jwt_secret"), 64 * 1024)?;
    if jwt != config.jwt_secret.as_bytes() {
        bail!("active bundle signing key differs");
    }
    let root_text = bounded_read(&data.join("wabidb/root_key"), 256)?;
    let root_hex = std::str::from_utf8(&root_text)?.trim();
    let key: [u8; 32] = hex::decode(root_hex)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid bundle root key"))?;
    if wabidb::replication::replica_fingerprint(&key) != metadata.bootstrap_fingerprint {
        bail!("active bundle database key differs");
    }
    let before = whole_tree(&root, &limits, deadline)?;
    let mut remaining = limits.clone();
    remaining.timeout = deadline.saturating_duration_since(Instant::now());
    let inspected = inspect_frozen_locked(
        &data.join("wabidb"),
        &key,
        metadata.applied_commit_seq,
        &metadata.commit_prefix_fingerprint,
        remaining,
        &stopped.lock,
    )
    .await?;
    let uploads = if let Ok(relative) = original_uploads.strip_prefix(original_data) {
        if relative.as_os_str().is_empty() {
            bail!("uploads and data roots overlap ambiguously");
        }
        canonical_directory(&data.join(relative))?
    } else {
        canonical_directory(&root.join("uploads"))?
    };
    let (published_uploads_checked, upload_denials_checked) = verify_uploads(
        &data,
        &uploads,
        inspected.projection_state(),
        &limits,
        deadline,
    )?;
    live::verify_source_inventory(
        &data,
        &uploads,
        source,
        LiveExportLimits {
            max_entries: limits.max_entries,
            max_plaintext_bytes: limits.max_file_bytes,
            max_inventory_path_bytes: 4 * 1024 * 1024,
            copy_timeout: deadline.saturating_duration_since(Instant::now()),
        },
    )?;
    if before != whole_tree(&root, &limits, deadline)? {
        bail!("inactive whole-instance tree changed");
    }
    require_writer_fence(&data)?;
    stopped.verify()?;
    Ok(InactiveVerificationReceipt {
        schema_version: 1,
        result: "PASS",
        support_profile: "inactive-live-core-complete-history-v1",
        source_archive_sha256: source.encrypted_archive_sha256.clone(),
        source_receipt_matched: true,
        database: inspected.receipt,
        file_count: before.files,
        directory_count: before.directories,
        file_bytes: before.bytes,
        tree_sha256: before.digest,
        active_bundle_keys_match: true,
        inactive_guards_preserved: true,
        published_uploads_checked,
        upload_denials_checked,
        external_state_verified: false,
        full_instance_ready: false,
    })
}
