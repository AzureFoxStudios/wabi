//! Content etags — byte-for-byte parity with `wabi_lore::etag_for_bytes` /
//! `wabi_lore::file_etag` on the server. Changing either side is a
//! wire-protocol break: clients and server use etags for If-Match conflict
//! checks and manifest diffing.

use sha2::{Digest, Sha256};

/// Files up to this size get a full-content SHA-256 etag; larger files get a
/// sampled etag (size + mtime + first/last 32 KiB) prefixed `q-`.
pub const ETAG_FULL_HASH_MAX_BYTES: u64 = 4 * 1024 * 1024;
const ETAG_SAMPLE_BYTES: u64 = 32 * 1024;

pub fn etag_for_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn etag_for_file(path: &std::path::Path) -> anyhow::Result<String> {
    let meta = std::fs::metadata(path)?;
    if meta.len() <= ETAG_FULL_HASH_MAX_BYTES {
        let bytes = std::fs::read(path)?;
        return Ok(etag_for_bytes(&bytes));
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    let mut head = vec![0u8; ETAG_SAMPLE_BYTES as usize];
    let head_len = file.read(&mut head)?;
    head.truncate(head_len);
    file.seek(SeekFrom::End(-(ETAG_SAMPLE_BYTES.min(meta.len()) as i64)))?;
    let mut tail = vec![0u8; ETAG_SAMPLE_BYTES as usize];
    let tail_len = file.read(&mut tail)?;
    tail.truncate(tail_len);
    let mut hasher = Sha256::new();
    hasher.update(meta.len().to_le_bytes());
    hasher.update(mtime.to_le_bytes());
    hasher.update(&head);
    hasher.update(&tail);
    Ok(format!("q-{}", hex::encode(hasher.finalize())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_hash_matches_known_vector() {
        // sha256("hello world")
        assert_eq!(
            etag_for_bytes(b"hello world"),
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn small_file_matches_bytes_hash() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f");
        std::fs::write(&p, b"payload").unwrap();
        assert_eq!(etag_for_file(&p).unwrap(), etag_for_bytes(b"payload"));
    }
}
