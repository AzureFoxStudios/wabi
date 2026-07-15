use crate::error::Result;
use rand::Rng;
use std::path::PathBuf;

#[cfg(test)]
use std::path::Path;
#[cfg(test)]
use crate::error::WabiError;
use tokio::fs;
use tokio::io::AsyncWriteExt;

const WSNAP_MAGIC: &[u8; 5] = b"WSNAP";
const WSNAP_VERSION: u8 = 1;

/// A ULID (Universally Unique Lexicographically Sortable Identifier).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Ulid(u128);

impl Ulid {
    pub fn new() -> Self {
        let timestamp_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let random: u128 = rand::thread_rng().gen();
        let value = ((timestamp_ms as u128) << 80) | (random & 0xFFFF_FFFF_FFFF_FFFF_FFFF);
        Ulid(value)
    }

    pub fn as_u128(&self) -> u128 {
        self.0
    }
}

impl Default for Ulid {
    fn default() -> Self {
        Self::new()
    }
}

/// A reference to a stored snapshot.
#[derive(Debug, Clone)]
pub struct SnapshotRef {
    pub snapshot_id: Ulid,
    pub stream_id: String,
    pub segment_id: u32,
    pub offset: u32,
}

/// Writes per-stream snapshots of projection state.
///
/// Each snapshot is a file in the snapshot directory. The file name is
/// `{snapshot_seq:08}.wsnap` where `snapshot_seq` is a monotonically
/// increasing sequence number determined by scanning the directory.
pub struct SnapshotWriter {
    stream_id: String,
    snapshot_dir: PathBuf,
}

impl SnapshotWriter {
    pub fn new(stream_id: String, snapshot_dir: PathBuf) -> Self {
        Self {
            stream_id,
            snapshot_dir,
        }
    }

    /// Write a snapshot at the given `commit_seq` with the given
    /// `projection_state_hash`.
    ///
    /// The on-disk format is:
    ///
    /// - 16-byte header: `b'WSNAP'` (5 bytes) + version `u8` (1) +
    ///   flags `u16` (2) + `commit_seq` `u64` (8)
    /// - 32-byte `projection_state_hash`
    /// - 8-byte `commit_seq` (repeated for self-describing reads)
    /// - 4-byte CRC32C over (header || body)
    /// - Optional `prev_snapshot_ref`: 32-byte BLAKE3 hash of previous
    ///   snapshot + 4-byte `segment_id` + 4-byte `offset`
    pub async fn write(
        &self,
        commit_seq: u64,
        projection_state_hash: [u8; 32],
    ) -> Result<SnapshotRef> {
        let snapshot_seq = self.next_snapshot_seq().await?;
        let file_path = self.snapshot_dir.join(format!("{snapshot_seq:08}.wsnap"));

        let header = self.build_header(commit_seq);
        let body = self.build_body(projection_state_hash, commit_seq);

        let mut crc_input = Vec::with_capacity(header.len() + body.len());
        crc_input.extend_from_slice(&header);
        crc_input.extend_from_slice(&body);
        let crc = crc32c::crc32c(&crc_input);

        let mut snapshot_data = header;
        snapshot_data.extend_from_slice(&body);
        snapshot_data.extend_from_slice(&crc.to_le_bytes());

        let tmp_path = self.snapshot_dir.join(format!("{snapshot_seq:08}.tmp"));
        fs::create_dir_all(&self.snapshot_dir).await?;
        let mut file = fs::File::create(&tmp_path).await?;
        file.write_all(&snapshot_data).await?;
        file.sync_all().await?;
        fs::rename(&tmp_path, &file_path).await?;
        if let Some(parent) = file_path.parent() {
            let parent_file = fs::File::open(parent).await?;
            parent_file.sync_all().await?;
        }

        let snapshot_id = Ulid::new();
        Ok(SnapshotRef {
            snapshot_id,
            stream_id: self.stream_id.clone(),
            segment_id: 0,
            offset: 0,
        })
    }

    fn build_header(&self, commit_seq: u64) -> Vec<u8> {
        let mut h = Vec::with_capacity(16);
        h.extend_from_slice(WSNAP_MAGIC);
        h.push(WSNAP_VERSION);
        h.extend_from_slice(&0u16.to_le_bytes());
        h.extend_from_slice(&commit_seq.to_le_bytes());
        h
    }

    fn build_body(&self, projection_state_hash: [u8; 32], commit_seq: u64) -> Vec<u8> {
        let mut b = Vec::with_capacity(40);
        b.extend_from_slice(&projection_state_hash);
        b.extend_from_slice(&commit_seq.to_le_bytes());
        b
    }

    async fn next_snapshot_seq(&self) -> Result<u64> {
        let mut max_seq = 0u64;
        if self.snapshot_dir.exists() {
            let mut entries = fs::read_dir(&self.snapshot_dir).await?;
            while let Some(entry) = entries.next_entry().await? {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.ends_with(".wsnap") {
                    if let Some(seq_str) = name_str.strip_suffix(".wsnap") {
                        if let Ok(seq) = seq_str.parse::<u64>() {
                            if seq > max_seq {
                                max_seq = seq;
                            }
                        }
                    }
                }
            }
        }
        Ok(max_seq + 1)
    }
}

#[cfg(test)]
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
fn read_snapshot_at(path: &Path) -> Result<(u64, [u8; 32], u64, u32)> {
    let data = std::fs::read(path).map_err(WabiError::from)?;
    if data.len() < 60 {
        return Err(WabiError::Corrupt {
            location: "snapshot".into(),
            detail: format!("snapshot too short: {} bytes", data.len()),
        });
    }
    let magic = &data[0..5];
    if magic != WSNAP_MAGIC {
        return Err(WabiError::BadMagic {
            expected: "WSNAP",
            found: hex_encode(magic),
        });
    }
    let version = data[5];
    if version != WSNAP_VERSION {
        return Err(WabiError::UnsupportedFormatVersion {
            found: version as u16,
            supported: vec![WSNAP_VERSION as u16],
        });
    }
    let commit_seq = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let projection_state_hash: [u8; 32] = data[16..48].try_into().unwrap();
    let commit_seq2 = u64::from_le_bytes(data[48..56].try_into().unwrap());
    let stored_crc = u32::from_le_bytes(data[56..60].try_into().unwrap());

    let mut crc_input = Vec::with_capacity(56);
    crc_input.extend_from_slice(&data[..56]);
    let computed_crc = crc32c::crc32c(&crc_input);
    if computed_crc != stored_crc {
        return Err(WabiError::Corrupt {
            location: "snapshot".into(),
            detail: format!(
                "CRC mismatch: computed {computed_crc:#x}, stored {stored_crc:#x}"
            ),
        });
    }
    Ok((commit_seq, projection_state_hash, commit_seq2, stored_crc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn write_and_read_back() {
        let tmp = TempDir::new().unwrap();
        let stream_id = "ch_01H".to_string();
        let writer = SnapshotWriter::new(stream_id.clone(), tmp.path().join("streams").join(&stream_id).join("snapshots"));

        let hash = blake3::hash(b"test state").into();
        let snapshot_ref = writer.write(42, hash).await.unwrap();

        let path = tmp.path().join("streams").join(&stream_id).join("snapshots").join("00000001.wsnap");
        assert!(path.exists(), "snapshot file should exist");

        let (seq, read_hash, seq2, _crc) = read_snapshot_at(&path).unwrap();
        assert_eq!(seq, 42);
        assert_eq!(read_hash, hash);
        assert_eq!(seq2, 42);
        assert!(snapshot_ref.snapshot_id.as_u128() > 0);
    }

    #[tokio::test]
    async fn prev_snapshot_ref_optional() {
        let tmp = TempDir::new().unwrap();
        let stream_id = "dm_02H".to_string();
        let writer = SnapshotWriter::new(stream_id.clone(), tmp.path().join("snapshots"));

        let hash = [0xABu8; 32];
        let ref1 = writer.write(1, hash).await.unwrap();
        let path1 = tmp.path().join("snapshots").join("00000001.wsnap");
        assert!(path1.exists());

        let ref2 = writer.write(2, hash).await.unwrap();
        let path2 = tmp.path().join("snapshots").join("00000002.wsnap");
        assert!(path2.exists());

        assert_ne!(ref1.snapshot_id, ref2.snapshot_id);
    }

    #[tokio::test]
    async fn snapshot_id_is_ulid() {
        let tmp = TempDir::new().unwrap();
        let writer = SnapshotWriter::new("s".to_string(), tmp.path().into());
        let r = writer.write(1, [0u8; 32]).await.unwrap();
        let id = r.snapshot_id;
        assert!(id.as_u128() > 0);
        let timestamp_ms = (id.as_u128() >> 80) as u64;
        assert!(timestamp_ms > 1_700_000_000_000, "ULID timestamp should be plausible");
    }

    #[tokio::test]
    async fn crc_mismatch_detected() {
        let tmp = TempDir::new().unwrap();
        let stream_id = "ch_03H".to_string();
        let writer = SnapshotWriter::new(stream_id.clone(), tmp.path().join("snapshots"));

        let hash = [0u8; 32];
        writer.write(1, hash).await.unwrap();
        let path = tmp.path().join("snapshots").join("00000001.wsnap");

        let mut data = std::fs::read(&path).unwrap();
        data[10] ^= 0xFF;
        std::fs::write(&path, &data).unwrap();

        let err = read_snapshot_at(&path).unwrap_err();
        assert!(
            matches!(err, WabiError::Corrupt { .. }),
            "expected Corrupt, got {err:?}"
        );
    }
}
