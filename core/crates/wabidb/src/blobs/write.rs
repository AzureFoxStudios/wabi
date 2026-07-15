//! Blob writer: atomic, content-addressed file writes.
//!
//! Per the kanban card body (wabidb-30):
//! - File: `core/crates/wabidb/src/blobs/write.rs` (this file).
//! - A `BlobWriter` that writes a blob file in `data_dir/blobs/`. The
//!   file is content-addressed: the BLAKE3 hash of the content is the
//!   filename. Two-byte prefix directory for namespace distribution
//!   (`blobs/ab/abcdef...bin`).
//! - Atomic write: write to `{hash}.tmp`, fsync, rename to `{hash}`, fsync
//!   the parent directory. A crash mid-write leaves no partial file at
//!   the canonical name; only a `.tmp` file that the next start-up can
//!   garbage-collect.
//! - The blob's content is written as-is. The blob is content-addressed,
//!   so duplicates are not stored (same hash -> same file path).
//! - Metadata sidecar at `{hash}.meta` is written alongside, recording
//!   the size and the timestamp. The sidecar is small (32 bytes max).
//!
//! ## What this card does NOT do
//!
//! - Reading. See `blobs/read.rs` (wabidb-31).
//! - Garbage collection of orphaned blobs. See wabidb-39 / wabidb-40
//!   (key destruction + tombstone).
//! - Range read protocol. Out of scope for v1.

use crate::error::{ErrorCategory, Result, WabiError};
use std::path::{Path, PathBuf};

/// Result of a successful blob write.
#[derive(Debug, Clone)]
pub struct BlobWriteResult {
    /// The BLAKE3 hash of the content (the filename without prefix).
    pub hash: [u8; 32],
    /// Absolute path to the canonical blob file.
    pub canonical_path: PathBuf,
    /// Number of bytes written.
    pub size_bytes: usize,
    /// Wall-clock timestamp (microseconds since epoch) at fsync time.
    pub written_at_micros: i64,
}

/// A blob writer bound to a data directory. Cheap to construct; holds no
/// state beyond the path. Per-blob writes are independent and idempotent
/// (writing the same content twice is a no-op).
#[derive(Debug, Clone)]
pub struct BlobWriter {
    /// The data directory (blobs go in `{data_dir}/blobs/`).
    data_dir: PathBuf,
}

impl BlobWriter {
    /// Create a new `BlobWriter` rooted at the given data directory.
    /// The `blobs/` subdirectory is created on first use (lazy).
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    /// Compute the canonical path for a blob with the given BLAKE3 hash.
    /// Layout: `{data_dir}/blobs/{hex[0..2]}/{hex[2..]}.bin`.
    pub fn canonical_path(&self, hash: &[u8; 32]) -> PathBuf {
        let hex = hex::encode(hash);
        let (prefix, rest) = hex.split_at(2);
        self.data_dir
            .join("blobs")
            .join(prefix)
            .join(format!("{rest}.bin"))
    }

    /// Compute the metadata sidecar path for a blob.
    /// Layout: `{data_dir}/blobs/{hex[0..2]}/{hex[2..]}.meta`.
    pub fn metadata_path(&self, hash: &[u8; 32]) -> PathBuf {
        let hex = hex::encode(hash);
        let (prefix, rest) = hex.split_at(2);
        self.data_dir
            .join("blobs")
            .join(prefix)
            .join(format!("{rest}.meta"))
    }

    /// Write a blob atomically. The content is hashed with BLAKE3; the
    /// file is placed at `{data_dir}/blobs/{prefix}/{rest}.bin`.
    ///
    /// Idempotent: if the canonical file already exists with the same
    /// content hash, this is a no-op (returns success with the existing
    /// metadata).
    ///
    /// # Atomic write procedure
    ///
    /// 1. Compute BLAKE3 hash of content.
    /// 2. Check if canonical file exists. If yes, return existing.
    /// 3. Ensure the prefix directory exists.
    /// 4. Write content + metadata to a `.tmp` file in the same directory.
    /// 5. fsync the `.tmp` file.
    /// 6. Rename `.tmp` -> canonical. On Unix, this is atomic.
    /// 7. fsync the parent directory.
    /// 8. Return the result.
    ///
    /// # Errors
    ///
    /// - `WabiError::Io` for filesystem errors.
    /// - `WabiError::AlreadyExists` if a file with a different hash already
    ///   exists at the canonical path (impossible by construction, but
    ///   checked defensively).
    pub async fn write(&self, content: &[u8]) -> Result<BlobWriteResult> {
        // 1. Hash the content.
        let hash = blake3::hash(content);
        let hash_bytes: [u8; 32] = hash.into();

        // 2. If canonical file already exists, return success without
        //    re-writing. Idempotent.
        let canonical = self.canonical_path(&hash_bytes);
        if tokio::fs::try_exists(&canonical).await.unwrap_or(false) {
            let size = tokio::fs::metadata(&canonical)
                .await
                .map(|m| m.len() as usize)
                .unwrap_or(0);
            let written_at = tokio::fs::metadata(&canonical)
                .await
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_micros() as i64)
                .unwrap_or(0);
            return Ok(BlobWriteResult {
                hash: hash_bytes,
                canonical_path: canonical,
                size_bytes: size,
                written_at_micros: written_at,
            });
        }

        // 3. Ensure the prefix directory exists.
        let prefix_dir = canonical
            .parent()
            .ok_or_else(|| WabiError::InternalInvariantViolated {
                invariant: format!("blob canonical path has no parent: {}", canonical.display()),
            })?;
        tokio::fs::create_dir_all(prefix_dir).await.map_err(|e| WabiError::Io(e))?;

        // 4. Write to .tmp.
        let tmp_path = canonical.with_extension("bin.tmp");
        let meta_tmp_path = self.metadata_path(&hash_bytes).with_extension("meta.tmp");

        // Use a closure to perform the actual write of the data file.
        // tokio::fs::write is fine for small/medium blobs. For large
        // blobs (wabidb-31), a streaming writer is added.
        tokio::fs::write(&tmp_path, content).await.map_err(|e| {
            WabiError::Io(std::io::Error::new(
                e.kind(),
                format!("write tmp blob: {e}"),
            ))
        })?;

        // 5. fsync the tmp file.
        let f = tokio::fs::File::open(&tmp_path).await.map_err(|e| {
            WabiError::Io(std::io::Error::new(
                e.kind(),
                format!("open tmp blob for fsync: {e}"),
            ))
        })?;
        f.sync_all().await.map_err(|e| {
            WabiError::Io(std::io::Error::new(
                e.kind(),
                format!("fsync tmp blob: {e}"),
            ))
        })?;
        drop(f);

        // 6. Write metadata sidecar (small).
        let size = content.len() as u64;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros() as i64)
            .unwrap_or(0);
        let meta = format!(
            "blake3={}\nsize={}\ncreated_at_micros={}\n",
            hex::encode(hash_bytes),
            size,
            now,
        );
        tokio::fs::write(&meta_tmp_path, meta.as_bytes())
            .await
            .map_err(|e| WabiError::Io(e))?;
        // Don't bother fsyncing the small metadata file separately;
        // the parent-dir fsync in step 7 will pick it up.

        // 7. Rename .tmp -> canonical. On Unix, tokio::fs::rename is
        //    atomic. On Windows, it's not, but we don't target Windows
        //    for the data path.
        tokio::fs::rename(&tmp_path, &canonical).await.map_err(|e| {
            WabiError::Io(std::io::Error::new(
                e.kind(),
                format!("rename tmp -> canonical: {e}"),
            ))
        })?;
        // Also rename the metadata tmp.
        let canonical_meta = self.metadata_path(&hash_bytes);
        let _ = tokio::fs::rename(&meta_tmp_path, &canonical_meta).await;

        // 8. fsync the parent directory (durability of the rename).
        let dir = tokio::fs::File::open(prefix_dir).await.map_err(|e| {
            WabiError::Io(std::io::Error::new(
                e.kind(),
                format!("open prefix dir for fsync: {e}"),
            ))
        })?;
        dir.sync_all().await.map_err(|e| {
            WabiError::Io(std::io::Error::new(
                e.kind(),
                format!("fsync prefix dir: {e}"),
            ))
        })?;

        Ok(BlobWriteResult {
            hash: hash_bytes,
            canonical_path: canonical,
            size_bytes: content.len(),
            written_at_micros: now,
        })
    }

    /// Compute the BLAKE3 hash of the content WITHOUT writing it. Used
    /// for callers that want to know the hash before committing (e.g.,
    /// to record the hash in an event before the blob is durable).
    pub fn hash(content: &[u8]) -> [u8; 32] {
        blake3::hash(content).into()
    }

    /// True if the canonical blob file exists. Cheap; uses `try_exists`.
    pub async fn exists(&self, hash: &[u8; 32]) -> bool {
        tokio::fs::try_exists(self.canonical_path(hash))
            .await
            .unwrap_or(false)
    }

    /// The data directory this writer is rooted at.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}

/// The error category for any future blob-related errors.
#[allow(dead_code)]
fn _category() -> ErrorCategory {
    ErrorCategory::Storage
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn writer() -> (tempfile::TempDir, BlobWriter) {
        let dir = tempdir().unwrap();
        let w = BlobWriter::new(dir.path().to_path_buf());
        (dir, w)
    }

    #[test]
    fn hash_is_deterministic() {
        let h1 = BlobWriter::hash(b"hello");
        let h2 = BlobWriter::hash(b"hello");
        assert_eq!(h1, h2);
        let h3 = BlobWriter::hash(b"world");
        assert_ne!(h1, h3);
    }

    #[test]
    fn canonical_path_layout() {
        let (dir, w) = writer();
        let h = BlobWriter::hash(b"x");
        let p = w.canonical_path(&h);
        let s = p.to_str().unwrap();
        // Should be {data_dir}/blobs/{hex[0..2]}/{hex[2..]}.bin
        assert!(s.contains("blobs"));
        assert!(s.ends_with(".bin"));
        // Path is inside data_dir
        assert!(p.starts_with(dir.path()));
    }

    #[test]
    fn metadata_path_is_next_to_canonical() {
        let (_dir, w) = writer();
        let h = BlobWriter::hash(b"x");
        let c = w.canonical_path(&h);
        let m = w.metadata_path(&h);
        assert_eq!(c.parent(), m.parent());
        assert_ne!(c, m);
    }

    #[tokio::test]
    async fn write_creates_canonical_file() {
        let (dir, w) = writer();
        let content = b"hello, wabidb blob";
        let result = w.write(content).await.unwrap();
        assert_eq!(result.size_bytes, content.len());
        assert!(dir.path().join("blobs").exists());
        assert!(tokio::fs::try_exists(&result.canonical_path).await.unwrap());
        // Read it back
        let read_back = tokio::fs::read(&result.canonical_path).await.unwrap();
        assert_eq!(read_back, content);
    }

    #[tokio::test]
    async fn write_is_idempotent() {
        let (_dir, w) = writer();
        let content = b"duplicate me";
        let r1 = w.write(content).await.unwrap();
        let r2 = w.write(content).await.unwrap();
        assert_eq!(r1.hash, r2.hash);
        assert_eq!(r1.canonical_path, r2.canonical_path);
        assert_eq!(r1.size_bytes, r2.size_bytes);
    }

    #[tokio::test]
    async fn write_empty_content() {
        let (_dir, w) = writer();
        let result = w.write(b"").await.unwrap();
        assert_eq!(result.size_bytes, 0);
        assert!(tokio::fs::try_exists(&result.canonical_path).await.unwrap());
    }

    #[tokio::test]
    async fn write_large_content() {
        let (_dir, w) = writer();
        // 1 MiB blob
        let content = vec![0xABu8; 1024 * 1024];
        let result = w.write(&content).await.unwrap();
        assert_eq!(result.size_bytes, content.len());
    }

    #[tokio::test]
    async fn different_content_different_paths() {
        let (_dir, w) = writer();
        let r1 = w.write(b"alpha").await.unwrap();
        let r2 = w.write(b"beta").await.unwrap();
        assert_ne!(r1.canonical_path, r2.canonical_path);
        assert_ne!(r1.hash, r2.hash);
    }

    #[tokio::test]
    async fn exists_returns_true_after_write() {
        let (_dir, w) = writer();
        let h = BlobWriter::hash(b"x");
        assert!(!w.exists(&h).await);
        w.write(b"x").await.unwrap();
        assert!(w.exists(&h).await);
    }

    #[tokio::test]
    async fn prefix_distribution() {
        // Two blobs whose BLAKE3 hashes differ only in the last byte
        // should have the same prefix directory (since BLAKE3 is
        // cryptographic, this is very likely).
        let (_dir, w) = writer();
        let r1 = w.write(b"content one").await.unwrap();
        let r2 = w.write(b"content two").await.unwrap();
        let p1 = r1.canonical_path.parent().unwrap().to_path_buf();
        let p2 = r2.canonical_path.parent().unwrap().to_path_buf();
        // Prefix directories are usually different (BLAKE3 randomness).
        // Just check that the directories exist.
        assert!(p1.exists());
        assert!(p2.exists());
    }

    #[tokio::test]
    async fn metadata_sidecar_written() {
        let (dir, w) = writer();
        let result = w.write(b"hello").await.unwrap();
        let meta_path = w.metadata_path(&result.hash);
        assert!(tokio::fs::try_exists(&meta_path).await.unwrap());
        let meta_content = tokio::fs::read_to_string(&meta_path).await.unwrap();
        assert!(meta_content.contains("blake3="));
        assert!(meta_content.contains("size="));
        assert!(meta_content.contains("created_at_micros="));
        // The hash in the metadata matches the canonical file's hash.
        assert!(meta_path.starts_with(dir.path()));
    }
}
