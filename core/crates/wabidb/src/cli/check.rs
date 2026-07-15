use std::path::Path;

use crate::error::{Result, WabiError};
use crate::stream_log::segment_reader::SegmentReader;

#[derive(Debug, Clone)]
pub struct CheckStats {
    pub total_streams: usize,
    pub total_segments: usize,
    pub total_records: usize,
    pub corrupt_records: usize,
}

#[derive(Debug, Clone)]
pub struct CheckReport {
    pub ok: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub stats: CheckStats,
}

pub async fn check(data_dir: &Path) -> Result<CheckReport> {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut total_streams = 0u64;
    let mut total_segments = 0u64;
    let mut total_records = 0u64;
    let mut corrupt_records = 0u64;

    let manifest_path = data_dir.join("storage-manifest.json");
    if !tokio::fs::try_exists(&manifest_path).await.unwrap_or(false) {
        return Ok(CheckReport {
            ok: false,
            errors: vec!["missing storage-manifest.json".into()],
            warnings: Vec::new(),
            stats: CheckStats {
                total_streams: 0,
                total_segments: 0,
                total_records: 0,
                corrupt_records: 0,
            },
        });
    }

    let streams_dir = data_dir.join("streams");
    let mut streams_reader = match tokio::fs::read_dir(&streams_dir).await {
        Ok(r) => r,
        Err(e) => {
            return Ok(CheckReport {
                ok: false,
                errors: vec![format!("cannot read streams dir: {e}")],
                warnings: Vec::new(),
                stats: CheckStats {
                    total_streams: 0,
                    total_segments: 0,
                    total_records: 0,
                    corrupt_records: 0,
                },
            });
        }
    };

    while let Some(entry) = streams_reader
        .next_entry()
        .await
        .map_err(WabiError::Io)?
    {
        let stream_path = entry.path();
        if !stream_path.is_dir() {
            continue;
        }

        total_streams += 1;
        let events_dir = stream_path.join("events");

        let mut events_reader = match tokio::fs::read_dir(&events_dir).await {
            Ok(r) => r,
            Err(_) => {
                warnings.push(format!(
                    "stream {} has no events directory",
                    stream_path.file_name().unwrap().to_string_lossy()
                ));
                continue;
            }
        };

        let mut stream_has_segment = false;
        while let Some(seg_entry) = events_reader.next_entry().await.map_err(WabiError::Io)? {
            let seg_path = seg_entry.path();
            if seg_path.extension().map_or(false, |ext| ext == "wseg") {
                stream_has_segment = true;
                total_segments += 1;

                let mut reader = match SegmentReader::open(&seg_path).await {
                    Ok(r) => r,
                    Err(_) => {
                        errors.push(format!("cannot open segment: {}", seg_path.display()));
                        continue;
                    }
                };

                match reader.read_records().await {
                    Ok(recs) => {
                        total_records += recs.len() as u64;
                    }
                    Err(_) => {
                        corrupt_records += 1;
                        errors.push(format!(
                            "corrupt segment: {}",
                            seg_path.display()
                        ));
                    }
                }
            }
        }

        if !stream_has_segment {
            warnings.push(format!(
                "stream {} has no segments",
                stream_path.file_name().unwrap().to_string_lossy()
            ));
        }
    }

    let ok = errors.is_empty();

    Ok(CheckReport {
        ok,
        errors,
        warnings,
        stats: CheckStats {
            total_streams: total_streams as usize,
            total_segments: total_segments as usize,
            total_records: total_records as usize,
            corrupt_records: corrupt_records as usize,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::{payload_crc32c, RecordHeader, RecordKind};
    use crate::stream_log::segment_writer::SegmentWriter;
    use tempfile::tempdir;

    #[tokio::test]
    async fn missing_manifest_returns_error() {
        let dir = tempdir().unwrap();
        let report = check(dir.path()).await.unwrap();
        assert!(!report.ok);
        assert!(report
            .errors
            .iter()
            .any(|e| e.contains("storage-manifest.json")));
    }

    #[tokio::test]
    async fn clean_data_dir_returns_ok() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path();

        tokio::fs::write(data_dir.join("storage-manifest.json"), b"{}")
            .await
            .unwrap();

        let stream_dir = data_dir.join("streams").join("ch_test").join("events");
        tokio::fs::create_dir_all(&stream_dir).await.unwrap();

        let payload = b"data";
        let crc = payload_crc32c(payload);
        let mut writer = SegmentWriter::open(&stream_dir, "ch_test".into())
            .await
            .unwrap();
        let h = RecordHeader::new(RecordKind::Event, 1, [0u8; 16], payload.len() as u32, crc);
        writer.append(&h, payload).await.unwrap();
        writer.close().await.unwrap();

        let report = check(data_dir).await.unwrap();
        assert!(report.ok, "expected ok, got errors: {:?}", report.errors);
        assert!(report.errors.is_empty());
        assert_eq!(report.stats.total_streams, 1);
        assert_eq!(report.stats.total_segments, 1);
        assert_eq!(report.stats.total_records, 1);
    }
}
