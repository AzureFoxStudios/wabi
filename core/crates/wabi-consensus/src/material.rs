//! Bounded durable opaque recovery material, before transport/quorum wiring.
//! The trusted caller must supply already encrypted material. This store does
//! not encrypt/decrypt it, verify source authenticity or permit a Wabi writer.
//! Linux descriptor-relative paths pin the private directory against redirects.
mod checkpoint;
mod model;
pub use checkpoint::{CheckpointManifest, ChunkingLimits, LocalCheckpointReceipt};
pub use model::{LocalByteReceipt, MaterialKind, MaterialLimits, MaterialManifest, ObjectRef};

use crate::model::StoreBinding;
use fs4::fs_std::FileExt;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::fd::AsRawFd,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const BINDING: &str = "material.binding.json";
const LOCK: &str = ".lock";
// Linux UAPI O_NOFOLLOW. No additional crate/feature/dependency is introduced.
const NOFOLLOW: i32 = 0o400000;
const MAX_JSON: usize = 64 * 1024;
const MAX_CHECKPOINT_JSON: usize = 256 * 1024;
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MaterialError {
    #[error("invalid recovery material format")]
    Format,
    #[error("recovery material context mismatch")]
    Context,
    #[error("recovery material budget exceeded")]
    Budget,
    #[error("unsafe or already owned recovery material store")]
    Ownership,
    #[error("required recovery material absent")]
    NotFound,
    #[error("recovery material IO failed")]
    Io,
    #[error("recovery material deadline elapsed")]
    Deadline,
}
type Result<T> = std::result::Result<T, MaterialError>;
fn io<T>(value: std::io::Result<T>) -> Result<T> {
    value.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            MaterialError::NotFound
        } else {
            MaterialError::Io
        }
    })
}
fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn canonical_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}
fn json(value: &impl serde::Serialize) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value).map_err(|_| MaterialError::Format)?;
    if bytes.len() > MAX_JSON {
        return Err(MaterialError::Budget);
    }
    Ok(bytes)
}
#[derive(serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BindingRecord {
    schema_version: u8,
    format: String,
    binding: StoreBinding,
}
fn binding_record(binding: &StoreBinding) -> BindingRecord {
    BindingRecord {
        schema_version: 1,
        format: "wabi-opaque-recovery-material-v1".into(),
        binding: binding.clone(),
    }
}
struct Inner {
    directory: File,
    named_root: PathBuf,
    binding: StoreBinding,
    limits: MaterialLimits,
    lane: Mutex<()>,
    // Dropped after the directory/other fields; original inode is never unlinked.
    lock: File,
}
#[derive(Clone)]
pub struct MaterialStore {
    inner: Arc<Inner>,
}
impl std::fmt::Debug for MaterialStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MaterialStore([REDACTED])")
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Point {
    StageSynced,
    Linked,
    StageRemoved,
    DirectorySynced,
}
impl Inner {
    fn relative(&self, name: &str) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.directory.as_raw_fd())).join(name)
    }
    fn verify(&self) -> Result<()> {
        let held = io(self.directory.metadata())?;
        let named = io(fs::symlink_metadata(&self.named_root))?;
        if !named.is_dir()
            || named.file_type().is_symlink()
            || named.mode() & 0o077 != 0
            || (held.dev(), held.ino()) != (named.dev(), named.ino())
            || named.uid() != held.uid()
        {
            return Err(MaterialError::Ownership);
        }
        let lock = io(fs::symlink_metadata(self.relative(LOCK)))?;
        let actual = io(self.lock.metadata())?;
        if !lock.is_file()
            || lock.file_type().is_symlink()
            || lock.nlink() != 1
            || lock.mode() & 0o077 != 0
            || lock.uid() != held.uid()
            || (lock.dev(), lock.ino()) != (actual.dev(), actual.ino())
        {
            return Err(MaterialError::Ownership);
        }
        Ok(())
    }
    fn private_file(&self, name: &str, links: u64) -> Result<File> {
        let named = io(fs::symlink_metadata(self.relative(name)))?;
        if !named.is_file()
            || named.file_type().is_symlink()
            || named.nlink() != links
            || named.mode() & 0o077 != 0
            || named.uid() != io(self.directory.metadata())?.uid()
        {
            return Err(MaterialError::Ownership);
        }
        let file = io(OpenOptions::new()
            .read(true)
            .custom_flags(NOFOLLOW)
            .open(self.relative(name)))?;
        let held = io(file.metadata())?;
        if (held.dev(), held.ino()) != (named.dev(), named.ino())
            || held.nlink() != links
            || held.mode() & 0o077 != 0
            || held.uid() != named.uid()
        {
            return Err(MaterialError::Ownership);
        }
        Ok(file)
    }
    fn read_json(&self, name: &str, links: u64) -> Result<Vec<u8>> {
        self.read_json_cap(name, links, MAX_JSON)
    }
    fn read_json_cap(&self, name: &str, links: u64, maximum: usize) -> Result<Vec<u8>> {
        let file = self.private_file(name, links)?;
        if io(file.metadata())?.len() > maximum as u64 {
            return Err(MaterialError::Budget);
        }
        let mut bytes = Vec::new();
        io(file.take(maximum as u64 + 1).read_to_end(&mut bytes))?;
        if bytes.len() > maximum {
            return Err(MaterialError::Budget);
        }
        Ok(bytes)
    }
    fn names(&self) -> Result<Vec<String>> {
        let mut names = Vec::new();
        for entry in io(fs::read_dir(self.relative("")))? {
            let entry = io(entry)?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| MaterialError::Ownership)?;
            if !known_name(&name) {
                return Err(MaterialError::Ownership);
            }
            names.push(name);
            if names.len() > self.limits.max_objects * 2 + self.limits.max_manifests * 2 + 4 {
                return Err(MaterialError::Budget);
            }
        }
        Ok(names)
    }
    fn inventory(&self) -> Result<(usize, usize, u64)> {
        let (mut objects, mut manifests, mut bytes) = (0, 0, 0u64);
        for name in self.names()? {
            if name.starts_with(".stage-") {
                return Err(MaterialError::Ownership);
            }
            let file = self.private_file(&name, 1)?;
            let size = io(file.metadata())?.len();
            if name.ends_with(".blob") {
                objects += 1;
                bytes = bytes.checked_add(size).ok_or(MaterialError::Budget)?
            } else if name.ends_with(".manifest.json") {
                manifests += 1;
                if size > MAX_JSON as u64 {
                    return Err(MaterialError::Budget);
                }
            } else if name.ends_with(".checkpoint.json") {
                manifests += 1;
                if size > MAX_CHECKPOINT_JSON as u64 {
                    return Err(MaterialError::Budget);
                }
            } else if name == BINDING && size > MAX_JSON as u64 {
                return Err(MaterialError::Budget);
            }
        }
        if objects > self.limits.max_objects
            || manifests > self.limits.max_manifests
            || bytes > self.limits.max_stored_bytes
        {
            return Err(MaterialError::Budget);
        }
        Ok((objects, manifests, bytes))
    }
    fn capacity(&self, extra: u64) -> Result<()> {
        self.verify()?;
        if io(fs4::available_space(self.relative("").as_path()))?
            < self
                .limits
                .min_free_bytes
                .checked_add(extra)
                .ok_or(MaterialError::Budget)?
        {
            return Err(MaterialError::Budget);
        }
        Ok(())
    }
    fn verify_object(&self, object: &ObjectRef, archive: Option<&mut Sha256>) -> Result<()> {
        object.validate(&self.limits)?;
        let file = self.private_file(&format!("{}.blob", object.sha256), 1)?;
        if io(file.metadata())?.len() != object.bytes {
            return Err(MaterialError::Format);
        }
        io(file.sync_all())?;
        let mut input = file.take(object.bytes + 1);
        let mut own = Sha256::new();
        let mut archive = archive;
        let mut count = 0u64;
        let mut buffer = [0u8; 32 * 1024];
        loop {
            let n = io(input.read(&mut buffer))?;
            if n == 0 {
                break;
            }
            own.update(&buffer[..n]);
            if let Some(h) = archive.as_deref_mut() {
                h.update(&buffer[..n])
            }
            count += n as u64;
        }
        if count != object.bytes || hex::encode(own.finalize()) != object.sha256 {
            return Err(MaterialError::Format);
        }
        self.verify()
    }
    fn publish(&self, name: &str, bytes: &[u8], mut hook: impl FnMut(Point)) -> Result<()> {
        self.capacity(bytes.len() as u64)?;
        let stage = format!(".stage-{name}");
        let mut file = io(OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(NOFOLLOW)
            .open(self.relative(&stage)))?;
        let result = (|| {
            io(file.write_all(bytes))?;
            io(file.sync_all())?;
            hook(Point::StageSynced);
            self.verify()?;
            let staged = self.private_file(&stage, 1)?;
            let original = io(file.metadata())?;
            let current = io(staged.metadata())?;
            if (original.dev(), original.ino()) != (current.dev(), current.ino()) {
                return Err(MaterialError::Ownership);
            }
            // No replacement of a prior object/receipt, even on a duplicate.
            io(fs::hard_link(self.relative(&stage), self.relative(name)))?;
            hook(Point::Linked);
            let linked = self.private_file(name, 2)?;
            let current = io(linked.metadata())?;
            if (original.dev(), original.ino()) != (current.dev(), current.ino()) {
                return Err(MaterialError::Ownership);
            }
            io(fs::remove_file(self.relative(&stage)))?;
            hook(Point::StageRemoved);
            io(self.directory.sync_all())?;
            hook(Point::DirectorySynced);
            self.verify()
        })();
        // Only remove this call's own remaining stage; an already linked final
        // stays an indeterminate durable outcome, never silently rolled back.
        if result.is_err() {
            if self.verify().is_ok() && self.relative(&stage).exists() {
                let held = io(file.metadata())?;
                let named = io(fs::symlink_metadata(self.relative(&stage)))?;
                if (held.dev(), held.ino()) == (named.dev(), named.ino()) {
                    io(fs::remove_file(self.relative(&stage)))?;
                    io(self.directory.sync_all())?;
                }
            }
        }
        result
    }
    fn recover_stages(&self) -> Result<()> {
        for name in self.names()? {
            let Some(final_name) = name.strip_prefix(".stage-") else {
                continue;
            };
            if !known_name(final_name) || final_name == LOCK {
                return Err(MaterialError::Ownership);
            }
            let stage_info = io(fs::symlink_metadata(self.relative(&name)))?;
            match fs::symlink_metadata(self.relative(final_name)) {
                Ok(final_info) => {
                    if (stage_info.dev(), stage_info.ino()) != (final_info.dev(), final_info.ino())
                    {
                        return Err(MaterialError::Ownership);
                    }
                    let file = self.private_file(&name, 2)?;
                    drop(file);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let file = self.private_file(&name, 1)?;
                    drop(file);
                }
                Err(_) => return Err(MaterialError::Io),
            }
            self.verify()?;
            io(fs::remove_file(self.relative(&name)))?;
            io(self.directory.sync_all())?;
        }
        Ok(())
    }
}
fn known_name(name: &str) -> bool {
    if name == LOCK || name == BINDING {
        return true;
    }
    if let Some(rest) = name.strip_prefix(".stage-") {
        return rest == BINDING || object_name(rest);
    }
    object_name(name)
}
fn object_name(name: &str) -> bool {
    name.strip_suffix(".blob")
        .or_else(|| name.strip_suffix(".manifest.json"))
        .or_else(|| name.strip_suffix(".checkpoint.json"))
        .is_some_and(canonical_hex)
}
impl MaterialStore {
    /// Immutable identity of the actual opened, locked store. Transport callers
    /// must compare this with their authenticated configuration before serving.
    pub fn binding(&self) -> &StoreBinding {
        &self.inner.binding
    }
    pub fn open(root: &Path, binding: StoreBinding, limits: MaterialLimits) -> Result<Self> {
        if !binding.valid()
            || !canonical_hex(&binding.community_id)
            || !limits.valid()
            || !root.is_absolute()
        {
            return Err(MaterialError::Format);
        }
        let metadata = io(fs::symlink_metadata(root))?;
        let uid = io(fs::metadata("/proc/self"))?.uid();
        if !metadata.is_dir()
            || metadata.file_type().is_symlink()
            || metadata.mode() & 0o077 != 0
            || metadata.uid() != uid
        {
            return Err(MaterialError::Ownership);
        }
        let directory = io(OpenOptions::new()
            .read(true)
            .custom_flags(NOFOLLOW)
            .open(root))?;
        let held = io(directory.metadata())?;
        if (held.dev(), held.ino()) != (metadata.dev(), metadata.ino()) {
            return Err(MaterialError::Ownership);
        }
        let relative = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
        // Refuse an unrelated application tree before creating any lock/file.
        let mut count = 0;
        for entry in io(fs::read_dir(&relative))? {
            let name = io(entry)?
                .file_name()
                .into_string()
                .map_err(|_| MaterialError::Ownership)?;
            if !known_name(&name) {
                return Err(MaterialError::Ownership);
            }
            count += 1;
            if count > limits.max_objects * 2 + limits.max_manifests * 2 + 4 {
                return Err(MaterialError::Budget);
            }
        }
        let lock = io(OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(NOFOLLOW)
            .open(relative.join(LOCK)))?;
        if !lock
            .try_lock_exclusive()
            .map_err(|_| MaterialError::Ownership)?
        {
            return Err(MaterialError::Ownership);
        }
        let store = Self {
            inner: Arc::new(Inner {
                directory,
                named_root: root.to_path_buf(),
                binding,
                limits,
                lane: Mutex::new(()),
                lock,
            }),
        };
        store.inner.verify()?;
        let expected = json(&binding_record(&store.inner.binding))?;
        match store.inner.read_json(BINDING, 1) {
            Ok(bytes) => {
                if bytes != expected {
                    return Err(MaterialError::Context);
                }
            }
            Err(MaterialError::Ownership) if store.inner.relative(BINDING).exists() => {
                // Crash between hard-link publication and stage unlink.
                let bytes = store.inner.read_json(BINDING, 2)?;
                if bytes != expected {
                    return Err(MaterialError::Context);
                }
            }
            Err(MaterialError::NotFound) => {
                let names = store.inner.names()?;
                if names
                    .iter()
                    .any(|n| n != LOCK && n != &format!(".stage-{BINDING}"))
                {
                    return Err(MaterialError::Context);
                }
                if names.iter().any(|n| n == &format!(".stage-{BINDING}")) {
                    if store.inner.read_json(&format!(".stage-{BINDING}"), 1)? != expected {
                        return Err(MaterialError::Context);
                    }
                    io(fs::remove_file(
                        store.inner.relative(&format!(".stage-{BINDING}")),
                    ))?;
                    io(store.inner.directory.sync_all())?;
                }
                store.inner.publish(BINDING, &expected, |_| {})?;
            }
            Err(error) => return Err(error),
        }
        store.inner.recover_stages()?;
        store.inner.inventory()?;
        io(store.inner.private_file(BINDING, 1)?.sync_all())?;
        io(store.inner.directory.sync_all())?;
        Ok(store)
    }
    pub fn put_object(&self, object: &ObjectRef, bytes: &[u8]) -> Result<()> {
        self.put_object_hook(object, bytes, |_| {})
    }
    fn put_object_hook(
        &self,
        object: &ObjectRef,
        bytes: &[u8],
        hook: impl FnMut(Point),
    ) -> Result<()> {
        let _lane = self
            .inner
            .lane
            .lock()
            .map_err(|_| MaterialError::Ownership)?;
        self.inner.verify()?;
        object.validate(&self.inner.limits)?;
        if bytes.len() as u64 != object.bytes || digest(bytes) != object.sha256 {
            return Err(MaterialError::Format);
        }
        let name = format!("{}.blob", object.sha256);
        match fs::symlink_metadata(self.inner.relative(&name)) {
            Ok(_) => {
                self.inner.verify_object(object, None)?;
                return io(self.inner.directory.sync_all());
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(MaterialError::Io),
        }
        let (count, _, size) = self.inner.inventory()?;
        if count >= self.inner.limits.max_objects
            || size
                .checked_add(object.bytes)
                .is_none_or(|n| n > self.inner.limits.max_stored_bytes)
        {
            return Err(MaterialError::Budget);
        }
        self.inner.publish(&name, bytes, hook)
    }
    pub fn certify_local(&self, manifest: &MaterialManifest) -> Result<LocalByteReceipt> {
        self.certify_hook(manifest, |_| {})
    }
    fn certify_hook(
        &self,
        manifest: &MaterialManifest,
        hook: impl FnMut(Point),
    ) -> Result<LocalByteReceipt> {
        let _lane = self
            .inner
            .lane
            .lock()
            .map_err(|_| MaterialError::Ownership)?;
        self.validate_required(manifest)?;
        let encoded = json(manifest)?;
        let id = digest(&encoded);
        let name = format!("{id}.manifest.json");
        let exists = match fs::symlink_metadata(self.inner.relative(&name)) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => return Err(MaterialError::Io),
        };
        if exists {
            if self.inner.read_json(&name, 1)? != encoded {
                return Err(MaterialError::Format);
            }
        } else {
            let (_, count, _) = self.inner.inventory()?;
            if count >= self.inner.limits.max_manifests {
                return Err(MaterialError::Budget);
            }
            self.inner.publish(&name, &encoded, hook)?;
        }
        io(self.inner.private_file(&name, 1)?.sync_all())?;
        io(self.inner.directory.sync_all())?;
        self.inner.verify()?;
        Ok(LocalByteReceipt::new(&self.inner.binding, manifest, id))
    }
    fn validate_required(&self, manifest: &MaterialManifest) -> Result<()> {
        self.inner.verify()?;
        manifest.validate(&self.inner.binding, &self.inner.limits)?;
        let mut archive = Sha256::new();
        for object in &manifest.objects {
            self.inner.verify_object(
                object,
                if object.kind == MaterialKind::CheckpointChunk {
                    Some(&mut archive)
                } else {
                    None
                },
            )?;
        }
        if hex::encode(archive.finalize()) != manifest.source_archive_sha256 {
            return Err(MaterialError::Format);
        }
        self.inner.verify()
    }
    pub fn receipt(&self, manifest_sha256: &str) -> Result<LocalByteReceipt> {
        let _lane = self
            .inner
            .lane
            .lock()
            .map_err(|_| MaterialError::Ownership)?;
        self.inner.verify()?;
        if !canonical_hex(manifest_sha256) {
            return Err(MaterialError::Format);
        }
        let bytes = self
            .inner
            .read_json(&format!("{manifest_sha256}.manifest.json"), 1)?;
        if digest(&bytes) != manifest_sha256 {
            return Err(MaterialError::Format);
        }
        let manifest: MaterialManifest =
            serde_json::from_slice(&bytes).map_err(|_| MaterialError::Format)?;
        if json(&manifest)? != bytes {
            return Err(MaterialError::Format);
        }
        self.validate_required(&manifest)?;
        io(self
            .inner
            .private_file(&format!("{manifest_sha256}.manifest.json"), 1)?
            .sync_all())?;
        io(self.inner.directory.sync_all())?;
        self.inner.verify()?;
        Ok(LocalByteReceipt::new(
            &self.inner.binding,
            &manifest,
            manifest_sha256.to_owned(),
        ))
    }
}
#[cfg(test)]
mod tests;
