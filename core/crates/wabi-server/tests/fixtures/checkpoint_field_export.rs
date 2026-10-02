//! Test-only export of a real, encrypted capture. No live directories, root
//! keys, decryption identity, arbitrary filenames or existing-file overwrite.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
};
use wabi_consensus::material::CheckpointManifest;

const NOFOLLOW: i32 = 0x20000;
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    schema_version: u8,
    owner: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt<'a> {
    schema_version: u8,
    purpose: &'static str,
    owner: &'a str,
    manifest_sha256: String,
    ciphertext_sha256: &'a str,
    ciphertext_bytes: u64,
    required_objects: usize,
    canonical_writer_permitted: bool,
}
pub struct Output {
    path: PathBuf,
    directory: File,
    owner: String,
}
impl Output {
    pub fn from_environment() -> Self {
        let path = PathBuf::from(std::env::var_os("WABI_CHECKPOINT_EXPORT_ROOT").unwrap());
        let owner = std::env::var("WABI_CHECKPOINT_EXPORT_OWNER").unwrap();
        Self::open(path, owner)
    }
    fn open(path: PathBuf, owner: String) -> Self {
        assert_eq!(owner.len(), 64);
        assert!(owner
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)));
        assert!(path.is_absolute());
        assert!(!path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir)));
        for parent in path.ancestors() {
            assert!(!fs::symlink_metadata(parent)
                .unwrap()
                .file_type()
                .is_symlink());
        }
        let named = fs::symlink_metadata(&path).unwrap();
        let uid = fs::metadata("/proc/self").unwrap().uid();
        assert!(named.is_dir());
        assert_eq!(named.mode() & 0o077, 0);
        assert_eq!(named.uid(), uid);
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(NOFOLLOW)
            .open(&path)
            .unwrap();
        let held = directory.metadata().unwrap();
        assert_eq!((named.dev(), named.ino()), (held.dev(), held.ino()));
        let output = Self {
            path,
            directory,
            owner,
        };
        let pinned = output.pinned();
        assert_eq!(fs::read_dir(&pinned).unwrap().count(), 1);
        let owner_path = pinned.join("owner.json");
        let meta = fs::symlink_metadata(&owner_path).unwrap();
        assert!(meta.is_file());
        assert_eq!(meta.nlink(), 1);
        assert_eq!(meta.mode() & 0o077, 0);
        assert_eq!(meta.uid(), uid);
        assert!(meta.len() <= 512);
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(NOFOLLOW)
            .open(owner_path)
            .unwrap();
        let held = file.metadata().unwrap();
        assert_eq!((meta.dev(), meta.ino()), (held.dev(), held.ino()));
        let mut bytes = Vec::new();
        file.take(513).read_to_end(&mut bytes).unwrap();
        assert!(bytes.len() <= 512);
        let record: Owner = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(record.schema_version, 1);
        assert_eq!(record.owner, output.owner);
        output.verify();
        output
    }
    fn pinned(&self) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", self.directory.as_raw_fd()))
    }
    fn verify(&self) {
        let named = fs::symlink_metadata(&self.path).unwrap();
        let held = self.directory.metadata().unwrap();
        assert!(named.is_dir() && !named.file_type().is_symlink());
        assert_eq!((named.dev(), named.ino()), (held.dev(), held.ino()));
        assert_eq!(named.uid(), fs::metadata("/proc/self").unwrap().uid());
        assert_eq!(named.mode() & 0o077, 0);
    }
    fn new_file(&self, name: &str) -> File {
        self.verify();
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(NOFOLLOW)
            .open(self.pinned().join(name))
            .unwrap()
    }
    pub fn publish(&self, archive: &Path, manifest: &CheckpointManifest) {
        let claims = &manifest.source.claims;
        assert!(claims.ciphertext_bytes <= 64 * 1024 * 1024);
        let named = fs::symlink_metadata(archive).unwrap();
        assert!(named.is_file());
        assert_eq!(named.nlink(), 1);
        assert_eq!(named.mode() & 0o077, 0);
        assert_eq!(named.uid(), fs::metadata("/proc/self").unwrap().uid());
        let mut input = OpenOptions::new()
            .read(true)
            .custom_flags(NOFOLLOW)
            .open(archive)
            .unwrap();
        let held = input.metadata().unwrap();
        assert_eq!((held.dev(), held.ino()), (named.dev(), named.ino()));
        assert_eq!(held.len(), claims.ciphertext_bytes);
        let mut output = self.new_file("ciphertext.age");
        let mut hash = Sha256::new();
        let mut total = 0u64;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let n = input.read(&mut chunk).unwrap();
            if n == 0 {
                break;
            }
            total += n as u64;
            assert!(total <= claims.ciphertext_bytes);
            hash.update(&chunk[..n]);
            output.write_all(&chunk[..n]).unwrap();
        }
        assert_eq!(total, claims.ciphertext_bytes);
        assert_eq!(hex::encode(hash.finalize()), claims.archive_sha256);
        output.sync_all().unwrap();
        let bytes = serde_json::to_vec(manifest).unwrap();
        assert!(bytes.len() <= 256 * 1024);
        let mut file = self.new_file("manifest.json");
        file.write_all(&bytes).unwrap();
        file.sync_all().unwrap();
        let receipt = Receipt {
            schema_version: 1,
            purpose: "actual_disposable_wabi_checkpoint_ciphertext",
            owner: &self.owner,
            manifest_sha256: manifest.sha256().unwrap(),
            ciphertext_sha256: &claims.archive_sha256,
            ciphertext_bytes: total,
            required_objects: manifest.objects.len(),
            canonical_writer_permitted: false,
        };
        let mut file = self.new_file("export.json");
        file.write_all(&serde_json::to_vec(&receipt).unwrap())
            .unwrap();
        file.sync_all().unwrap();
        self.directory.sync_all().unwrap();
        self.verify();
    }
    pub fn completed(&self) {
        self.verify();
        // This marker is emitted only after the entire producer contract,
        // including actual Authority reconstruction and corruption refusal.
        let bytes = fs::read(self.pinned().join("export.json")).unwrap();
        println!(
            "WABI_CHECKPOINT_EXPORT_V1 {}",
            String::from_utf8(bytes).unwrap()
        );
    }
}

#[test]
fn exclusive_ciphertext_export_refuses_bad_owner_links_and_overwrite() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let owner = "a7".repeat(32);
    let owner_path = temp.path().join("owner.json");
    fs::write(
        &owner_path,
        serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"owner":owner})).unwrap(),
    )
    .unwrap();
    fs::set_permissions(&owner_path, fs::Permissions::from_mode(0o600)).unwrap();
    let root = Output::open(temp.path().to_path_buf(), owner.clone());
    let mut file = root.new_file("ciphertext.age");
    file.write_all(b"exclusive-test-only").unwrap();
    file.sync_all().unwrap();
    assert!(std::panic::catch_unwind(|| root.new_file("ciphertext.age")).is_err());
    assert_eq!(
        fs::read(temp.path().join("ciphertext.age")).unwrap(),
        b"exclusive-test-only"
    );
    fs::remove_file(temp.path().join("ciphertext.age")).unwrap();
    assert!(
        std::panic::catch_unwind(|| Output::open(temp.path().to_path_buf(), "b1".repeat(32)))
            .is_err()
    );
    fs::set_permissions(&owner_path, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(
        std::panic::catch_unwind(|| Output::open(temp.path().to_path_buf(), owner.clone()))
            .is_err()
    );
    fs::remove_file(&owner_path).unwrap();
    std::os::unix::fs::symlink("missing", &owner_path).unwrap();
    assert!(std::panic::catch_unwind(|| Output::open(temp.path().to_path_buf(), owner)).is_err());
}
