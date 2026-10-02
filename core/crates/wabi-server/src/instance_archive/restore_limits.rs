//! Cooperative extraction ceilings, checked before allocation and file writes.
use super::*;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct RestoreLimits {
    pub max_entries: u64,
    pub max_plaintext_bytes: u64,
    pub max_path_bytes: u64,
    pub timeout: Duration,
}
impl Default for RestoreLimits {
    fn default() -> Self {
        Self {
            max_entries: 100_000,
            max_plaintext_bytes: 4 * 1024 * 1024 * 1024,
            max_path_bytes: 16 * 1024 * 1024,
            timeout: Duration::from_secs(300),
        }
    }
}
pub(super) struct RestoreBudget {
    limits: RestoreLimits,
    deadline: Instant,
    file_bytes: u64,
    path_bytes: u64,
}
impl RestoreBudget {
    pub(super) fn new(limits: RestoreLimits) -> Result<Self> {
        if limits.max_entries == 0
            || limits.max_entries > MAX_ENTRIES
            || limits.max_plaintext_bytes == 0
            || limits.max_path_bytes == 0
            || limits.timeout.is_zero()
        {
            bail!("invalid restore resource limits");
        }
        let deadline = Instant::now()
            .checked_add(limits.timeout)
            .context("restore timeout out of range")?;
        Ok(Self {
            limits,
            deadline,
            file_bytes: 0,
            path_bytes: 0,
        })
    }
    pub(super) fn max_entries(&self) -> u64 {
        self.limits.max_entries
    }
    pub(super) fn check(&self) -> Result<()> {
        if Instant::now() >= self.deadline {
            bail!("restore deadline elapsed");
        }
        Ok(())
    }
    pub(super) fn path(&mut self, name: &str) -> Result<()> {
        self.check()?;
        self.path_bytes = self
            .path_bytes
            .checked_add(name.len() as u64)
            .context("restore path size overflow")?;
        if self.path_bytes > self.limits.max_path_bytes {
            bail!("restore path byte budget exceeded");
        }
        Ok(())
    }
    pub(super) fn file(&mut self, size: u64) -> Result<()> {
        self.check()?;
        self.file_bytes = self
            .file_bytes
            .checked_add(size)
            .context("restore file size overflow")?;
        if self.file_bytes > self.limits.max_plaintext_bytes {
            bail!("restore plaintext byte budget exceeded");
        }
        Ok(())
    }
    pub(super) fn reader<R: Read>(&self, reader: R) -> DeadlineReader<R> {
        DeadlineReader {
            reader,
            deadline: self.deadline,
        }
    }
    pub(super) fn hash(&self, input: &Path) -> Result<[u8; 32]> {
        let mut source = self.reader(File::open(input)?);
        let mut hash = Sha256::new();
        let mut bytes = [0u8; 64 * 1024];
        loop {
            let count = source.read(&mut bytes)?;
            if count == 0 {
                break;
            }
            hash.update(&bytes[..count]);
        }
        Ok(hash.finalize().into())
    }
    pub(super) fn validate_input(
        &self,
        input: &Path,
        identity: &Path,
        expected: Option<&str>,
    ) -> Result<()> {
        self.check()?;
        let metadata = fs::symlink_metadata(input)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            bail!("restore input must be a regular file");
        }
        // Allow age framing, per-entry hashes/lengths, paths and the V2 header.
        let ceiling = self
            .limits
            .max_plaintext_bytes
            .checked_add(self.limits.max_plaintext_bytes / 50)
            .and_then(|n| n.checked_add(self.limits.max_path_bytes))
            .and_then(|n| {
                self.limits
                    .max_entries
                    .checked_mul(64)
                    .and_then(|extra| n.checked_add(extra))
            })
            .and_then(|n| n.checked_add(2 * 1024 * 1024))
            .context("restore ciphertext limit overflow")?;
        if metadata.len() > ceiling {
            bail!("restore ciphertext byte budget exceeded");
        }
        let key = fs::symlink_metadata(identity)?;
        if !key.is_file() || key.file_type().is_symlink() || key.len() > 4096 {
            bail!("restore identity must be a bounded regular file");
        }
        if let Some(expected) = expected {
            if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
                bail!("expected archive SHA-256 must be 64 hexadecimal characters");
            }
            if hex::encode(self.hash(input)?) != expected.to_ascii_lowercase() {
                bail!("encrypted archive differs from trusted source receipt");
            }
        }
        Ok(())
    }
}
pub(super) struct DeadlineReader<R> {
    reader: R,
    deadline: Instant,
}
impl<R: Read> Read for DeadlineReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if Instant::now() >= self.deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "restore deadline elapsed",
            ));
        }
        self.reader.read(bytes)
    }
}

pub(super) struct RestoreDirectory {
    stage: PathBuf,
    target: PathBuf,
    pub(super) published: bool,
    pub(super) complete: bool,
}
impl RestoreDirectory {
    pub(super) fn new(stage: PathBuf, target: PathBuf) -> Self {
        Self {
            stage,
            target,
            published: false,
            complete: false,
        }
    }
}
impl Drop for RestoreDirectory {
    fn drop(&mut self) {
        if !self.complete {
            let _ = fs::remove_dir_all(&self.stage);
            if self.published {
                let _ = fs::remove_dir_all(&self.target);
                let _ = sync_parent(&self.target);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn budget_refuses_overflow_and_checks_deadline_on_each_read() {
        let mut budget = RestoreBudget::new(RestoreLimits {
            max_plaintext_bytes: u64::MAX,
            ..RestoreLimits::default()
        })
        .unwrap();
        budget.file(u64::MAX).unwrap();
        assert!(budget.file(1).is_err());
        let mut reader = DeadlineReader {
            reader: &b"bytes"[..],
            deadline: Instant::now(),
        };
        assert_eq!(
            reader.read(&mut [0]).unwrap_err().kind(),
            std::io::ErrorKind::TimedOut
        );
    }
    #[test]
    fn interrupted_extraction_removes_only_owned_directories() {
        let temp = tempfile::tempdir().unwrap();
        let stage = temp.path().join("stage");
        let target = temp.path().join("target");
        fs::create_dir(&stage).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(target.join("keep"), "keep").unwrap();
        let result = std::panic::catch_unwind(|| {
            let _guard = RestoreDirectory::new(stage.clone(), target.clone());
            panic!("fixture unwind");
        });
        assert!(result.is_err());
        assert!(!stage.exists());
        assert!(target.join("keep").exists());
    }
}
