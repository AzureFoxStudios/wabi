//! Commit index fsync batcher.
//!
//! Batches incoming commit index entries and flushes them to `.widx` files
//! on a configurable batch size (default 10) or maximum age (default 50 ms).
//! Rotates files at 10 000 entries per file, in accordance with the
//! [`STORAGE_FORMAT.md`](https://docs/STORAGE_FORMAT.md) §3 spec.
//!
//! ## On-disk layout (per file)
//!
//! ```text
//! [0..16)   file header  (magic, version, flags, entry_count, header_crc32c)
//! [16..)    entries…     (each prefixed by CommitIndexEntry::encode())
//! [..32)    file trailer (highest_commit_seq, file_crc32c, reserved)
//! ```

use crate::commit_index::record::{
    CommitIndexEntry, COMMIT_INDEX_FORMAT_VERSION, COMMIT_INDEX_MAGIC,
};
use crate::error::{Result, WabiError};
use crate::storage::fsync::fsync_dir;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BATCH_SIZE: usize = 10;
const DEFAULT_MAX_AGE_MS: u64 = 50;
const ENTRIES_PER_FILE: u32 = 10_000;
const FILE_HEADER_LEN: usize = 16;
const FILE_TRAILER_LEN: usize = 32;

// ---------------------------------------------------------------------------
// BatcherHandle — public API for submitting entries
// ---------------------------------------------------------------------------

/// Handle that drives the commit batcher from the outside.
///
/// Clone this handle to let multiple producers submit entries.
#[derive(Debug, Clone)]
pub struct BatcherHandle {
    tx: mpsc::UnboundedSender<BatcherMessage>,
}

impl BatcherHandle {
    /// Submit a single entry to be batched and eventually flushed.
    pub fn submit(&self, entry: CommitIndexEntry) -> Result<()> {
        self.tx.send(BatcherMessage::Entry(entry)).map_err(|_| {
            WabiError::InternalInvariantViolated {
                invariant: "commit batcher message channel closed".into(),
            }
        })
    }

    /// Explicitly flush all **currently buffered** entries to disk.
    ///
    /// Returns once the flush has completed (entries are fsync'd).
    pub async fn flush_now(&self) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(BatcherMessage::Flush(tx)).map_err(|_| {
            WabiError::InternalInvariantViolated {
                invariant: "commit batcher message channel closed".into(),
            }
        })?;
        rx.await.map_err(|_| WabiError::InternalInvariantViolated {
            invariant: "commit batcher flush oneshot cancelled".into(),
        })?
    }
}

// ---------------------------------------------------------------------------
// Internal message type
// ---------------------------------------------------------------------------

enum BatcherMessage {
    Entry(CommitIndexEntry),
    Flush(oneshot::Sender<Result<()>>),
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/// Create a new commit batcher.
///
/// Returns a [`BatcherHandle`] for submitting entries and a `Future` that
/// drives the batching loop.  The caller should `tokio::spawn` the future.
pub fn new_batcher(
    dir_path: PathBuf,
    batch_size: Option<usize>,
    max_age: Option<Duration>,
) -> (BatcherHandle, impl std::future::Future<Output = Result<()>>) {
    let batch_size = batch_size.unwrap_or(DEFAULT_BATCH_SIZE);
    let max_age = max_age.unwrap_or(Duration::from_millis(DEFAULT_MAX_AGE_MS));

    let (tx, rx) = mpsc::unbounded_channel();
    let handle = BatcherHandle { tx };
    let fut = run_batcher(dir_path, batch_size, max_age, rx);

    (handle, fut)
}

// ---------------------------------------------------------------------------
// Core run loop
// ---------------------------------------------------------------------------

async fn run_batcher(
    dir_path: PathBuf,
    batch_size: usize,
    max_age: Duration,
    mut rx: mpsc::UnboundedReceiver<BatcherMessage>,
) -> Result<()> {
    let mut buffer: Vec<CommitIndexEntry> = Vec::with_capacity(batch_size);
    let mut file: Option<FileState> = None;
    let mut flush_deadline: Option<Instant> = None;
    // Resume from the highest existing `.widx` file on disk so a fresh
    // batcher never collides with an already-written `NNNNNNNN.widx`
    // (the caller may not pass a starting sequence, but files persist
    // across restarts and across logical streams). An empty directory
    // keeps the legacy `0` start so the first file is `00000000.widx`.
    let mut current_widx_number: u32 = 0;
    {
        let mut max: u32 = 0;
        let mut found_any = false;
        if let Ok(mut rd) = tokio::fs::read_dir(&dir_path).await {
            while let Ok(Some(entry)) = rd.next_entry().await {
                if let Some(name) = entry.file_name().to_str() {
                    if let Some(num) = name
                        .strip_suffix(".widx")
                        .and_then(|s| s.parse::<u32>().ok())
                    {
                        found_any = true;
                        if num > max {
                            max = num;
                        }
                    }
                }
            }
        }
        if found_any {
            current_widx_number = max + 1;
        }
    }
    #[allow(unused_variables, unused_assignments)]
    let mut _sealed_count: u64 = 0;
    #[allow(unused_variables, unused_assignments)]
    let mut _highest_commit_seq: u64 = 0;

    loop {
        let deadline = flush_deadline;
        let sleep = deadline.map(|d| tokio::time::sleep_until(d));

        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    Some(BatcherMessage::Entry(entry)) => {
                        buffer.push(entry);
                        if buffer.len() >= batch_size {
                            let (seq, sealed) = flush_batch(
                                &dir_path,
                                &mut buffer,
                                &mut file,
                                &mut current_widx_number,
                            ).await?;
                            _highest_commit_seq = seq;
                            if sealed {
                                _sealed_count += 1;
                            }
                            flush_deadline = None;
                        } else if flush_deadline.is_none() {
                            flush_deadline = Some(Instant::now() + max_age);
                        }
                    }
                    Some(BatcherMessage::Flush(response)) => {
                        let result = flush_batch(
                            &dir_path,
                            &mut buffer,
                            &mut file,
                            &mut current_widx_number,
                        ).await;
                        match result {
                            Ok((seq, sealed)) => {
                                _highest_commit_seq = seq;
                                if sealed { _sealed_count += 1; }
                                let _ = response.send(Ok(()));
                            }
                            Err(e) => {
                                let _ = response.send(Err(e));
                            }
                        }
                        flush_deadline = None;
                    }
                    None => {
                        // Channel closed — flush remaining and exit.
                        let (seq, sealed) = flush_batch(
                            &dir_path,
                            &mut buffer,
                            &mut file,
                            &mut current_widx_number,
                        ).await?;
                        _highest_commit_seq = seq;
                        if sealed {
                            _sealed_count += 1;
                        }

                        if let Some(fs) = file.take() {
                            seal_file(fs, &dir_path).await?;
                            _sealed_count += 1;
                        }
                        return Ok(());
                    }
                }
            }
            _ = async {
                if let Some(sleep) = sleep {
                    sleep.await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {
                let (seq, sealed) = flush_batch(
                    &dir_path,
                    &mut buffer,
                    &mut file,
                    &mut current_widx_number,
                ).await?;
                _highest_commit_seq = seq;
                if sealed { _sealed_count += 1; }
                flush_deadline = None;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// File state
// ---------------------------------------------------------------------------

struct FileState {
    handle: tokio::fs::File,
    entry_count: u32,
    highest_commit_seq: u64,
}

/// Open a fresh `.widx` file at the given number.
///
/// Uses `create_new` so it will fail if the file already exists (the caller
/// must guarantee a fresh sequence number — see `wabidb-08` recovery).
async fn open_widx(dir_path: &PathBuf, widx_number: u32) -> Result<tokio::fs::File> {
    let path = dir_path.join(format!("{:08}.widx", widx_number));
    let f = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .read(true)
        .open(&path)
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                WabiError::InternalInvariantViolated {
                    invariant: format!(
                        "commit index file already exists: {}, \
                         ensure a fresh sequence number is used",
                        path.display()
                    ),
                }
            } else {
                WabiError::Io(e)
            }
        })?;

    // Write 16-byte file header (entry_count placeholder is 0; rewritten on seal).
    let header = make_file_header(false);
    let mut f = f;
    f.write_all(&header).await?;
    f.flush().await?;
    Ok(f)
}

/// Write the 16-byte trailer on a file that will no longer be appended to,
/// then fsync the directory.
async fn seal_file(fs: FileState, dir_path: &PathBuf) -> Result<()> {
    let mut f = fs.handle;
    let entry_count = fs.entry_count;
    let highest_seq = fs.highest_commit_seq;

    // Rewrite header with flags=sealed and the real entry count.
    f.seek(SeekFrom::Start(0)).await?;
    let header = make_file_header_sealed(entry_count);
    f.write_all(&header).await?;

    // Read everything written so far (header + entries) for the file-level CRC.
    let file_size = f.metadata().await?.len();
    f.seek(SeekFrom::Start(0)).await?;
    let mut all_bytes = vec![0u8; file_size as usize];
    f.read_exact(&mut all_bytes).await?;
    let file_crc = crc32c::crc32c(&all_bytes);

    // Append the 32-byte trailer.
    f.seek(SeekFrom::End(0)).await?;
    let mut trailer = Vec::with_capacity(FILE_TRAILER_LEN);
    trailer.extend_from_slice(&highest_seq.to_le_bytes());
    trailer.extend_from_slice(&file_crc.to_le_bytes());
    trailer.resize(FILE_TRAILER_LEN, 0u8);
    f.write_all(&trailer).await?;

    f.sync_all().await.map_err(|e| WabiError::Corrupt {
        location: "commit index seal".into(),
        detail: format!("fsync failed: {e}"),
    })?;

    drop(f);
    fsync_dir(dir_path).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

/// Flush the buffer to disk.
///
/// Returns `(highest_commit_seq, did_rotate)`.
async fn flush_batch(
    dir_path: &PathBuf,
    buffer: &mut Vec<CommitIndexEntry>,
    file: &mut Option<FileState>,
    current_widx_number: &mut u32,
) -> Result<(u64, bool)> {
    if buffer.is_empty() {
        // Use the stored highest if available, otherwise 0.
        let seq = file.as_ref().map(|f| f.highest_commit_seq).unwrap_or(0);
        return Ok((seq, false));
    }

    let entries = std::mem::take(buffer);

    // Open file on first flush.
    if file.is_none() {
        let f = open_widx(dir_path, *current_widx_number).await?;
        *file = Some(FileState {
            handle: f,
            entry_count: 0,
            highest_commit_seq: 0,
        });
    }

    let fs = file.as_mut().unwrap();

    // Append each entry (already contains length-prefix + CRC).
    for entry in &entries {
        let encoded = entry.encode();
        fs.handle.write_all(&encoded).await?;
    }

    let last_seq = entries.last().map(|e| e.commit_seq).unwrap_or(0);
    let n = entries.len() as u32;
    fs.entry_count += n;
    fs.highest_commit_seq = last_seq;

    let should_rotate = fs.entry_count >= ENTRIES_PER_FILE;

    // fsync.
    fs.handle
        .sync_all()
        .await
        .map_err(|e| WabiError::Corrupt {
            location: "commit index batcher".into(),
            detail: format!("fsync failed: {e}"),
        })?;

    if should_rotate {
        let old = file.take().unwrap();
        seal_file(old, dir_path).await?;
        *current_widx_number += 1;
        Ok((last_seq, true))
    } else {
        Ok((last_seq, false))
    }
}

// ---------------------------------------------------------------------------
// Header / trailer helpers
// ---------------------------------------------------------------------------

fn make_file_header(sealed: bool) -> Vec<u8> {
    let flags: u16 = if sealed { 0x0001 } else { 0x0000 };
    let mut buf = Vec::with_capacity(FILE_HEADER_LEN);
    buf.extend_from_slice(&COMMIT_INDEX_MAGIC);
    buf.extend_from_slice(&COMMIT_INDEX_FORMAT_VERSION.to_le_bytes());
    buf.extend_from_slice(&flags.to_le_bytes());
    buf.extend_from_slice(&0u32.to_le_bytes()); // entry_count placeholder
    let crc = crc32c::crc32c(&buf);
    buf.extend_from_slice(&crc.to_le_bytes());
    debug_assert_eq!(buf.len(), FILE_HEADER_LEN);
    buf
}

fn make_file_header_sealed(entry_count: u32) -> Vec<u8> {
    let mut buf = Vec::with_capacity(FILE_HEADER_LEN);
    buf.extend_from_slice(&COMMIT_INDEX_MAGIC);
    buf.extend_from_slice(&COMMIT_INDEX_FORMAT_VERSION.to_le_bytes());
    buf.extend_from_slice(&0x0001u16.to_le_bytes()); // sealed
    buf.extend_from_slice(&entry_count.to_le_bytes());
    let crc = crc32c::crc32c(&buf);
    buf.extend_from_slice(&crc.to_le_bytes());
    debug_assert_eq!(buf.len(), FILE_HEADER_LEN);
    buf
}

// ---------------------------------------------------------------------------
// Reading back (used by tests and CLI tools)
// ---------------------------------------------------------------------------

/// Read all commit index entries from a directory of `.widx` files.
///
/// Files are read in sequential order (`00000000.widx`, `00000001.widx`, …)
/// until the next file does not exist.
pub fn read_all_entries(dir: &PathBuf) -> Result<Vec<CommitIndexEntry>> {
    let mut all = Vec::new();
    let mut file_number = 0u32;

    loop {
        let path = dir.join(format!("{:08}.widx", file_number));
        if !path.exists() {
            break;
        }
        let data = std::fs::read(&path).map_err(WabiError::from)?;
        let entries = parse_widx_file(&data)?;
        all.extend(entries);
        file_number += 1;
    }

    Ok(all)
}

/// Parse entries from the raw bytes of a `.widx` file (skipping header + trailer).
fn parse_widx_file(data: &[u8]) -> Result<Vec<CommitIndexEntry>> {
    if data.len() < FILE_HEADER_LEN {
        return Ok(Vec::new());
    }

    let mut offset = FILE_HEADER_LEN;
    let mut entries = Vec::new();

    // Stop when fewer bytes remain than the smallest possible entry:
    //   4 (entry_len) + 65 (minimum body) + 4 (CRC) = 73 bytes.
    // This avoids trying to parse the 32-byte trailer as an entry.
    while offset + 73 <= data.len() {
        let entry_len = u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap()) as usize;
        let entry_total = 4 + entry_len + 4;

        if offset + entry_total > data.len() {
            break; // truncated or trailer space
        }

        let entry_bytes = &data[offset..offset + entry_total];
        let entry = CommitIndexEntry::decode(entry_bytes)?;
        entries.push(entry);
        offset += entry_total;
    }

    Ok(entries)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Build a simple entry for testing.
    fn test_entry(seq: u64) -> CommitIndexEntry {
        let mut device_hash = [0u8; 16];
        device_hash[0] = 0xAB;
        let mut cmd_hash = [0u8; 16];
        cmd_hash[0] = 0xCD;
        CommitIndexEntry {
            commit_seq: seq,
            timestamp_micros: (seq as i64) * 1_000_000,
            caller_user_id: 42,
            caller_device_id_hash: device_hash,
            command_name_hash: cmd_hash,
            has_idempotency_key: false,
            idempotency_key_hash: None,
            event_refs: vec![],
            payload_hashes: vec![],
        }
    }

    // -----------------------------------------------------------------------
    // batch_size triggers flush
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn batch_size_triggers_flush() {
        let dir = tempdir().unwrap();
        let (handle, fut) = new_batcher(
            dir.path().to_path_buf(),
            Some(3),
            Some(Duration::from_secs(60)),
        );
        tokio::spawn(fut);

        for seq in 1..=3 {
            handle.submit(test_entry(seq)).unwrap();
        }

        // The batch size is 3, so the batcher should flush immediately.
        // Give it a moment to process.
        tokio::time::sleep(Duration::from_millis(100)).await;

        let entries = read_all_entries(&dir.path().to_path_buf()).unwrap();
        assert_eq!(entries.len(), 3, "expected 3 entries after batch flush");
        assert_eq!(entries[0].commit_seq, 1);
        assert_eq!(entries[2].commit_seq, 3);
    }

    // -----------------------------------------------------------------------
    // max_age triggers flush
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn max_age_triggers_flush() {
        let dir = tempdir().unwrap();
        let (handle, fut) = new_batcher(
            dir.path().to_path_buf(),
            Some(100),
            Some(Duration::from_millis(10)),
        );
        tokio::spawn(fut);

        handle.submit(test_entry(1)).unwrap();

        // Wait well past the 10 ms max_age.
        tokio::time::sleep(Duration::from_millis(100)).await;

        let entries = read_all_entries(&dir.path().to_path_buf()).unwrap();
        assert_eq!(entries.len(), 1, "expected 1 entry after max_age flush");
        assert_eq!(entries[0].commit_seq, 1);
    }

    // -----------------------------------------------------------------------
    // explicit flush_now works
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn explicit_flush_now_works() {
        let dir = tempdir().unwrap();
        let (handle, fut) = new_batcher(
            dir.path().to_path_buf(),
            Some(100),
            Some(Duration::from_secs(60)),
        );
        tokio::spawn(fut);

        for seq in 1..=5 {
            handle.submit(test_entry(seq)).unwrap();
        }

        // Call flush_now — it should flush the 5 buffered entries synchronously.
        handle.flush_now().await.unwrap();

        let entries = read_all_entries(&dir.path().to_path_buf()).unwrap();
        assert_eq!(entries.len(), 5, "expected 5 entries after flush_now");
    }

    // -----------------------------------------------------------------------
    // file rotation at 10,000 entries
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn file_rotation_at_10000_entries() {
        let dir = tempdir().unwrap();
        let (handle, fut) = new_batcher(
            dir.path().to_path_buf(),
            Some(5000),
            Some(Duration::from_secs(60)),
        );
        tokio::spawn(fut);

        for seq in 1..=10_001u64 {
            handle.submit(test_entry(seq)).unwrap();
        }

        // Flush everything synchronously.
        handle.flush_now().await.unwrap();

        // Two files should exist.
        let f0 = dir.path().join("00000000.widx");
        let f1 = dir.path().join("00000001.widx");
        assert!(f0.exists(), "first widx file should exist");
        assert!(f1.exists(), "second widx file (rotated) should exist");

        // A third file should NOT exist.
        let f2 = dir.path().join("00000002.widx");
        assert!(!f2.exists(), "third widx file should not exist");

        // Verify all 10,001 entries are readable in order.
        let all = read_all_entries(&dir.path().to_path_buf()).unwrap();
        assert_eq!(all.len(), 10_001);
        assert_eq!(all[0].commit_seq, 1);
        assert_eq!(all[10_000].commit_seq, 10_001);
    }

    // -----------------------------------------------------------------------
    // graceful shutdown flushes remaining
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn graceful_shutdown_flushes_remaining() {
        let dir = tempdir().unwrap();
        let (handle, fut) = new_batcher(
            dir.path().to_path_buf(),
            Some(100),
            Some(Duration::from_secs(60)),
        );
        let join = tokio::spawn(fut);

        for seq in 1..=7u64 {
            handle.submit(test_entry(seq)).unwrap();
        }

        // Drop the handle — this closes the channel and triggers graceful shutdown.
        drop(handle);

        // The batcher future should complete after flushing remaining entries.
        join.await.unwrap().unwrap();

        let entries = read_all_entries(&dir.path().to_path_buf()).unwrap();
        assert_eq!(entries.len(), 7, "expected 7 entries after graceful shutdown");
    }

    // -----------------------------------------------------------------------
    // entries in order
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn entries_in_order() {
        let dir = tempdir().unwrap();
        let (handle, fut) = new_batcher(
            dir.path().to_path_buf(),
            Some(4),
            Some(Duration::from_secs(60)),
        );
        tokio::spawn(fut);

        for seq in 1..=20u64 {
            handle.submit(test_entry(seq)).unwrap();
        }

        handle.flush_now().await.unwrap();

        let entries = read_all_entries(&dir.path().to_path_buf()).unwrap();
        assert_eq!(entries.len(), 20);
        for (i, e) in entries.iter().enumerate() {
            assert_eq!(e.commit_seq, (i + 1) as u64);
        }
    }

    // -----------------------------------------------------------------------
    // encode / decode round-trip for the test entry itself
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn batcher_handles_render_roundtrip() {
        let entry = CommitIndexEntry {
            commit_seq: 12345,
            timestamp_micros: 1_700_000_000_000_000,
            caller_user_id: 999,
            caller_device_id_hash: {
                let mut h = [0u8; 16];
                h[0] = 0xAA;
                h
            },
            command_name_hash: {
                let mut h = [0u8; 16];
                h[0] = 0xBB;
                h
            },
            has_idempotency_key: false,
            idempotency_key_hash: None,
            event_refs: vec![],
            payload_hashes: vec![],
        };

        let dir = tempdir().unwrap();
        let (handle, fut) = new_batcher(
            dir.path().to_path_buf(),
            Some(1),
            Some(Duration::from_secs(60)),
        );
        let _join = tokio::spawn(fut);

        handle.submit(entry.clone()).unwrap();
        handle.flush_now().await.unwrap();

        let loaded = read_all_entries(&dir.path().to_path_buf()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0], entry);
    }
}
