//! Stream segment writer.
//!
//! See `docs/architecture/STORAGE_FORMAT.md` §2 for the full byte layout.
//!
//! A [`SegmentWriter`] writes records to a single `.wseg` file. When the segment
//! reaches [`MAX_SEGMENT_SIZE`] bytes, the caller should open a new segment via
//! [`SegmentWriter::open`] and switch writers.
//!
//! This writer does NOT fsync on every append — that is the responsibility of
//! the commit-index batcher (wabidb-14) and the commit sequencer (wabidb-15).
//! Call [`flush`](Self::flush) to persist buffered data to disk.

use crate::error::Result;
use crate::format::record::{padding_for, RecordHeader, HEADER_LEN};
use crate::storage::fsync::fsync_dir;
use std::path::{Path, PathBuf};
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

/// Default maximum segment size before rotation (64 MiB).
const MAX_SEGMENT_SIZE: u64 = 64 * 1024 * 1024;

/// An append-only writer for a single stream segment file (`.wseg`).
///
/// ## Lifecycle
///
/// 1. [`SegmentWriter::open`] creates a new segment file and returns a writer.
/// 2. [`append`](Self::append) writes records. Returns the byte offset of each
///    record for use in the commit index's [`StreamRef`].
/// 3. When [`is_full`](Self::is_full) returns `true`, the caller must open a new
///    segment and switch to the new writer. The old segment is considered sealed.
/// 4. [`flush`](Self::flush) calls `sync_all` on the underlying file.
/// 5. [`close`](Self::close) flushes and consumes the writer.
pub struct SegmentWriter {
    file: File,
    path: PathBuf,
    cursor: u64,
    _stream_id: String,
}

impl SegmentWriter {
    /// Open (or create) a new segment file at `dir/SEQUENCE_NUMBER.wseg`.
    ///
    /// Scans `dir` for existing `*.wseg` files, determines the next segment
    /// number (max existing + 1, or 1 if none exist), creates the file, and
    /// fsyncs the parent directory so the new directory entry is durable.
    ///
    /// `stream_id` is stored for diagnostic purposes (e.g. logging) and is
    /// otherwise unused by the writer.
    ///
    /// ## Errors
    ///
    /// Returns [`WabiError::Io`] if the directory cannot be created or read,
    /// if the file cannot be created, or if the directory fsync fails.
    pub async fn open<P: AsRef<Path>>(dir: P, stream_id: String) -> Result<Self> {
        let dir = dir.as_ref();
        tokio::fs::create_dir_all(dir).await?;

        let next_id = next_segment_id(dir).await?;
        let filename = format!("{next_id:08}.wseg");
        let path = dir.join(&filename);

        let file = File::create(&path).await?;

        // Fsync the parent directory so the new file entry survives a power loss
        // that occurs between the file creation and the first record write.
        fsync_dir(dir).await?;

        Ok(Self {
            file,
            path,
            cursor: 0,
            _stream_id: stream_id,
        })
    }

    /// Append a record to the segment.
    ///
    /// Writes the 48-byte header (via [`RecordHeader::encode`]), the payload
    /// bytes, and zero-padding to the next 16-byte boundary.
    ///
    /// Returns the absolute byte offset of the record header within the segment
    /// file. This offset is used by the commit index to build a [`StreamRef`].
    ///
    /// This method does NOT fsync. The commit-index batcher or sequencer calls
    /// [`flush`](Self::flush) at the appropriate cadence.
    ///
    /// ## Errors
    ///
    /// Returns [`WabiError::Io`] if the write fails.
    pub async fn append(&mut self, header: &RecordHeader, payload: &[u8]) -> Result<u64> {
        let offset = self.cursor;

        let header_bytes = header.encode();
        let body_len = HEADER_LEN as usize + payload.len();
        let pad_len = padding_for(body_len);

        self.file.write_all(&header_bytes).await?;
        self.file.write_all(payload).await?;
        if pad_len > 0 {
            // Zero-pad to the next 16-byte boundary (required by STORAGE_FORMAT.md §2.3).
            let pad = vec![0u8; pad_len];
            self.file.write_all(&pad).await?;
        }

        let record_size = body_len + pad_len;
        self.cursor += record_size as u64;

        Ok(offset)
    }

    /// Flush (fsync) all buffered data to durable storage.
    ///
    /// Calls `sync_all()` on the underlying file handle. Use this after a batch
    /// of appends to guarantee durability before acknowledging a commit.
    pub async fn flush(&mut self) -> Result<()> {
        self.file.sync_all().await?;
        Ok(())
    }

    /// Close the writer, consuming it.
    ///
    /// Flushes remaining data to disk, then drops the file handle. The segment
    /// file is left in place for future reads.
    pub async fn close(mut self) -> Result<()> {
        self.flush().await?;
        Ok(())
    }

    /// Whether the segment has grown to at least [`MAX_SEGMENT_SIZE`] bytes
    /// (64 MiB) and should be rotated.
    ///
    /// The caller should check this after each [`append`](Self::append) and open
    /// a new segment (via [`SegmentWriter::open`]) when it returns `true`.
    pub fn is_full(&self) -> bool {
        self.cursor >= MAX_SEGMENT_SIZE
    }

    /// The absolute path to the current segment file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The current write cursor (number of bytes written so far).
    pub fn cursor(&self) -> u64 {
        self.cursor
    }
}

/// Scan the events directory for existing `.wseg` files and return the next
/// segment sequence number (max existing + 1).
///
/// For example, if `00000001.wseg` and `00000003.wseg` exist, returns `4`.
/// If no segments exist, returns `1`.
async fn next_segment_id(dir: &Path) -> Result<u64> {
    let mut max_id = 0u64;

    let mut read_dir = tokio::fs::read_dir(dir).await?;
    while let Some(entry) = read_dir.next_entry().await? {
        let name = entry.file_name();
        let name = name.to_string_lossy().to_string();
        if let Some(stripped) = name.strip_suffix(".wseg") {
            if let Ok(id) = stripped.parse::<u64>() {
                if id > max_id {
                    max_id = id;
                }
            }
        }
    }

    Ok(max_id + 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::{RecordKind, MAX_PAYLOAD_LEN};
    use tempfile::tempdir;

    fn sample_header(commit_seq: u64, payload: &[u8]) -> RecordHeader {
        let mut stream_hash = [0u8; 16];
        stream_hash[0] = 0xAB;
        RecordHeader::new(RecordKind::Event, commit_seq, stream_hash, payload.len() as u32, 0)
    }

    #[tokio::test]
    async fn write_and_read_single_record() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
            .await
            .unwrap();

        let payload = b"hello, world";
        let header = sample_header(1, payload);
        let offset = writer.append(&header, payload).await.unwrap();

        assert_eq!(offset, 0, "first record starts at offset 0");
        assert_eq!(writer.cursor(), header.total_size() as u64);

        // Close and verify the file exists and has the expected size.
        writer.close().await.unwrap();

        let metadata = tokio::fs::metadata(&events_dir.join("00000001.wseg"))
            .await
            .unwrap();
        assert_eq!(metadata.len(), header.total_size() as u64);
    }

    #[tokio::test]
    async fn write_multiple_records() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
            .await
            .unwrap();

        let mut offsets = Vec::new();
        for i in 0..10u64 {
            let payload = format!("record {i}");
            let header = sample_header(i + 1, payload.as_bytes());
            let offset = writer.append(&header, payload.as_bytes()).await.unwrap();
            offsets.push(offset);
        }

        let total_written = writer.cursor();
        writer.close().await.unwrap();

        // Verify offsets are strictly increasing and non-overlapping.
        for i in 1..offsets.len() {
            assert!(
                offsets[i] > offsets[i - 1],
                "offset {} should be > {}",
                offsets[i],
                offsets[i - 1]
            );
        }

        // Verify the file size equals the sum of all record sizes.
        let total_size = tokio::fs::metadata(&events_dir.join("00000001.wseg"))
            .await
            .unwrap()
            .len();
        assert_eq!(total_size, total_written);
    }

    #[tokio::test]
    async fn segment_rotation_on_full() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");

        // Write until the segment is full, then open a new one.
        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
            .await
            .unwrap();

        let mut seg1_count = 0u64;
        while !writer.is_full() {
            let payload = vec![0xABu8; 4096];
            let header = sample_header(seg1_count + 1, &payload);
            writer.append(&header, &payload).await.unwrap();
            seg1_count += 1;
        }

        writer.close().await.unwrap();

        // Segment 1 should be close to 64 MiB.
        let seg1_path = events_dir.join("00000001.wseg");
        let seg1_size = tokio::fs::metadata(&seg1_path).await.unwrap().len();
        assert!(seg1_size >= MAX_SEGMENT_SIZE - 4096 * 2);

        // Open segment 2.
        let mut writer2 = SegmentWriter::open(&events_dir, "ch_test".into())
            .await
            .unwrap();
        assert_eq!(writer2.cursor(), 0);

        let payload = b"first record in segment 2";
        let header = sample_header(seg1_count + 1, payload);
        let offset = writer2.append(&header, payload).await.unwrap();
        assert_eq!(offset, 0);

        writer2.close().await.unwrap();

        // Both files should exist.
        let seg2_path = events_dir.join("00000002.wseg");
        assert!(seg1_path.exists());
        assert!(seg2_path.exists());
        assert_eq!(
            tokio::fs::metadata(&seg2_path).await.unwrap().len(),
            header.total_size() as u64
        );
    }

    #[tokio::test]
    async fn padding_correctness() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
            .await
            .unwrap();

        // Test various payload sizes to verify alignment.
        let sizes = [0usize, 1, 15, 16, 17, 48, 100, 4096, 65535];

        for (i, &size) in sizes.iter().enumerate() {
            let payload = vec![0x42u8; size];
            let header = sample_header(i as u64 + 1, &payload);
            let offset = writer.append(&header, &payload).await.unwrap();

            // The record should start at the expected aligned offset.
            // For the first record offset is known; for others just verify alignment
            if i == 0 {
                assert_eq!(offset, 0);
            }
            assert_eq!(
                offset % 16,
                0,
                "offset {offset} for size {size} must be 16-byte aligned"
            );
        }

        writer.close().await.unwrap();

        // Verify the file size matches the total_size of all records combined.
        let all_correct_sizes: usize = sizes
            .iter()
            .map(|&s| {
                let h = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], s as u32, 0);
                h.total_size()
            })
            .sum();
        let file_len = tokio::fs::metadata(&events_dir.join("00000001.wseg"))
            .await
            .unwrap()
            .len();
        assert_eq!(file_len, all_correct_sizes as u64);
    }

    #[tokio::test]
    async fn next_segment_id_increments() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();

        // No segments yet -> id 1
        assert_eq!(next_segment_id(&events_dir).await.unwrap(), 1);

        // Touch 00000003.wseg -> next is 4
        tokio::fs::write(events_dir.join("00000003.wseg"), b"").await.unwrap();
        assert_eq!(next_segment_id(&events_dir).await.unwrap(), 4);

        // Touch 00000001.wseg -> next is still 4 (max is 3)
        tokio::fs::write(events_dir.join("00000001.wseg"), b"").await.unwrap();
        assert_eq!(next_segment_id(&events_dir).await.unwrap(), 4);

        // Touch 00000010.wseg -> next is 11
        tokio::fs::write(events_dir.join("00000010.wseg"), b"").await.unwrap();
        assert_eq!(next_segment_id(&events_dir).await.unwrap(), 11);
    }

    #[tokio::test]
    async fn non_wseg_files_ignored() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();

        tokio::fs::write(events_dir.join("notes.txt"), b"").await.unwrap();
        tokio::fs::write(events_dir.join("00000005.wseg"), b"").await.unwrap();
        tokio::fs::write(events_dir.join(".DS_Store"), b"").await.unwrap();

        assert_eq!(next_segment_id(&events_dir).await.unwrap(), 6);
    }

    #[tokio::test]
    async fn flush_and_close_persist_data() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
            .await
            .unwrap();

        let payload = b"flush test";
        let header = sample_header(1, payload);
        writer.append(&header, payload).await.unwrap();

        // Before flush, data may be in the kernel buffer.
        // After flush, it must be on disk.
        writer.flush().await.unwrap();

        let file_len = tokio::fs::metadata(&events_dir.join("00000001.wseg"))
            .await
            .unwrap()
            .len();
        assert_eq!(file_len, header.total_size() as u64);

        writer.close().await.unwrap();

        // Double close is safe since close consumes self.
        // Verify the file is still there with the same size.
        let file_len2 = tokio::fs::metadata(&events_dir.join("00000001.wseg"))
            .await
            .unwrap()
            .len();
        assert_eq!(file_len2, header.total_size() as u64);
    }

    #[tokio::test]
    async fn zero_length_payload() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
            .await
            .unwrap();

        let payload = b"";
        let header = sample_header(1, payload);
        let offset = writer.append(&header, payload).await.unwrap();
        assert_eq!(offset, 0);

        writer.close().await.unwrap();

        // Header is 48 bytes, which is already 16-byte aligned. With 0 payload
        // and 0 padding, total should be 48.
        let file_len = tokio::fs::metadata(&events_dir.join("00000001.wseg"))
            .await
            .unwrap()
            .len();
        assert_eq!(file_len, 48);
    }

    #[tokio::test]
    async fn max_payload_size() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
            .await
            .unwrap();

        let payload = vec![0x00u8; MAX_PAYLOAD_LEN as usize];
        let header = sample_header(1, &payload);
        let offset = writer.append(&header, &payload).await.unwrap();
        assert_eq!(offset, 0);

        writer.close().await.unwrap();

        // total_size should be: 48 + MAX_PAYLOAD_LEN + padding to 16 bytes.
        // 48 + 16 MiB = 16,777,280. Padding = 0 since 48 + 16 MiB is 16-byte aligned.
        let expected_size = header.total_size() as u64;
        let file_len = tokio::fs::metadata(&events_dir.join("00000001.wseg"))
            .await
            .unwrap()
            .len();
        assert_eq!(file_len, expected_size);
    }

    #[tokio::test]
    async fn non_zero_payload_crc() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
            .await
            .unwrap();

        let payload = b"payload with crc32c";
        let crc = crate::format::record::payload_crc32c(payload);
        let header = RecordHeader::new(
            RecordKind::Event,
            1,
            [0xABu8; 16],
            payload.len() as u32,
            crc,
        );
        let offset = writer.append(&header, payload).await.unwrap();
        assert_eq!(offset, 0);

        writer.close().await.unwrap();

        let file_len = tokio::fs::metadata(&events_dir.join("00000001.wseg"))
            .await
            .unwrap()
            .len();
        assert_eq!(file_len, header.total_size() as u64);
    }
}
