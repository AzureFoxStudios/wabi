//! Optional source signature, separately versioned from old V2 archives/jobs.
//! A signed historical capture is not a current role, nonce or writer permit.
use super::LiveArchiveReceipt;
use crate::state::AppState;
use anyhow::{ensure, Context, Result};
use wabi_consensus::source_context::{
    AllocationKnowledge, SignedSourceContext, SourceClaims, MAX_SOURCE_CONTEXT_BYTES,
    SOURCE_PROFILE,
};

pub(crate) struct FrozenSourceIdentity {
    community: String,
    node: String,
    bootstrap: String,
    applied: u64,
    prefix: String,
}
impl FrozenSourceIdentity {
    pub(crate) fn capture(state: &AppState, applied: u64, prefix: &str) -> Self {
        Self {
            community: state.community_roster.community_id().into(),
            node: state.config.node_id.clone(),
            bootstrap: state.wdb.engine().replica_fingerprint(),
            applied,
            prefix: prefix.into(),
        }
    }
    pub(crate) fn claims(
        &self,
        community: &str,
        receipt: &LiveArchiveReceipt,
    ) -> Result<SourceClaims> {
        ensure!(self.community == community, "checkpoint community differs");
        ensure!(
            receipt.schema_version == 1
                && !receipt.full_instance_ready
                && receipt.applied_commit_seq == self.applied
                && receipt.commit_prefix_fingerprint == self.prefix,
            "checkpoint capture position differs"
        );
        Ok(SourceClaims {
            schema_version: 1,
            support_profile: SOURCE_PROFILE.into(),
            community_id: self.community.clone(),
            source_node_id: self.node.clone(),
            archive_sha256: receipt.encrypted_archive_sha256.clone(),
            inventory_sha256: receipt.inventory_sha256.clone(),
            ciphertext_bytes: receipt.ciphertext_bytes,
            applied_commit_seq: self.applied,
            commit_prefix_fingerprint: self.prefix.clone(),
            bootstrap_fingerprint: self.bootstrap.clone(),
            allocation: AllocationKnowledge::Unknown,
        })
    }
}
pub(crate) fn validate_receipt(
    context: &SignedSourceContext,
    receipt: &LiveArchiveReceipt,
    community: &str,
    node: &str,
) -> Result<()> {
    context.verify(community, node)?;
    let claims = &context.claims;
    ensure!(
        receipt.schema_version == 1
            && !receipt.full_instance_ready
            && claims.archive_sha256 == receipt.encrypted_archive_sha256
            && claims.inventory_sha256 == receipt.inventory_sha256
            && claims.ciphertext_bytes == receipt.ciphertext_bytes
            && claims.applied_commit_seq == receipt.applied_commit_seq
            && claims.commit_prefix_fingerprint == receipt.commit_prefix_fingerprint,
        "checkpoint context differs from completed export"
    );
    Ok(())
}
pub(crate) fn valid_job_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id)
}

#[cfg(target_os = "linux")]
mod filesystem {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        fs::{self, File, OpenOptions},
        io::{Read, Seek, Write},
        os::{
            fd::AsRawFd,
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
        path::{Path, PathBuf},
        time::{Duration, Instant},
    };
    const NOFOLLOW: i32 = 0o400000;
    const DIRECTORY: i32 = 0o200000;
    pub(crate) struct SourceDirectory {
        root: PathBuf,
        directory: File,
    }
    #[derive(Clone, Copy, Debug)]
    pub(super) enum PublicationPoint {
        StageSynced,
        Linked,
        StageRemoved,
        DirectorySynced,
    }
    struct Stage<'a> {
        directory: &'a SourceDirectory,
        name: String,
        inode: Option<(u64, u64)>,
    }
    impl Drop for Stage<'_> {
        fn drop(&mut self) {
            if self.inode.is_some_and(|inode| {
                fs::symlink_metadata(self.directory.relative(&self.name))
                    .is_ok_and(|named| (named.dev(), named.ino()) == inode)
            }) {
                let _ = fs::remove_file(self.directory.relative(&self.name));
            }
        }
    }
    impl SourceDirectory {
        pub(crate) fn open(root: &Path) -> Result<Self> {
            let directory = OpenOptions::new()
                .read(true)
                .custom_flags(NOFOLLOW | DIRECTORY)
                .open(root)?;
            let result = Self {
                root: root.to_path_buf(),
                directory,
            };
            result.verify()?;
            Ok(result)
        }
        fn relative(&self, name: &str) -> PathBuf {
            PathBuf::from(format!("/proc/self/fd/{}", self.directory.as_raw_fd())).join(name)
        }
        fn verify(&self) -> Result<()> {
            let named = fs::symlink_metadata(&self.root)?;
            let held = self.directory.metadata()?;
            ensure!(
                named.is_dir()
                    && !named.file_type().is_symlink()
                    && named.mode() & 0o077 == 0
                    && named.uid() == fs::metadata("/proc/self")?.uid()
                    && (named.dev(), named.ino()) == (held.dev(), held.ino()),
                "unsafe checkpoint directory"
            );
            Ok(())
        }
        fn private_file(&self, name: &str) -> Result<File> {
            self.verify()?;
            let named = fs::symlink_metadata(self.relative(name))?;
            ensure!(
                named.is_file()
                    && !named.file_type().is_symlink()
                    && named.nlink() == 1
                    && named.mode() & 0o077 == 0
                    && named.uid() == self.directory.metadata()?.uid(),
                "unsafe checkpoint file"
            );
            let file = OpenOptions::new()
                .read(true)
                // A substituted FIFO must not block before held-type checks.
                .custom_flags(NOFOLLOW | 0o4000)
                .open(self.relative(name))?;
            let held = file.metadata()?;
            ensure!(
                (named.dev(), named.ino()) == (held.dev(), held.ino())
                    && held.is_file()
                    && held.nlink() == 1
                    && held.mode() & 0o077 == 0
                    && held.uid() == named.uid(),
                "checkpoint file changed"
            );
            Ok(file)
        }
        pub(crate) fn publish(&self, id: &str, context: &SignedSourceContext) -> Result<()> {
            self.publish_hook(id, context, |_| {})
        }
        fn publish_hook(
            &self,
            id: &str,
            context: &SignedSourceContext,
            hook: impl FnMut(PublicationPoint),
        ) -> Result<()> {
            self.publish_stage(
                id,
                context,
                format!(".source-context-{}", uuid::Uuid::new_v4()),
                hook,
            )
        }
        fn publish_stage(
            &self,
            id: &str,
            context: &SignedSourceContext,
            name: String,
            mut hook: impl FnMut(PublicationPoint),
        ) -> Result<()> {
            ensure!(valid_job_id(id), "invalid checkpoint job ID");
            self.verify()?;
            let bytes = serde_json::to_vec(context)?;
            ensure!(
                bytes.len() <= MAX_SOURCE_CONTEXT_BYTES,
                "oversized source context"
            );
            let mut stage = Stage {
                directory: self,
                name,
                inode: None,
            };
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(NOFOLLOW)
                .open(self.relative(&stage.name))?;
            let metadata = file.metadata()?;
            stage.inode = Some((metadata.dev(), metadata.ino()));
            file.write_all(&bytes)?;
            file.sync_all()?;
            hook(PublicationPoint::StageSynced);
            self.verify()?;
            let final_name = format!("{id}.source-context.json");
            fs::hard_link(self.relative(&stage.name), self.relative(&final_name))?;
            hook(PublicationPoint::Linked);
            fs::remove_file(self.relative(&stage.name))?;
            hook(PublicationPoint::StageRemoved);
            self.directory.sync_all()?;
            hook(PublicationPoint::DirectorySynced);
            self.verify()?;
            // Recheck the published name against its held complete inode.
            let published = self.private_file(&final_name)?;
            ensure!(
                (published.metadata()?.dev(), published.metadata()?.ino())
                    == (file.metadata()?.dev(), file.metadata()?.ino()),
                "source publication changed"
            );
            Ok(())
        }
        pub(crate) fn read(&self, id: &str) -> Result<SignedSourceContext> {
            ensure!(valid_job_id(id), "invalid checkpoint job ID");
            let bytes = self.read_bounded(
                &format!("{id}.source-context.json"),
                MAX_SOURCE_CONTEXT_BYTES,
            )?;
            let context = SignedSourceContext::parse_bounded(&bytes)?;
            ensure!(
                serde_json::to_vec(&context)? == bytes,
                "noncanonical source context"
            );
            self.verify()?;
            Ok(context)
        }
        fn read_bounded(&self, name: &str, maximum: usize) -> Result<Vec<u8>> {
            let file = self.private_file(name)?;
            ensure!(
                file.metadata()?.len() <= maximum as u64,
                "oversized checkpoint record"
            );
            let mut bytes = Vec::new();
            file.take(maximum as u64 + 1).read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= maximum, "oversized checkpoint record");
            self.verify()?;
            Ok(bytes)
        }
        pub(crate) fn job(&self, id: &str) -> Result<crate::checkpoint_jobs::CheckpointJob> {
            ensure!(valid_job_id(id), "invalid checkpoint job ID");
            // Existing CheckpointJob record ceiling, independent of 16 KiB context.
            Ok(serde_json::from_slice(
                &self.read_bounded(&format!("{id}.json"), 64 * 1024)?,
            )?)
        }
        pub(crate) fn verify_archive(
            &self,
            id: &str,
            receipt: &LiveArchiveReceipt,
            max_bytes: u64,
            timeout: Duration,
        ) -> Result<()> {
            self.verified_archive_file(id, receipt, max_bytes, timeout)
                .map(drop)
        }
        /// Return the same verified held archive at offset zero. The caller
        /// retains directory/name provenance and admission after return; this
        /// is not a Ready-job, source-role or writer certification.
        pub(crate) fn verified_archive_file(
            &self,
            id: &str,
            receipt: &LiveArchiveReceipt,
            max_bytes: u64,
            timeout: Duration,
        ) -> Result<File> {
            self.verified_archive_file_hook(id, receipt, max_bytes, timeout, |_, _| {})
        }
        fn verified_archive_file_hook(
            &self,
            id: &str,
            receipt: &LiveArchiveReceipt,
            max_bytes: u64,
            timeout: Duration,
            after_read: impl FnOnce(&File, Instant),
        ) -> Result<File> {
            ensure!(valid_job_id(id), "invalid checkpoint job ID");
            let deadline = Instant::now()
                .checked_add(timeout)
                .context("invalid verification deadline")?;
            ensure!(Instant::now() < deadline, "archive verification timed out");
            let mut file = self.private_file(&format!("{id}.age"))?;
            let metadata = file.metadata()?;
            self.check_archive_metadata(&metadata)?;
            ensure!(
                metadata.len() == receipt.ciphertext_bytes && metadata.len() <= max_bytes,
                "archive size differs"
            );
            let mut hash = Sha256::new();
            let mut total = 0u64;
            let mut bytes = [0; 64 * 1024];
            loop {
                ensure!(Instant::now() < deadline, "archive verification timed out");
                let count = file.read(&mut bytes)?;
                if count == 0 {
                    break;
                }
                total = total
                    .checked_add(count as u64)
                    .context("archive size overflow")?;
                ensure!(total <= receipt.ciphertext_bytes, "archive grew");
                hash.update(&bytes[..count]);
            }
            ensure!(
                total == receipt.ciphertext_bytes
                    && hex::encode(hash.finalize()) == receipt.encrypted_archive_sha256,
                "archive digest differs"
            );
            after_read(&file, deadline);
            let current = self.private_file(&format!("{id}.age"))?.metadata()?;
            self.check_archive_metadata(&current)?;
            ensure!(
                archive_metadata_unchanged(&metadata, &current),
                "archive name changed"
            );
            self.verify()?;
            file.rewind()?;
            let held = file.metadata()?;
            self.check_archive_metadata(&held)?;
            ensure!(
                archive_metadata_unchanged(&metadata, &held),
                "held archive changed"
            );
            ensure!(Instant::now() < deadline, "archive verification timed out");
            Ok(file)
        }
        fn check_archive_metadata(&self, metadata: &fs::Metadata) -> Result<()> {
            ensure!(
                metadata.is_file()
                    && metadata.nlink() == 1
                    && metadata.mode() & 0o077 == 0
                    && metadata.uid() == fs::metadata("/proc/self")?.uid(),
                "unsafe held archive"
            );
            Ok(())
        }
    }
    fn archive_metadata_unchanged(original: &fs::Metadata, current: &fs::Metadata) -> bool {
        // Access time may change while reading; mutation timestamps may not.
        (
            original.dev(),
            original.ino(),
            original.len(),
            original.uid(),
            original.mode(),
            original.nlink(),
        ) == (
            current.dev(),
            current.ino(),
            current.len(),
            current.uid(),
            current.mode(),
            current.nlink(),
        ) && (
            original.mtime(),
            original.mtime_nsec(),
            original.ctime(),
            original.ctime_nsec(),
        ) == (
            current.mtime(),
            current.mtime_nsec(),
            current.ctime(),
            current.ctime_nsec(),
        )
    }
    #[cfg(test)]
    mod tests {
        include!("source_context_tests.rs");
    }
}
#[cfg(target_os = "linux")]
pub(crate) use filesystem::SourceDirectory;
#[cfg(not(target_os = "linux"))]
pub(crate) struct SourceDirectory;
#[cfg(not(target_os = "linux"))]
impl SourceDirectory {
    pub(crate) fn open(_: &std::path::Path) -> Result<Self> {
        anyhow::bail!("checkpoint source context requires Linux descriptor confinement")
    }
    pub(crate) fn publish(&self, _: &str, _: &SignedSourceContext) -> Result<()> {
        anyhow::bail!("unsupported platform")
    }
    pub(crate) fn read(&self, _: &str) -> Result<SignedSourceContext> {
        anyhow::bail!("unsupported platform")
    }
    pub(crate) fn job(&self, _: &str) -> Result<crate::checkpoint_jobs::CheckpointJob> {
        anyhow::bail!("unsupported platform")
    }
    pub(crate) fn verify_archive(
        &self,
        _: &str,
        _: &LiveArchiveReceipt,
        _: u64,
        _: std::time::Duration,
    ) -> Result<()> {
        anyhow::bail!("unsupported platform")
    }
    pub(crate) fn verified_archive_file(
        &self,
        _: &str,
        _: &LiveArchiveReceipt,
        _: u64,
        _: std::time::Duration,
    ) -> Result<std::fs::File> {
        anyhow::bail!("unsupported platform")
    }
}
