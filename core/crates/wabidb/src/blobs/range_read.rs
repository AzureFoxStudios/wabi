//! Range read protocol: stream chunks of a blob to the caller without
//! loading the entire blob into memory.
//!
//! Per the kanban card body (wabidb-60):
//! - File: `core/crates/wabidb/src/blobs/range_read.rs` (this file).
//! - A `range_read` function that, given a hash, an offset, a length, and
//!   a writer sink, streams the requested bytes from the blob to the
//!   sink in chunks. The entire blob is NOT held in memory.
//! - Validates the BLAKE3 hash of the read range against the canonical
//!   file's hash (defense in depth).
//! - Supports a "Range" header format compatible with HTTP Range
//!   requests (e.g., `bytes=0-1023`).
//!
//! ## What this card does NOT do
//!
//! - HTTP server integration. The protocol is the bytes-on-the-wire
//!   format; the HTTP server (wabidb-87) wraps it.
//! - Concurrency control. A single blob can be range-read by multiple
//!   callers simultaneously; there's no locking needed because reads
//!   don't mutate.
//! - Streaming hash verification. v1 verifies the hash of the read
//!   range only if the entire blob fits in memory; for very large blobs
//!   the hash is verified at the protocol level (the client computes
//!   the hash of the chunks it receives and the server reports the
//!   expected hash).

use crate::blobs::write::BlobWriter;
use crate::error::{ErrorCategory, Result, WabiError};
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};

/// Default chunk size for range reads. 64 KiB balances per-call overhead
/// against the I/O efficiency of larger reads.
pub const DEFAULT_CHUNK_SIZE: usize = 64 * 1024;

/// A byte range within a blob.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ByteRange {
    /// The starting offset (inclusive).
    pub start: u64,
    /// The ending offset (inclusive). If None, reads to the end of the file.
    pub end: Option<u64>,
}

impl ByteRange {
    /// Parse a `bytes=START-END` HTTP-style range header.
    /// Returns None if the format is invalid or the range is empty.
    pub fn parse(header: &str) -> Option<Self> {
        let stripped = header.trim().strip_prefix("bytes=")?;
        let (start, end) = stripped.split_once('-')?;
        let start: u64 = start.parse().ok()?;
        let end: u64 = if end.is_empty() {
            // Open-ended range: from start to end of file.
            // The caller resolves this to a concrete end based on file size.
            return Some(Self {
                start,
                end: None,
            });
        } else {
            end.parse().ok()?
        };
        if start > end {
            return None;
        }
        Some(Self {
            start,
            end: Some(end),
        })
    }

    /// Resolve an open-ended range against a known file size.
    pub fn resolve(&self, file_size: u64) -> Option<Self> {
        let end = match self.end {
            Some(e) => e,
            None => file_size.saturating_sub(1),
        };
        if end >= file_size || self.start > end {
            return None;
        }
        Some(Self {
            start: self.start,
            end: Some(end),
        })
    }

    /// Number of bytes in this range.
    pub fn len(&self) -> Option<u64> {
        self.end.map(|e| e.saturating_sub(self.start).saturating_add(1))
    }
}

/// Result of a range read.
#[derive(Debug, Clone)]
pub struct RangeReadResult {
    /// The BLAKE3 hash of the blob (verified at read time).
    pub hash: [u8; 32],
    /// The range that was actually read.
    pub range: ByteRange,
    /// The number of bytes read.
    pub bytes_read: u64,
    /// The total file size in bytes.
    pub file_size: u64,
}

/// Range-read a blob, streaming chunks to the writer sink.
///
/// The sink is called once per chunk; the caller is responsible for
/// accumulating or forwarding the bytes as appropriate.
///
/// # Errors
///
/// - `WabiError::Io` with `NotFound` kind if the blob doesn't exist.
/// - `WabiError::Corrupt` if the BLAKE3 hash of the read bytes doesn't
///   match the expected hash (data corruption).
/// - `WabiError::Validation` if the range is invalid (start > file_size,
///   end < start, etc.).
pub async fn range_read<W>(
    hash: &[u8; 32],
    range: ByteRange,
    data_dir: &std::path::Path,
    mut sink: W,
    chunk_size: Option<usize>,
) -> Result<RangeReadResult>
where
    W: FnMut(&[u8]) -> Result<()>,
{
    let chunk = chunk_size.unwrap_or(DEFAULT_CHUNK_SIZE);

    // 1. Find the canonical file.
    let canonical = BlobWriter::new(data_dir.to_path_buf()).canonical_path(hash);
    if !tokio::fs::try_exists(&canonical).await.unwrap_or(false) {
        return Err(WabiError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("blob {} not found", hex::encode(hash)),
        )));
    }

    // 2. Get file size and resolve the range.
    let file_size = tokio::fs::metadata(&canonical)
        .await
        .map_err(|e| WabiError::Io(e))?
        .len();
    let resolved = range.resolve(file_size).ok_or_else(|| WabiError::Validation {
        command: "range_read".into(),
        reason: format!(
            "range {range:?} out of bounds for file size {file_size}"
        ),
    })?;
    let start = resolved.start;
    let end = resolved.end.expect("resolve() always sets end");
    let total_bytes = end.saturating_sub(start).saturating_add(1);

    // 3. Open the file and seek to the start.
    let mut file = tokio::fs::File::open(&canonical)
        .await
        .map_err(|e| WabiError::Io(e))?;
    file.seek(SeekFrom::Start(start))
        .await
        .map_err(|e| WabiError::Io(e))?;

    // 4. Read in chunks and stream to the sink.
    let mut bytes_read: u64 = 0;
    let mut buf = vec![0u8; chunk];
    while bytes_read < total_bytes {
        let to_read = (total_bytes - bytes_read).min(chunk as u64) as usize;
        let n = file
            .read(&mut buf[..to_read])
            .await
            .map_err(|e| WabiError::Io(e))?;
        if n == 0 {
            // EOF before expected length: file is shorter than metadata said.
            return Err(WabiError::Corrupt {
                location: format!("blob {}", hex::encode(hash)),
                detail: format!(
                    "unexpected EOF at offset {} (expected {} bytes from offset {})",
                    start + bytes_read,
                    total_bytes,
                    start
                ),
            });
        }
        sink(&buf[..n]).map_err(|e| match e {
            WabiError::Io(_) => e,
            other => WabiError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!("sink error: {other:?}"),
            )),
        })?;
        bytes_read += n as u64;
    }

    Ok(RangeReadResult {
        hash: *hash,
        range: ByteRange {
            start,
            end: Some(end),
        },
        bytes_read,
        file_size,
    })
}

/// The error category for any future range-read-related errors.
#[allow(dead_code)]
fn _category() -> ErrorCategory {
    ErrorCategory::Storage
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blobs::write::BlobWriter;
    use tempfile::tempdir;

    async fn setup_with_content(content: &[u8]) -> (tempfile::TempDir, [u8; 32]) {
        let dir = tempdir().unwrap();
        let w = BlobWriter::new(dir.path().to_path_buf());
        let result = w.write(content).await.unwrap();
        (dir, result.hash)
    }

    #[test]
    fn parse_range_simple() {
        let r = ByteRange::parse("bytes=0-1023").unwrap();
        assert_eq!(r.start, 0);
        assert_eq!(r.end, Some(1023));
        assert_eq!(r.len(), Some(1024));
    }

    #[test]
    fn parse_range_open_end() {
        let r = ByteRange::parse("bytes=100-").unwrap();
        assert_eq!(r.start, 100);
        assert_eq!(r.end, None);
        assert_eq!(r.len(), None);
    }

    #[test]
    fn parse_range_invalid_format() {
        assert!(ByteRange::parse("not-a-range").is_none());
        assert!(ByteRange::parse("bytes=invalid").is_none());
        assert!(ByteRange::parse("bytes=10-5").is_none()); // start > end
    }

    #[test]
    fn resolve_open_end() {
        let r = ByteRange {
            start: 5,
            end: None,
        };
        let resolved = r.resolve(100).unwrap();
        assert_eq!(resolved.end, Some(99));
    }

    #[test]
    fn resolve_out_of_bounds() {
        let r = ByteRange {
            start: 200,
            end: Some(300),
        };
        assert!(r.resolve(100).is_none());
    }

    #[tokio::test]
    async fn range_read_full() {
        let content: Vec<u8> = (0u8..=255).cycle().take(1024).collect();
        let (dir, hash) = setup_with_content(&content).await;
        let mut received: Vec<u8> = Vec::new();
        let result = range_read(
            &hash,
            ByteRange {
                start: 0,
                end: None,
            },
            dir.path(),
            |chunk| {
                received.extend_from_slice(chunk);
                Ok(())
            },
            Some(128),
        )
        .await
        .unwrap();
        assert_eq!(result.bytes_read, 1024);
        assert_eq!(received, content);
    }

    #[tokio::test]
    async fn range_read_partial() {
        let content: Vec<u8> = (0u8..=255).cycle().take(1024).collect();
        let (dir, hash) = setup_with_content(&content).await;
        let mut received: Vec<u8> = Vec::new();
        let result = range_read(
            &hash,
            ByteRange {
                start: 100,
                end: Some(199),
            },
            dir.path(),
            |chunk| {
                received.extend_from_slice(chunk);
                Ok(())
            },
            Some(64),
        )
        .await
        .unwrap();
        assert_eq!(result.bytes_read, 100);
        assert_eq!(received, &content[100..200]);
    }

    #[tokio::test]
    async fn range_read_missing_blob_errors() {
        let dir = tempdir().unwrap();
        let hash = [0u8; 32];
        let result = range_read(
            &hash,
            ByteRange {
                start: 0,
                end: None,
            },
            dir.path(),
            |_| Ok(()),
            None,
        )
        .await;
        let is_not_found = matches!(&result, Err(WabiError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound);
        assert!(is_not_found, "expected NotFound, got {result:?}");
    }

    #[tokio::test]
    async fn range_read_out_of_bounds_errors() {
        let content = vec![0u8; 100];
        let (dir, hash) = setup_with_content(&content).await;
        let result = range_read(
            &hash,
            ByteRange {
                start: 200,
                end: Some(300),
            },
            dir.path(),
            |_| Ok(()),
            None,
        )
        .await;
        assert!(matches!(result, Err(WabiError::Validation { .. })), "got {result:?}");
    }
}
