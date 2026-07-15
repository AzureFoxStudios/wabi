//! Stream segment reader.
//!
//! See `core/crates/wabidb/docs/STORAGE_FORMAT.md` §2 for the full byte layout.
//!
//! A [`SegmentReader`] reads records sequentially from a single `.wseg` file.
//! It stops at the first invalid header (truncated tail), skips records with
//! payload CRC failures, and applies an optional filter for orphan rejection.
//!
//! This reader NEVER physically truncates the segment file. Physical truncation
//! is the responsibility of the recovery module (wabidb-08) and the compaction
//! module (wabidb-42).

use crate::error::{Result, WabiError};
use crate::format::record::{RecordHeader, HEADER_LEN};
use std::path::{Path, PathBuf};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, BufReader};

/// A valid record found during segment scanning.
#[derive(Debug)]
pub struct ValidRecord {
    /// The decoded record header.
    pub header: RecordHeader,
    /// The raw payload bytes (before decryption).
    pub payload: Vec<u8>,
    /// Byte offset of the record header within the segment file.
    pub offset: u64,
}

/// A sequential reader for a single stream segment file (`.wseg`).
///
/// ## Lifecycle
///
/// 1. [`SegmentReader::open`] opens a segment file for reading.
/// 2. [`read_records`](Self::read_records) scans all records sequentially.
/// 3. [`read_records_filtered`](Self::read_records_filtered) scans with a
///    caller-supplied orphan-rejection filter.
///
/// ## Orphan handling (Council Review #1 §2.2, Option B)
///
/// Records that are valid (header + payload CRC pass) but are not referenced
/// by the commit index are called **orphans**. This reader does not store or
/// access the commit index; instead, the caller provides a filter callback
/// (via [`read_records_filtered`](Self::read_records_filtered)) that returns
/// `false` for orphaned records. The reader silently skips them.
///
/// If no filter is needed, use [`read_records`](Self::read_records) which
/// returns every valid record.
pub struct SegmentReader {
    reader: BufReader<File>,
    path: PathBuf,
    cursor: u64,
}

impl SegmentReader {
    /// Open a segment file for sequential reading.
    ///
    /// ## Errors
    ///
    /// Returns [`WabiError::Io`] if the file cannot be opened.
    pub async fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let file = File::open(&path).await?;
        let reader = BufReader::new(file);
        Ok(Self {
            reader,
            path,
            cursor: 0,
        })
    }

    /// The path of the opened segment file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The current read cursor (byte offset into the segment).
    pub fn cursor(&self) -> u64 {
        self.cursor
    }

    /// Read all valid records from the segment, returning each one.
    ///
    /// Stops at the first invalid header (truncated tail / partial write)
    /// without returning an error. Corrupted records (payload CRC mismatch)
    /// are silently skipped and reading continues.
    ///
    /// See [`read_records_filtered`](Self::read_records_filtered) for the
    /// version that accepts an orphan-rejection filter.
    pub async fn read_records(&mut self) -> Result<Vec<ValidRecord>> {
        self.read_records_filtered(|_| true).await
    }

    /// Read valid records, applying an orphan-rejection filter.
    ///
    /// The `filter` callback is called for every valid record. Records for
    /// which the callback returns `false` are silently skipped. The caller
    /// uses this to implement Option B orphan skipping (Council Review #1
    /// §2.2): pass a filter that checks the record's `commit_seq` against
    /// the commit index.
    ///
    /// ## Errors
    ///
    /// Returns [`WabiError::Io`] on non-transient I/O errors. Truncated tails
    /// and corrupted records do not produce errors; they are silently handled.
    pub async fn read_records_filtered<F>(&mut self, filter: F) -> Result<Vec<ValidRecord>>
    where
        F: Fn(&RecordHeader) -> bool,
    {
        let mut records = Vec::new();

        loop {
            let offset = self.cursor;

            // --- Read header (48 bytes) ---
            let mut header_buf = [0u8; HEADER_LEN as usize];
            match self.reader.read_exact(&mut header_buf).await {
                Ok(_) => {
                    self.cursor += HEADER_LEN as u64;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    // Truncated tail — no more complete records.
                    break;
                }
                Err(e) => return Err(WabiError::Io(e)),
            }

            // --- Decode header ---
            let header = match RecordHeader::decode(&header_buf) {
                Ok(h) => h,
                Err(_) => {
                    // Invalid header = truncated tail. Stop scanning.
                    break;
                }
            };

            // --- Read payload + padding ---
            let total_size = header.total_size();
            let body_size = total_size - HEADER_LEN as usize;

            let mut body = vec![0u8; body_size];
            match self.reader.read_exact(&mut body).await {
                Ok(_) => {
                    self.cursor += body_size as u64;
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    // Truncated tail — record body is incomplete.
                    break;
                }
                Err(e) => return Err(WabiError::Io(e)),
            }

            // --- Split body into payload and padding ---
            let payload_len = header.payload_len as usize;
            let (payload, padding) = body.split_at(payload_len);

            // --- Check padding (truncation detection) ---
            // Non-zero padding means the segment was truncated mid-write at
            // the padding bytes. The record header + payload are valid, but
            // the segment is not trustworthy past this point. Return what we
            // have so far.
            if padding.iter().any(|&b| b != 0) {
                break;
            }

            // --- Verify payload CRC ---
            if header.verify_payload_crc(payload).is_err() {
                // Corrupted payload — skip this record and continue.
                continue;
            }

            // --- Apply orphan filter ---
            if !filter(&header) {
                // Orphaned record (not in commit index) — skip silently.
                continue;
            }

            // --- Record is valid and accepted ---
            records.push(ValidRecord {
                header,
                payload: payload.to_vec(),
                offset,
            });
        }

        Ok(records)
    }
}

/// Read a single record at a specific byte offset in a segment file.
///
/// Useful for looking up records by `StreamRef` from the commit index. The
/// file is opened, seeked to `offset`, and the record at that position is
/// returned.
///
/// ## Errors
///
/// Returns [`WabiError::Io`] if the file cannot be opened or if the offset
/// is past EOF. Returns [`WabiError::Corrupt`] if the record at the offset
/// has a bad header, bad payload CRC, or non-zero padding bytes.
pub async fn record_at_offset<P: AsRef<Path>>(path: P, offset: u64) -> Result<ValidRecord> {
    let path = path.as_ref();
    let mut file = File::open(path).await?;

    use tokio::io::AsyncSeekExt;
    file.seek(std::io::SeekFrom::Start(offset)).await?;

    // Read and decode header.
    let mut header_buf = [0u8; HEADER_LEN as usize];
    file.read_exact(&mut header_buf).await?;
    let header = RecordHeader::decode(&header_buf)?;

    // Read payload + padding.
    let total_size = header.total_size();
    let body_size = total_size - HEADER_LEN as usize;
    let mut body = vec![0u8; body_size];
    file.read_exact(&mut body).await?;

    let (payload, padding) = body.split_at(header.payload_len as usize);

    // Check padding — non-zero padding indicates corruption.
    if padding.iter().any(|&b| b != 0) {
        return Err(WabiError::Corrupt {
            location: format!("segment {} at offset {}", path.display(), offset),
            detail: "non-zero padding bytes".into(),
        });
    }

    // Verify payload CRC.
    header.verify_payload_crc(payload)?;

    Ok(ValidRecord {
        header,
        payload: payload.to_vec(),
        offset,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::{payload_crc32c, RecordKind};
    use crate::stream_log::segment_writer::SegmentWriter;
    use tempfile::tempdir;

    fn header_with_crc(kind: RecordKind, commit_seq: u64, payload: &[u8]) -> RecordHeader {
        let mut stream_hash = [0u8; 16];
        stream_hash[0] = 0xAB;
        let crc = payload_crc32c(payload);
        RecordHeader::new(kind, commit_seq, stream_hash, payload.len() as u32, crc)
    }

    async fn write_sample_segment(
        events_dir: &Path,
        count: u64,
    ) -> Vec<(u64, Vec<u8>)> {
        let mut writer = SegmentWriter::open(events_dir, "ch_test".into())
            .await
            .unwrap();

        let mut offsets = Vec::new();
        for i in 0..count {
            let payload = format!("record {i}").into_bytes();
            let header = header_with_crc(RecordKind::Event, i + 1, &payload);
            let off = writer.append(&header, &payload).await.unwrap();
            offsets.push((off, payload));
        }
        writer.close().await.unwrap();
        offsets
    }

    #[tokio::test]
    async fn read_clean_segment_returns_all_records() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");

        let written = write_sample_segment(&events_dir, 10).await;

        let mut reader = SegmentReader::open(&events_dir.join("00000001.wseg"))
            .await
            .unwrap();
        let records = reader.read_records().await.unwrap();

        assert_eq!(records.len(), 10);
        for (i, record) in records.iter().enumerate() {
            assert_eq!(record.header.commit_seq, i as u64 + 1);
            assert_eq!(record.payload, format!("record {i}").into_bytes());
            assert_eq!(record.offset, written[i].0);
        }
    }

    #[tokio::test]
    async fn empty_segment_returns_empty_vec() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();

        // Create an empty file — no records written.
        let seg_path = events_dir.join("00000001.wseg");
        tokio::fs::write(&seg_path, b"").await.unwrap();

        let mut reader = SegmentReader::open(&seg_path).await.unwrap();
        let records = reader.read_records().await.unwrap();
        assert!(records.is_empty());
    }

    #[tokio::test]
    async fn truncated_tail_returns_valid_prefix() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");

        let written = write_sample_segment(&events_dir, 5).await;

        // Get the file size after all 5 records.
        let seg_path = events_dir.join("00000001.wseg");
        let full_len = tokio::fs::metadata(&seg_path).await.unwrap().len();

        // Truncate to only include the first 3 records.
        // Record 4 starts at offset written[3].0.
        let truncate_at = written[3].0;
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(&seg_path)
            .unwrap();
        f.set_len(truncate_at).unwrap();
        drop(f);

        let full_len_after = tokio::fs::metadata(&seg_path).await.unwrap().len();
        assert!(full_len_after < full_len);

        let mut reader = SegmentReader::open(&seg_path).await.unwrap();
        let records = reader.read_records().await.unwrap();

        assert_eq!(records.len(), 3);
        for (i, record) in records.iter().enumerate() {
            assert_eq!(record.header.commit_seq, i as u64 + 1);
            assert_eq!(record.offset, written[i].0);
        }
    }

    #[tokio::test]
    async fn corrupted_middle_record_is_skipped() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
            .await
            .unwrap();

        // Write 3 records. Record 2 has a wrong payload CRC.
        let p1 = b"first";
        let h1 = header_with_crc(RecordKind::Event, 1, p1);
        let o1 = writer.append(&h1, p1).await.unwrap();
        let off2 = writer.cursor();

        let p2 = b"corrupted";
        // Deliberately wrong CRC — compute CRC of a different payload.
        let wrong_crc = payload_crc32c(b"wrong payload");
        let h2 = RecordHeader::new(RecordKind::Event, 2, [0xABu8; 16], p2.len() as u32, wrong_crc);
        let o2 = writer.append(&h2, p2).await.unwrap();
        let off3 = writer.cursor();

        let p3 = b"third";
        let h3 = header_with_crc(RecordKind::Event, 3, p3);
        let o3 = writer.append(&h3, p3).await.unwrap();

        writer.close().await.unwrap();

        assert_eq!(o1, 0);
        assert_eq!(o2, off2);
        assert_eq!(o3, off3);

        let seg_path = events_dir.join("00000001.wseg");
        let mut reader = SegmentReader::open(&seg_path).await.unwrap();
        let records = reader.read_records().await.unwrap();

        // Record 2 (corrupted) should be skipped; records 1 and 3 remain.
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].header.commit_seq, 1);
        assert_eq!(records[0].payload, b"first");
        assert_eq!(records[1].header.commit_seq, 3);
        assert_eq!(records[1].payload, b"third");
    }

    #[tokio::test]
    async fn orphan_records_skipped_when_filter_rejects() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");

        write_sample_segment(&events_dir, 10).await;

        let seg_path = events_dir.join("00000001.wseg");
        let mut reader = SegmentReader::open(&seg_path).await.unwrap();

        // Filter that only accepts even commit_seqs.
        let records = reader
            .read_records_filtered(|h| h.commit_seq % 2 == 0)
            .await
            .unwrap();

        assert_eq!(records.len(), 5);
        for record in &records {
            assert_eq!(record.header.commit_seq % 2, 0);
        }
    }

    #[tokio::test]
    async fn record_at_offset_reads_single_record() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");

        let written = write_sample_segment(&events_dir, 10).await;
        let seg_path = events_dir.join("00000001.wseg");

        // Read record at offset 0 (first record).
        let r0 = record_at_offset(&seg_path, 0).await.unwrap();
        assert_eq!(r0.header.commit_seq, 1);
        assert_eq!(r0.payload, written[0].1);

        // Read record at offset of record 5.
        let r5 = record_at_offset(&seg_path, written[5].0).await.unwrap();
        assert_eq!(r5.header.commit_seq, 6);
        assert_eq!(r5.payload, written[5].1);
    }

    #[tokio::test]
    async fn record_at_invalid_offset_returns_error() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");

        write_sample_segment(&events_dir, 5).await;
        let seg_path = events_dir.join("00000001.wseg");

        // Offset 1 is in the middle of the first record's header — decode fails.
        let err = record_at_offset(&seg_path, 1).await.unwrap_err();
        assert!(matches!(err, WabiError::BadMagic { .. }));
    }

    #[tokio::test]
    async fn record_at_offset_past_eof_returns_error() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");

        write_sample_segment(&events_dir, 5).await;
        let seg_path = events_dir.join("00000001.wseg");
        let file_len = tokio::fs::metadata(&seg_path).await.unwrap().len();

        // Offset past EOF.
        let err = record_at_offset(&seg_path, file_len + 100).await.unwrap_err();
        assert!(matches!(err, WabiError::Io(_)));
    }

    #[tokio::test]
    async fn read_after_segment_rotation() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");

        // Write until the first segment is full, then open a second.
        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
            .await
            .unwrap();
        let mut total = 0u64;
        while !writer.is_full() {
            let payload = vec![0xABu8; 4096];
            let header = header_with_crc(RecordKind::Event, total + 1, &payload);
            writer.append(&header, &payload).await.unwrap();
            total += 1;
        }
        writer.close().await.unwrap();

        // Write one record to segment 2.
        let mut writer2 = SegmentWriter::open(&events_dir, "ch_test".into())
            .await
            .unwrap();
        let payload = b"seg2 record";
        let header = header_with_crc(RecordKind::Event, total + 1, payload);
        writer2.append(&header, payload).await.unwrap();
        writer2.close().await.unwrap();

        // Read segment 1 — should be full.
        let mut r1 = SegmentReader::open(&events_dir.join("00000001.wseg"))
            .await
            .unwrap();
        let recs1 = r1.read_records().await.unwrap();
        assert_eq!(recs1.len() as u64, total);

        // Read segment 2 — should have one record.
        let mut r2 = SegmentReader::open(&events_dir.join("00000002.wseg"))
            .await
            .unwrap();
        let recs2 = r2.read_records().await.unwrap();
        assert_eq!(recs2.len(), 1);
        assert_eq!(recs2[0].header.commit_seq, total + 1);
        assert_eq!(recs2[0].payload, b"seg2 record");
    }

    #[tokio::test]
    async fn non_zero_payload_crc_verified_by_reader() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");
        let mut writer = SegmentWriter::open(&events_dir, "ch_test".into())
            .await
            .unwrap();

        let payload = b"correct crc";
        let crc = payload_crc32c(payload);
        let header = RecordHeader::new(RecordKind::Event, 1, [0xABu8; 16], payload.len() as u32, crc);
        writer.append(&header, payload).await.unwrap();
        writer.close().await.unwrap();

        let seg_path = events_dir.join("00000001.wseg");
        let mut reader = SegmentReader::open(&seg_path).await.unwrap();
        let records = reader.read_records().await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].payload, payload);
    }

    #[tokio::test]
    async fn file_already_open_for_writing_can_be_read() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");

        // Write first, close, then read.
        write_sample_segment(&events_dir, 3).await;

        let seg_path = events_dir.join("00000001.wseg");
        let mut reader = SegmentReader::open(&seg_path).await.unwrap();
        let records = reader.read_records().await.unwrap();
        assert_eq!(records.len(), 3);
    }

    #[tokio::test]
    async fn multiple_read_calls_are_independent() {
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("events");

        write_sample_segment(&events_dir, 10).await;
        let seg_path = events_dir.join("00000001.wseg");

        // First read.
        let mut reader = SegmentReader::open(&seg_path).await.unwrap();
        let r1 = reader.read_records().await.unwrap();
        assert_eq!(r1.len(), 10);

        // Second read — re-open to start from the beginning.
        let mut reader2 = SegmentReader::open(&seg_path).await.unwrap();
        let r2 = reader2.read_records().await.unwrap();
        assert_eq!(r2.len(), 10);

        // Contents match.
        for (a, b) in r1.iter().zip(r2.iter()) {
            assert_eq!(a.header.commit_seq, b.header.commit_seq);
            assert_eq!(a.payload, b.payload);
        }
    }
}
