#[cfg(test)]
mod compaction_regression {
    use tempfile::tempdir;
    use wabidb::format::record::{payload_crc32c, RecordHeader, RecordKind};
    use wabidb::retention::compaction::compact_segment;
    use wabidb::retention::tombstone::TombstoneTable;
    use wabidb::stream_log::segment_reader::SegmentReader;
    use wabidb::stream_log::segment_writer::SegmentWriter;

    async fn write_test_segment(events_dir: &std::path::Path, count: u64) -> std::path::PathBuf {
        let mut w = SegmentWriter::open(events_dir, "ch_test".to_string())
            .await
            .unwrap();
        for i in 0..count {
            let payload = format!("payload-{}", i + 1).into_bytes();
            let crc = payload_crc32c(&payload);
            let hdr = RecordHeader::new(
                RecordKind::Event,
                i + 1,
                [0xABu8; 16],
                payload.len() as u32,
                crc,
            );
            w.append(&hdr, &payload).await.unwrap();
        }
        w.close().await.unwrap();
        events_dir.join("00000001.wseg")
    }

    #[tokio::test]
    async fn compact_preserves_retained_records_and_is_idempotent() {
        // Regression test for the padding defect: compact_segment() must
        // write records with the same 16-byte alignment padding that
        // SegmentReader expects. Without it, re-reading the compacted
        // segment fails, and re-compaction would treat the unreadable
        // segment as empty and delete it.
        let dir = tempdir().unwrap();
        let events_dir = dir.path().join("streams").join("ch_test").join("events");
        tokio::fs::create_dir_all(&events_dir).await.unwrap();
        let path = write_test_segment(&events_dir, 5).await;

        let mut table = TombstoneTable::new();
        table.insert("ch_test".to_string(), 2, "retention".into());
        table.insert("ch_test".to_string(), 4, "retention".into());

        let result = compact_segment(&path, "ch_test", &table).await.unwrap();
        assert_eq!(result.records_kept, 3);
        assert_eq!(result.records_dropped, 2);

        // Read the compacted segment back through SegmentReader and
        // verify the exact surviving records and their payloads.
        let mut reader = SegmentReader::open(&path).await.unwrap();
        let records = reader.read_records().await.unwrap();
        assert_eq!(records.len(), 3, "expected 3 readable records after compaction");

        let surviving_seqs: Vec<u64> = records.iter().map(|r| r.header.commit_seq).collect();
        assert_eq!(surviving_seqs, vec![1, 3, 5]);

        for (i, rec) in records.iter().enumerate() {
            let expected_seq = [1u64, 3, 5][i];
            let expected_payload = format!("payload-{}", expected_seq);
            assert_eq!(rec.header.commit_seq, expected_seq);
            assert_eq!(rec.payload, expected_payload.as_bytes());
        }

        // Second compaction: must be idempotent. The compacted file
        // must remain readable and contain the same records.
        let result2 = compact_segment(&path, "ch_test", &table).await.unwrap();
        assert_eq!(result2.records_kept, 3);
        assert_eq!(result2.records_dropped, 0);

        let mut reader2 = SegmentReader::open(&path).await.unwrap();
        let records2 = reader2.read_records().await.unwrap();
        assert_eq!(records2.len(), 3, "second compaction must preserve the same records");

        let surviving_seqs2: Vec<u64> = records2.iter().map(|r| r.header.commit_seq).collect();
        assert_eq!(surviving_seqs2, vec![1, 3, 5]);
    }
}
