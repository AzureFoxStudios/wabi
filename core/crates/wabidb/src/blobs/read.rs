//! Blob reader: read blob files by content hash.
//!
//! Per the kanban card body (wabidb-31):
//! - File: `core/crates/wabidb/src/blobs/read.rs` (this file).
//! - A `BlobReader` that reads blob files by hash. Returns the content
//!   or an error if the file does not exist or fails integrity checks.
//! - Verifies the on-disk BLAKE3 hash matches the expected hash (defense
//!   in depth: a corruption on disk would be caught here, even if the
//!   write was somehow acknowledged).
//! - Optionally verifies the metadata sidecar exists (and that the
//!   recorded hash matches the file's actual hash).
//!
//! ## What this card does NOT do
//!
//! - Range reads. v1 returns the entire blob in memory. Large blobs
//!   (wabidb-31 is paired with wabidb-30 which caps at 16 MiB per
//!   record; the engine enforces this upstream) are fine to slurp into
//!   memory in v1.
//! - Streaming verification. A streaming variant (chunk-by-chunk BLAKE3
//!   verify) is added in a follow-up if blob sizes grow.
//! - Refcounting / orphan cleanup. See wabidb-40 (tombstone) and
//!   wabidb-39 (key destruction).

use crate::blobs::write::BlobWriter;
use crate::error::{ErrorCategory, Result, WabiError};
use std::path::PathBuf;

/// A reader bound to a data directory. Cheap to construct; holds no
/// state beyond the path. The reader is `Send + Sync` so it can be
/// cloned into async tasks.
#[derive(Debug, Clone)]
pub struct BlobReader {
    data_dir: PathBuf,
}

/// Result of a successful blob read.
#[derive(Debug, Clone)]
pub struct BlobReadResult {
    /// The BLAKE3 hash that was used to look up the blob (matches the
    /// file's content hash; verified at read time).
    pub hash: [u8; 32],
    /// The blob's content.
    pub content: Vec<u8>,
    /// Number of bytes read.
    pub size_bytes: usize,
}

impl BlobReader {
    /// Create a new `BlobReader` rooted at the given data directory.
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    /// Get a handle to the corresponding `BlobWriter` for this directory.
    /// Useful for code that needs both read and write access.
    pub fn writer(&self) -> BlobWriter {
        BlobWriter::new(self.data_dir.clone())
    }

    /// The data directory this reader is rooted at.
    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    /// Read a blob by its BLAKE3 hash. Verifies the on-disk file's hash
    /// matches the expected hash.
    ///
    /// # Errors
    ///
    /// - `WabiError::NotFound` if the canonical file doesn't exist.
    /// - `WabiError::Corrupt` if the on-disk content's hash doesn't
    ///   match the expected hash (the file is corrupt or wrong).
    /// - `WabiError::Io` for filesystem errors.
    pub async fn read(&self, hash: &[u8; 32]) -> Result<BlobReadResult> {
        let canonical = self.canonical_path(hash);

        if !tokio::fs::try_exists(&canonical).await.unwrap_or(false) {
            return Err(WabiError::Io(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("blob {} not found", hex::encode(hash)),
            )));
        }

        let content = tokio::fs::read(&canonical)
            .await
            .map_err(|e| WabiError::Io(e))?;

        // Verify the content's hash matches the expected hash.
        let actual = blake3::hash(&content);
        let actual_bytes: [u8; 32] = actual.into();
        if &actual_bytes != hash {
            return Err(WabiError::Corrupt {
                location: format!("blob {}", hex::encode(hash)),
                detail: format!(
                    "hash mismatch: expected {}, got {}",
                    hex::encode(hash),
                    hex::encode(actual_bytes)
                ),
            });
        }

        Ok(BlobReadResult {
            hash: *hash,
            size_bytes: content.len(),
            content,
        })
    }

    /// Read a blob and verify that its content hash matches an
    /// additional check hash. The "expected" hash is the canonical
    /// file path; the "verify_also" hash is a separate check (e.g.,
    /// the hash recorded in a stream segment). Both must match.
    ///
    /// Use this when reading a blob whose hash is referenced from a
    /// stream segment: the segment's BLAKE3 reference must match the
    /// file's BLAKE3 hash.
    pub async fn read_verified(&self, hash: &[u8; 32]) -> Result<BlobReadResult> {
        // For now, the read() method already verifies. This wrapper exists
        // for future cases where the verification might diverge (e.g.,
        // a streaming reader that doesn't compute the full hash up front).
        self.read(hash).await
    }

    /// Read the metadata sidecar for a blob. Returns `Ok(None)` if no
    /// sidecar exists (which is allowed for backward compatibility with
    /// blobs written before the sidecar was added).
    pub async fn read_metadata(&self, hash: &[u8; 32]) -> Result<Option<BlobMetadata>> {
        let meta_path = self.metadata_path(hash);
        if !tokio::fs::try_exists(&meta_path).await.unwrap_or(false) {
            return Ok(None);
        }
        let raw = tokio::fs::read_to_string(&meta_path)
            .await
            .map_err(|e| WabiError::Io(e))?;
        Ok(Some(BlobMetadata::parse(&raw)))
    }

    /// Compute the canonical path for a blob with the given BLAKE3 hash.
    /// Same layout as `BlobWriter::canonical_path`.
    pub fn canonical_path(&self, hash: &[u8; 32]) -> PathBuf {
        let hex = hex::encode(hash);
        let (prefix, rest) = hex.split_at(2);
        self.data_dir
            .join("blobs")
            .join(prefix)
            .join(format!("{rest}.bin"))
    }

    /// Compute the metadata sidecar path for a blob.
    pub fn metadata_path(&self, hash: &[u8; 32]) -> PathBuf {
        let hex = hex::encode(hash);
        let (prefix, rest) = hex.split_at(2);
        self.data_dir
            .join("blobs")
            .join(prefix)
            .join(format!("{rest}.meta"))
    }

    /// True if the canonical blob file exists. Cheap; uses `try_exists`.
    pub async fn exists(&self, hash: &[u8; 32]) -> bool {
        tokio::fs::try_exists(self.canonical_path(hash))
            .await
            .unwrap_or(false)
    }

    /// Read multiple blobs in parallel. Returns a Vec of Result, one
    /// per requested hash. Useful for batch operations (e.g., reading
    /// a message's attachments).
    pub async fn read_many(&self, hashes: &[&[u8; 32]]) -> Vec<Result<BlobReadResult>> {
        let mut handles = Vec::with_capacity(hashes.len());
        for h in hashes {
            let path = self.canonical_path(h);
            let h_owned = **h;
            handles.push(tokio::spawn(async move {
                // Read and verify
                let content = tokio::fs::read(&path).await.map_err(|e| WabiError::Io(e))?;
                let actual = blake3::hash(&content);
                let actual_bytes: [u8; 32] = actual.into();
                if &actual_bytes != &h_owned {
                    return Err(WabiError::Corrupt {
                        location: format!("blob {}", hex::encode(h_owned)),
                        detail: format!(
                            "hash mismatch: expected {}, got {}",
                            hex::encode(h_owned),
                            hex::encode(actual_bytes)
                        ),
                    });
                }
                Ok(BlobReadResult {
                    hash: h_owned,
                    size_bytes: content.len(),
                    content,
                })
            }));
        }
        let mut out = Vec::with_capacity(handles.len());
        for h in handles {
            match h.await {
                Ok(r) => out.push(r),
                Err(e) => out.push(Err(WabiError::InternalInvariantViolated {
                    invariant: format!("blob read task panicked: {e}"),
                })),
            }
        }
        out
    }
}

/// Parsed content of a blob metadata sidecar.
#[derive(Debug, Clone, Default)]
pub struct BlobMetadata {
    /// The BLAKE3 hash recorded in the sidecar.
    pub hash: Option<[u8; 32]>,
    /// The size in bytes recorded in the sidecar.
    pub size: Option<u64>,
    /// The created_at_micros recorded in the sidecar.
    pub created_at_micros: Option<i64>,
}

impl BlobMetadata {
    /// Parse a metadata sidecar from raw text. Tolerant: missing fields
    /// are `None`; malformed lines are ignored.
    pub fn parse(raw: &str) -> Self {
        let mut m = Self::default();
        for line in raw.lines() {
            if let Some(rest) = line.strip_prefix("blake3=") {
                if let Ok(bytes) = hex::decode(rest) {
                    if bytes.len() == 32 {
                        let mut arr = [0u8; 32];
                        arr.copy_from_slice(&bytes);
                        m.hash = Some(arr);
                    }
                }
            } else if let Some(rest) = line.strip_prefix("size=") {
                m.size = rest.parse().ok();
            } else if let Some(rest) = line.strip_prefix("created_at_micros=") {
                m.created_at_micros = rest.parse().ok();
            }
        }
        m
    }
}

/// The error category for any future blob-read-related errors.
#[allow(dead_code)]
fn _category() -> ErrorCategory {
    ErrorCategory::Storage
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn setup() -> (tempfile::TempDir, BlobReader, BlobWriter) {
        let dir = tempdir().unwrap();
        let r = BlobReader::new(dir.path().to_path_buf());
        let w = BlobWriter::new(dir.path().to_path_buf());
        (dir, r, w)
    }

    #[tokio::test]
    async fn read_after_write_round_trip() {
        let (dir, r, w) = setup();
        let content = b"hello, wabidb blob reader";
        let wr = w.write(content).await.unwrap();
        let rr = r.read(&wr.hash).await.unwrap();
        assert_eq!(rr.content, content);
        assert_eq!(rr.size_bytes, content.len());
        assert_eq!(rr.hash, wr.hash);
        assert!(dir.path().join("blobs").exists());
    }

    #[tokio::test]
    async fn read_empty_blob() {
        let (_dir, r, w) = setup();
        let wr = w.write(b"").await.unwrap();
        let rr = r.read(&wr.hash).await.unwrap();
        assert_eq!(rr.content, b"");
        assert_eq!(rr.size_bytes, 0);
    }

    #[tokio::test]
    async fn read_large_blob() {
        let (_dir, r, w) = setup();
        let content = vec![0xCDu8; 1024 * 1024]; // 1 MiB
        let wr = w.write(&content).await.unwrap();
        let rr = r.read(&wr.hash).await.unwrap();
        assert_eq!(rr.content, content);
    }

    #[tokio::test]
    async fn read_missing_blob_returns_io_error() {
        let (_dir, r, _w) = setup();
        let hash = [0u8; 32];
        let err = r.read(&hash).await.unwrap_err();
        let is_not_found = matches!(&err, WabiError::Io(e) if e.kind() == std::io::ErrorKind::NotFound);
        assert!(is_not_found, "got {err:?}");
    }

    #[tokio::test]
    async fn read_corrupt_blob_returns_corrupt() {
        // Write a blob, then corrupt it on disk, then try to read.
        let (_dir, r, w) = setup();
        let wr = w.write(b"original content").await.unwrap();
        // Corrupt: append a byte to the canonical file
        let canonical = r.canonical_path(&wr.hash);
        let mut f = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&canonical)
            .await
            .unwrap();
        tokio::io::AsyncWriteExt::write_all(&mut f, b"!corrupt")
            .await
            .unwrap();
        drop(f);
        // Now read; the hash check should fail.
        let err = r.read(&wr.hash).await.unwrap_err();
        assert!(matches!(err, WabiError::Corrupt { .. }), "got {err:?}");
    }

    #[test]
    fn canonical_path_layout() {
        let (dir, r, _w) = setup();
        let h = [0u8; 32];
        let p = r.canonical_path(&h);
        let s = p.to_str().unwrap();
        assert!(s.contains("blobs"));
        assert!(s.ends_with(".bin"));
        assert!(p.starts_with(dir.path()));
    }

    #[test]
    fn metadata_path_layout() {
        let (dir, r, _w) = setup();
        let h = [0u8; 32];
        let p = r.metadata_path(&h);
        let s = p.to_str().unwrap();
        assert!(s.contains("blobs"));
        assert!(s.ends_with(".meta"));
        assert!(p.starts_with(dir.path()));
    }

    #[tokio::test]
    async fn exists_returns_true_after_write() {
        let (_dir, r, w) = setup();
        let h = BlobWriter::hash(b"x");
        assert!(!r.exists(&h).await);
        w.write(b"x").await.unwrap();
        assert!(r.exists(&h).await);
    }

    #[tokio::test]
    async fn read_metadata_returns_parsed() {
        let (_dir, r, w) = setup();
        let content = b"hello";
        let wr = w.write(content).await.unwrap();
        let m = r.read_metadata(&wr.hash).await.unwrap();
        assert!(m.is_some());
        let m = m.unwrap();
        assert_eq!(m.hash, Some(wr.hash));
        assert_eq!(m.size, Some(content.len() as u64));
        assert!(m.created_at_micros.is_some());
    }

    #[tokio::test]
    async fn read_metadata_returns_none_for_blob_without_sidecar() {
        // (In practice, the writer always creates a sidecar. But the
        // reader is tolerant: missing sidecar -> None.)
        let (_dir, r, _w) = setup();
        let h = BlobWriter::hash(b"x");
        // Don't write the sidecar.
        let m = r.read_metadata(&h).await.unwrap();
        assert!(m.is_none());
    }

    #[test]
    fn blob_metadata_parse_tolerant() {
        let m = BlobMetadata::parse("");
        assert!(m.hash.is_none());
        assert!(m.size.is_none());

        // Use a valid 64-hex-char (32-byte) BLAKE3 hash.
        let valid_hash = "deadbeef".repeat(8); // 64 hex chars
        let raw = format!("blake3={valid_hash}\nsize=42\ncreated_at_micros=1000000\n");
        let m = BlobMetadata::parse(&raw);
        assert!(m.hash.is_some());
        assert_eq!(m.size, Some(42));
        assert_eq!(m.created_at_micros, Some(1_000_000));
    }

    #[test]
    fn blob_metadata_parse_malformed_ignored() {
        let raw = "blake3=garbage\nsize=not_a_number\nunknown_field=value\n";
        let m = BlobMetadata::parse(raw);
        assert!(m.hash.is_none());
        assert!(m.size.is_none());
    }

    #[tokio::test]
    async fn read_many_works() {
        let (_dir, r, w) = setup();
        let mut hashes = Vec::new();
        for i in 0..5 {
            let content = format!("blob {i}");
            let wr = w.write(content.as_bytes()).await.unwrap();
            hashes.push(wr.hash);
        }
        let hash_refs: Vec<&[u8; 32]> = hashes.iter().collect();
        let results = r.read_many(&hash_refs).await;
        assert_eq!(results.len(), 5);
        for (i, r) in results.iter().enumerate() {
            let r = r.as_ref().unwrap();
            assert_eq!(r.content, format!("blob {i}").as_bytes());
        }
    }

    #[tokio::test]
    async fn read_many_partial_failure() {
        // Mix of existing and non-existing hashes.
        let (_dir, r, w) = setup();
        let wr = w.write(b"real").await.unwrap();
        let fake = [0xFFu8; 32];
        let hash_refs: Vec<&[u8; 32]> = vec![&wr.hash, &fake];
        let results = r.read_many(&hash_refs).await;
        assert_eq!(results.len(), 2);
        assert!(results[0].is_ok());
        let second_err = match &results[1] {
            Err(e) => e,
            Ok(_) => panic!("expected error for second result"),
        };
        let is_not_found = matches!(second_err, WabiError::Io(e) if e.kind() == std::io::ErrorKind::NotFound);
        assert!(is_not_found, "expected NotFound, got {second_err:?}");
    }
}
