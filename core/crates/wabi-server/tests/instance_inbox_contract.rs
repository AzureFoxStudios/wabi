//! Complete encrypted stopped-instance archive through a separate inbox process.

use std::{
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, Command, Stdio},
};

struct InboxProcess(Child);

impl Drop for InboxProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn command_ok(program: &str, args: &[&str]) -> String {
    let output = Command::new(program)
        .args(args)
        .output()
        .expect("run command");
    assert!(
        output.status.success(),
        "{} failed: {}",
        program,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("UTF-8 command output")
}

fn as_str(path: &Path) -> &str {
    path.to_str().expect("fixture path is UTF-8")
}

#[test]
fn encrypted_whole_instance_crosses_inbox_and_restores() {
    let snapshot = env!("CARGO_BIN_EXE_wabi-instance-snapshot");
    let inbox = env!("CARGO_BIN_EXE_wabi-instance-inbox");
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("source-data");
    let uploads = temp.path().join("source-uploads");
    let storage = temp.path().join("remote-inbox");
    std::fs::create_dir_all(data.join("wabidb")).unwrap();
    std::fs::create_dir_all(&uploads).unwrap();
    std::fs::create_dir_all(&storage).unwrap();
    std::fs::write(data.join("jwt_secret"), b"fixture-jwt").unwrap();
    std::fs::write(data.join("wabidb/root_key"), [42u8; 32]).unwrap();
    std::fs::write(data.join("wabidb/storage-manifest.json"), b"{}").unwrap();
    std::fs::write(data.join("community_roster.json"), b"fixture-sidecar").unwrap();
    let uploaded = vec![73u8; 256 * 1024];
    std::fs::write(uploads.join("attachment.bin"), &uploaded).unwrap();

    let identity = temp.path().join("recovery.agekey");
    let keygen = command_ok(snapshot, &["keygen", "--identity-file", as_str(&identity)]);
    let recipient = keygen
        .lines()
        .find_map(|line| line.strip_prefix("Recipient: "))
        .unwrap();
    let original = temp.path().join("original.age");
    command_ok(
        snapshot,
        &[
            "export",
            "--data-dir",
            as_str(&data),
            "--uploads-dir",
            as_str(&uploads),
            "--recipient",
            recipient,
            "--output",
            as_str(&original),
        ],
    );

    let token_file = temp.path().join("inbox-token");
    std::fs::write(&token_file, b"1234567890abcdef1234567890abcdef\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let mut child = InboxProcess(
        Command::new(inbox)
            .args([
                "serve",
                "--listen",
                "127.0.0.1:0",
                "--storage-dir",
                as_str(&storage),
                "--token-file",
                as_str(&token_file),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    );
    let mut line = String::new();
    BufReader::new(child.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let address = line
        .trim()
        .strip_prefix("Encrypted instance inbox listening on ")
        .expect("inbox startup address");
    let endpoint = format!("http://{address}");
    command_ok(
        inbox,
        &[
            "send",
            "--input",
            as_str(&original),
            "--endpoint",
            &endpoint,
            "--token-file",
            as_str(&token_file),
            "--id",
            "site-b-copy",
        ],
    );
    let stored = storage.join("site-b-copy.age");
    assert_eq!(
        std::fs::read(&stored).unwrap(),
        std::fs::read(&original).unwrap()
    );
    let fetched = temp.path().join("fetched.age");
    command_ok(
        inbox,
        &[
            "fetch",
            "--id",
            "site-b-copy",
            "--endpoint",
            &endpoint,
            "--token-file",
            as_str(&token_file),
            "--output",
            as_str(&fetched),
        ],
    );
    assert_eq!(
        std::fs::read(&fetched).unwrap(),
        std::fs::read(&original).unwrap()
    );
    let restored = temp.path().join("restored");
    command_ok(
        snapshot,
        &[
            "restore",
            "--input",
            as_str(&fetched),
            "--identity-file",
            as_str(&identity),
            "--target-root",
            as_str(&restored),
        ],
    );
    assert_eq!(
        std::fs::read(restored.join("data/community_roster.json")).unwrap(),
        b"fixture-sidecar"
    );
    assert_eq!(
        std::fs::read(restored.join("uploads/attachment.bin")).unwrap(),
        uploaded
    );
}
