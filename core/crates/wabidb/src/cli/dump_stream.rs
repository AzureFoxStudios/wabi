use std::path::Path;

use crate::error::{Result, WabiError};
use crate::stream_log::segment_reader::SegmentReader;

#[derive(Debug, Clone)]
pub struct DumpedRecord {
    pub commit_seq: u64,
    pub stream_id_hash: String,
    pub payload_len: u32,
    pub payload_crc32c: String,
    pub payload_hex: String,
}

pub async fn dump_stream(
    data_dir: &Path,
    stream_id: &str,
    from_seq: Option<u64>,
    to_seq: Option<u64>,
) -> Result<Vec<DumpedRecord>> {
    let events_dir = data_dir
        .join("streams")
        .join(stream_id)
        .join("events");

    let mut dir_entries = tokio::fs::read_dir(&events_dir).await.map_err(|e| {
        WabiError::NotFound {
            what: format!("stream directory: {e}"),
        }
    })?;

    let mut segment_paths = Vec::new();
    while let Some(entry) = dir_entries
        .next_entry()
        .await
        .map_err(WabiError::Io)?
    {
        let path = entry.path();
        if path.extension().map_or(false, |ext| ext == "wseg") {
            segment_paths.push(path);
        }
    }
    segment_paths.sort();

    let mut records = Vec::new();

    for seg_path in &segment_paths {
        let mut reader = match SegmentReader::open(seg_path).await {
            Ok(r) => r,
            Err(_) => continue,
        };

        let valid_records = reader.read_records().await.unwrap_or_default();

        for vr in &valid_records {
            if let Some(from) = from_seq {
                if vr.header.commit_seq < from {
                    continue;
                }
            }
            if let Some(to) = to_seq {
                if vr.header.commit_seq > to {
                    continue;
                }
            }

            records.push(DumpedRecord {
                commit_seq: vr.header.commit_seq,
                stream_id_hash: hex::encode(vr.header.stream_id_hash),
                payload_len: vr.header.payload_len,
                payload_crc32c: format!("{:#010x}", vr.header.payload_crc32c),
                payload_hex: hex::encode(&vr.payload),
            });
        }
    }

    Ok(records)
}

pub fn format_dump(records: &[DumpedRecord]) -> String {
    let mut out = String::new();
    for r in records {
        out.push_str(&format!(
            r#"{{"commit_seq":{},"stream_id_hash":"{}","payload_len":{},"payload_crc32c":"{}","payload_hex":"{}"}}"#,
            r.commit_seq, r.stream_id_hash, r.payload_len, r.payload_crc32c, r.payload_hex
        ));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::record::{payload_crc32c, RecordHeader, RecordKind};
    use crate::stream_log::segment_writer::SegmentWriter;
    use tempfile::tempdir;

    #[tokio::test]
    async fn dump_five_records_produces_five_lines() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        let stream_id = "ch_test";

        let events_dir = data_dir.join("streams").join(stream_id).join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();

        let mut writer = SegmentWriter::open(&events_dir, stream_id.to_string())
            .await
            .unwrap();

        let payload = b"data";
        let crc = payload_crc32c(payload);
        for i in 0u64..5 {
            let h = RecordHeader::new(RecordKind::Event, i, [0u8; 16], payload.len() as u32, crc);
            writer.append(&h, payload).await.unwrap();
        }
        writer.close().await.unwrap();

        let records = dump_stream(&data_dir, stream_id, None, None)
            .await
            .unwrap();
        assert_eq!(records.len(), 5);

        let output = format_dump(&records);
        let lines: Vec<&str> = output.trim().lines().collect();
        assert_eq!(lines.len(), 5);
    }
}
