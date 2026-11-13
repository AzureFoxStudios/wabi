//! What `wabi-server` tells the person at its terminal
//! (docs/testing/INSTALL_FROM_NOTHING.md, product friction item 4).
//!
//! Real binary, cleared environment, empty directory, the way
//! `install_from_nothing_contract.rs` starts it, but without
//! `--print-bound-address`: that flag marks a supervisor that reads stdout as
//! JSON records, and the human block is deliberately left out for it. The
//! test finds the port from the block itself.
//!
//! - ready: the block names the browser address, the absolute data
//!   directory and the log file; "No owner yet" appears on an empty directory
//!   and not once an owner exists; no secret is printed;
//! - a second server on the same data directory exits non-zero and says why on
//!   stderr, naming the lock without suggesting it be deleted
//!   (AGENTS.md golden rule 9);
//! - an occupied port exits non-zero and says why on stderr;
//! - page routes are an honest 503 when the web app was not built (and a real
//!   page when it was), while API, health, uploads and Socket.IO answer as
//!   before.

#![cfg(unix)]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use reqwest::{Client, StatusCode};
use serde_json::{json, Value};

const DATA_DIR: &str = "data/wabi-server";

struct Server {
    child: Child,
    lines: Receiver<String>,
    stderr: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

fn spawn(install: &Path, port: u16, name: &str) -> Server {
    let stderr = install.join(format!("{name}.stderr.log"));
    let mut child = Command::new(env!("CARGO_BIN_EXE_wabi-server"))
        .env_clear()
        .current_dir(install)
        .args(["--data-dir", &format!("./{DATA_DIR}")])
        .args(["--host", "127.0.0.1", "--port", &port.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(std::fs::File::create(&stderr).unwrap()))
        .spawn()
        .expect("start wabi-server");
    let stdout = child.stdout.take().unwrap();
    let (sender, lines) = std::sync::mpsc::channel();
    // Drain stdout for the life of the process so it never blocks.
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    Server {
        child,
        lines,
        stderr,
    }
}

impl Server {
    fn stderr(&self) -> String {
        std::fs::read_to_string(&self.stderr).unwrap_or_default()
    }

    /// Read stdout until the ready block's address line, then the rest of
    /// the block (printed in one write). Returns the origin and the block.
    fn ready_block(&mut self) -> (String, String) {
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut block = Vec::new();
        let origin = loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                panic!("wabi-server exited before ready ({status}): {}", self.stderr());
            }
            assert!(Instant::now() < deadline, "no ready block: {block:?}");
            match self.lines.recv_timeout(Duration::from_millis(200)) {
                Ok(line) => {
                    let origin = line
                        .strip_prefix("  Open in a browser:")
                        .map(|rest| rest.trim().to_string());
                    block.push(line);
                    if let Some(origin) = origin {
                        break origin;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    panic!("stdout closed before ready: {block:?} {}", self.stderr())
                }
            }
        };
        while let Ok(line) = self.lines.recv_timeout(Duration::from_millis(500)) {
            block.push(line);
        }
        (origin, block.join("\n") + "\n")
    }

    /// Ctrl+C, then wait for a clean exit.
    fn stop(mut self) {
        unsafe { libc::kill(self.child.id() as libc::pid_t, libc::SIGINT) };
        let status = wait_exit(&mut self.child, Duration::from_secs(60));
        assert!(status.success(), "wabi-server did not stop cleanly: {status}");
    }
}

fn wait_exit(child: &mut Child, limit: Duration) -> std::process::ExitStatus {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(Instant::now() < deadline, "process did not exit");
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// A server that must refuse to start: wait for its exit, return stdout and
/// stderr.
fn refused(install: &Path, port: u16, name: &str) -> (std::process::ExitStatus, String, String) {
    let mut server = spawn(install, port, name);
    let status = wait_exit(&mut server.child, Duration::from_secs(60));
    let stdout: Vec<String> = server.lines.try_iter().collect();
    (status, stdout.join("\n"), server.stderr())
}

/// Matches how a debug build's `rust_embed` finds the web app at run time.
fn web_app_built() -> bool {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/build/index.html")
        .exists()
}

async fn get(origin: &str, path: &str) -> (StatusCode, String) {
    let response = Client::new()
        .get(format!("{origin}{path}"))
        .send()
        .await
        .unwrap_or_else(|e| panic!("GET {path}: {e}"));
    let status = response.status();
    (status, response.text().await.unwrap())
}

fn block_value<'a>(block: &'a str, label: &str) -> &'a str {
    block
        .lines()
        .find_map(|line| line.strip_prefix(&format!("  {label}")))
        .unwrap_or_else(|| panic!("no {label} line in:\n{block}"))
        .trim()
}

#[tokio::test]
async fn ready_block_guides_the_first_start_and_page_routes_are_honest() {
    let root = tempfile::tempdir().unwrap();
    let install = root.path().join("install");
    std::fs::create_dir(&install).unwrap();

    // First start on an empty directory.
    let mut server = spawn(&install, 0, "first");
    let (origin, block) = server.ready_block();
    assert!(block.starts_with("Wabi server is ready.\n"), "{block}");
    assert!(origin.starts_with("http://127.0.0.1:"), "{block}");
    let (status, ready) = get(&origin, "/readyz").await;
    assert_eq!(status, StatusCode::OK, "{ready}");

    let data_dir = std::fs::canonicalize(install.join(DATA_DIR)).unwrap();
    assert_eq!(
        block_value(&block, "Data directory:"),
        data_dir.display().to_string(),
        "{block}"
    );
    let log_file = PathBuf::from(block_value(&block, "Log file:"));
    assert!(log_file.is_absolute(), "{block}");
    assert_eq!(
        log_file.parent().unwrap(),
        std::fs::canonicalize(install.join("logs")).unwrap(),
        "logs stay where they were: ./logs under the start directory"
    );
    assert!(log_file.exists(), "the named log file is the one being written: {block}");
    assert!(
        block.contains("  No owner yet: the first account created becomes the owner.\n"),
        "{block}"
    );

    // No secret on the terminal.
    let jwt_secret = std::fs::read_to_string(data_dir.join("jwt_secret")).unwrap();
    let root_key = std::fs::read(data_dir.join("wabidb/root_key")).unwrap();
    for printed in [&block, &server.stderr()] {
        assert!(!printed.contains(jwt_secret.trim()));
        assert!(!printed.contains(&hex(&root_key)));
        assert!(!printed.contains(&*String::from_utf8_lossy(&root_key)));
    }

    // Page routes: an honest 503 without the web app, the app with it.
    for path in ["/", "/channels/general"] {
        let (status, body) = get(&origin, path).await;
        if web_app_built() {
            assert_eq!(status, StatusCode::OK, "{path}");
            assert!(body.to_lowercase().starts_with("<!doctype html"), "{path}");
        } else {
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{path}: {body}");
            assert!(body.contains("web app is missing"), "{path}: {body}");
            assert!(body.contains("STATIC_BUILD=1 npm run build"), "{body}");
            assert!(body.contains("docs/deployment/INSTALL.md"), "{body}");
        }
    }
    assert_eq!(
        block.contains("  Web app:            not included in this build"),
        !web_app_built(),
        "{block}"
    );

    // Everything that is not a page is unaffected.
    for path in ["/health", "/livez", "/readyz", "/api/setup/status"] {
        let (status, body) = get(&origin, path).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
    }
    let (status, body) = get(&origin, "/api/no-such-route").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["error"], "not_found");
    let (status, _) = get(&origin, "/metrics").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "metrics keep their own gate");
    let (status, _) = get(&origin, "/uploads/no-such-file.png").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, body) = get(&origin, "/socket.io/?EIO=4&transport=polling").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(body.starts_with('0'), "Engine.IO open packet: {body}");

    // The first account becomes the owner, as the block said.
    let response = Client::new()
        .post(format!("{origin}/api/auth/register"))
        .json(&json!({ "username": "first_owner", "password": "Owner-Passphrase-2026" }))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success(), "{}", response.text().await.unwrap());
    server.stop();

    // Second start: an owner exists, so no setup guidance.
    let mut server = spawn(&install, 0, "second");
    let (_, block) = server.ready_block();
    assert!(block.contains("  Data directory:"), "{block}");
    assert!(!block.contains("No owner yet"), "{block}");
    server.stop();
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[tokio::test]
async fn second_server_on_the_same_data_directory_explains_the_lock() {
    let root = tempfile::tempdir().unwrap();
    let install = root.path().join("install");
    std::fs::create_dir(&install).unwrap();
    let mut first = spawn(&install, 0, "first");
    let (origin, _) = first.ready_block();

    let (status, stdout, stderr) = refused(&install, 0, "second");
    assert!(!status.success(), "second server must not start: {stdout}");
    assert!(!stdout.contains("is ready"), "no ready block for a refused start: {stdout}");
    assert!(stderr.starts_with("wabi-server could not start.\n"), "{stderr}");
    let data_dir = std::fs::canonicalize(install.join(DATA_DIR)).unwrap();
    assert!(
        stderr.contains(&format!(
            "Another Wabi server is already using the data directory {}.",
            data_dir.display()
        )),
        "{stderr}"
    );
    assert!(stderr.contains("wabidb/.lock"), "names the lock: {stderr}");
    assert!(stderr.contains("Do not delete the .lock file"), "{stderr}");
    let lower = stderr.to_lowercase();
    for advice in ["rm ", "remove the", "delete the lock", "unlink"] {
        assert!(!lower.contains(advice), "suggests removing the lock ({advice}): {stderr}");
    }
    assert!(stderr.contains("Details: "), "keeps the technical cause: {stderr}");

    // The first server and its lock are untouched.
    assert!(data_dir.join("wabidb/.lock").exists());
    assert_eq!(get(&origin, "/readyz").await.0, StatusCode::OK);
    first.stop();
}

#[tokio::test]
async fn occupied_port_explains_itself() {
    let root = tempfile::tempdir().unwrap();
    let install = root.path().join("install");
    std::fs::create_dir(&install).unwrap();
    let occupied = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = occupied.local_addr().unwrap().port();

    let (status, stdout, stderr) = refused(&install, port, "busy");
    assert!(!status.success());
    assert!(stdout.is_empty(), "nothing on stdout for a refused start: {stdout}");
    assert!(stderr.starts_with("wabi-server could not start.\n"), "{stderr}");
    assert!(
        stderr.contains(&format!("Port {port} is already in use on 127.0.0.1.")),
        "{stderr}"
    );
    assert!(stderr.contains("--port"), "says what to do: {stderr}");
    assert!(stderr.contains("Address already in use"), "keeps the OS error: {stderr}");
    // The occupying listener survives.
    std::net::TcpStream::connect(occupied.local_addr().unwrap()).unwrap();
}
